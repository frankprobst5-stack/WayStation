//! Message dispatcher — closes the real gap flagged in the hybrid-
//! architecture review (2026-08-29): ICS-213 messages only ever got
//! logged locally, never actually sent anywhere. This tries each
//! transport in priority order rather than unifying them behind a shared
//! Rust trait — Mesh, Winlink, and JS8Call have genuinely different send
//! semantics (delivery-confirmed / store-and-forward / none at all yet),
//! and forcing them into one interface was considered and rejected as
//! premature abstraction: a trait with only one real implementation
//! behind it doesn't save any code, it just adds one.
//!
//! Three legs, tried in order: Mesh (short range, no dependency on an RMS
//! gateway being reachable), Winlink via Pat's local outbox API
//! (`POST /api/mailbox/out`, verified against Pat's actual source since
//! it isn't otherwise documented — see `pat::post_to_outbox`; posting is
//! purely local, this deliberately never triggers `/api/connect`, the
//! separate and more consequential step that actually opens a session and
//! gets the message on the air), and JS8Call last — long range but the
//! slowest of the three. JS8Call's leg (`js8call::send_message`) was
//! verified live 2026-08-30 against a real running instance with no radio
//! attached, confirmed queued in JS8Call's own TX window rather than
//! transmitting. One honest caveat unique to it: TX.SEND_MESSAGE is
//! fire-and-forget with no response at all, so "dispatched via js8call"
//! only means the command was written to the socket, not that JS8Call
//! successfully processed it — genuinely weaker confirmation than the
//! other two legs, which both get a real success/failure signal back.

use crate::db::{self, Db, MapMarker, Message, MeshNode};
use crate::js8call;
use crate::mesh::{self, MeshState};
use crate::pat;
use tauri::{AppHandle, Manager};

/// Finds exactly one mesh node whose name/ID case-insensitively matches
/// a callsign. Deliberately returns None on zero *or multiple* matches —
/// a station's callsign isn't a guaranteed-unique field on a Meshtastic
/// node (long_name/short_name/user_id are whatever the node owner typed),
/// so guessing which of two similarly-named nodes is the right one is
/// worse than an honest "couldn't find a route."
fn find_mesh_node(nodes: &[MeshNode], callsign: &str) -> Option<i64> {
    let needle = callsign.trim().to_uppercase();
    if needle.is_empty() {
        return None;
    }
    let matches: Vec<i64> = nodes
        .iter()
        .filter(|n| {
            [&n.user_id, &n.long_name, &n.short_name]
                .iter()
                .any(|f| f.as_deref().map(|s| s.trim().to_uppercase() == needle).unwrap_or(false))
        })
        .map(|n| n.node_num)
        .collect();
    match matches.as_slice() {
        [only] => Some(*only),
        _ => None,
    }
}

fn format_for_mesh(m: &Message) -> String {
    format!(
        "ICS-213 #{} [{}] {} :: {}",
        m.id,
        m.precedence.to_uppercase(),
        m.subject.as_deref().unwrap_or("(no subject)"),
        m.message_text,
    )
}

/// Tries to actually send a message, in priority order. Returns which
/// transport it went out on, or None if nothing could reach it right
/// now — callers leave the message queued rather than treating that as
/// an error, since "no route yet" is the normal state until a transport
/// comes up, not a failure.
fn try_dispatch(app: &AppHandle, m: &Message) -> Option<String> {
    let to = m.to_station.as_deref()?;
    if to.trim().is_empty() {
        return None;
    }

    // -- Mesh first: short range, no dependency on a gateway being up. --
    let mesh_state = app.state::<MeshState>();
    let connected = mesh_state.stream.lock().expect("mesh state mutex poisoned").is_some();
    if connected {
        let nodes = db::get_mesh_nodes(app.state::<Db>());
        if let Some(node_num) = find_mesh_node(&nodes, to) {
            let text = format_for_mesh(m);
            if mesh::send_mesh_text(app.state::<MeshState>(), app.state::<Db>(), text, Some(node_num), 0, true).is_ok() {
                return Some("mesh".to_string());
            }
        }
    }

    // -- Winlink: queues into Pat's local outbox. A Winlink address is
    // just the recipient's callsign, so `to` needs no transformation. --
    let subject = m.subject.as_deref().unwrap_or("(no subject)");
    let body = format!("ICS-213 #{} [{}]\n\n{}", m.id, m.precedence.to_uppercase(), m.message_text);
    if pat::post_to_outbox(to, subject, &body).is_ok() {
        return Some("winlink".to_string());
    }

    // -- JS8Call last: long range, slowest of the three. --
    let js8_text = format!("ICS-213 #{}: {}", m.id, m.message_text);
    if js8call::send_message(to, &js8_text).is_ok() {
        return Some("js8call".to_string());
    }

    None
}

#[tauri::command]
pub fn dispatch_message(app: AppHandle, message_id: i64) -> Result<Message, String> {
    let existing = {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        db::get_message(&conn, message_id).ok_or("message not found")?
    };

    if let Some(via) = try_dispatch(&app, &existing) {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        db::mark_message_dispatched(&conn, message_id, &via);
        Ok(db::get_message(&conn, message_id).unwrap_or(existing))
    } else {
        Ok(existing)
    }
}

/// Called whenever a transport comes back up (today: mesh reconnects) —
/// sweeps every still-queued message and retries. Cheap the vast
/// majority of the time, since that list is normally empty.
pub fn redispatch_queued(app: &AppHandle) {
    let queued = {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        db::queued_messages(&conn)
    };
    for m in queued {
        if let Some(via) = try_dispatch(app, &m) {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            db::mark_message_dispatched(&conn, m.id, &via);
        }
    }
}

/// A situational marker on the wire: `WSPIN|<label>|<type>|<lat>|<lon>|<origin>`.
/// Deliberately plain delimited text, not a new binary protocol — it has
/// to survive as-is through Winlink/JS8Call's plain-text bodies and
/// mesh's TextMessageApp payload exactly like a chat message would.
/// `|` in the label is sanitized on the way out since it's the delimiter.
const MARKER_PREFIX: &str = "WSPIN|";

fn format_marker_for_wire(m: &MapMarker) -> String {
    let label = m.label.replace('|', "/");
    format!(
        "{MARKER_PREFIX}{}|{}|{:.6}|{:.6}|{}",
        label,
        m.marker_type,
        m.latitude,
        m.longitude,
        m.origin_station.as_deref().unwrap_or("")
    )
}

pub struct ParsedMarker {
    pub label: String,
    pub marker_type: String,
    pub latitude: f64,
    pub longitude: f64,
    pub origin: Option<String>,
}

/// The receive-side counterpart of `format_marker_for_wire`. Returns None
/// for anything that isn't a well-formed pin — ordinary chat text is the
/// overwhelmingly common case on this same payload type, so a malformed
/// or foreign `WSPIN|` line is treated as "not a marker" rather than an
/// error worth surfacing.
pub fn parse_marker_wire(text: &str) -> Option<ParsedMarker> {
    let rest = text.strip_prefix(MARKER_PREFIX)?;
    let parts: Vec<&str> = rest.split('|').collect();
    let [label, marker_type, lat, lon, origin] = parts.as_slice() else {
        return None;
    };
    Some(ParsedMarker {
        label: label.to_string(),
        marker_type: marker_type.to_string(),
        latitude: lat.parse().ok()?,
        longitude: lon.parse().ok()?,
        origin: if origin.is_empty() { None } else { Some(origin.to_string()) },
    })
}

/// Mirrors `try_dispatch`, but markers have a real broadcast case
/// messages don't: a pin with no specific `to_station` is meant for
/// everyone on the mesh (situational awareness, not a private message),
/// so it goes out as a mesh broadcast rather than being skipped. Winlink
/// and JS8Call have no broadcast concept, so those two legs only fire
/// when a specific recipient was requested.
fn try_dispatch_marker(app: &AppHandle, m: &MapMarker) -> Option<String> {
    let text = format_marker_for_wire(m);

    let mesh_state = app.state::<MeshState>();
    let connected = mesh_state.stream.lock().expect("mesh state mutex poisoned").is_some();
    if connected {
        // Some(None) = broadcast to everyone; Some(Some(id)) = DM a
        // matched node; None = a specific recipient was requested but no
        // single matching node was found, so mesh is skipped entirely
        // rather than broadcasting something that was meant to be private.
        let mesh_target: Option<Option<i64>> = match m.to_station.as_deref() {
            None => Some(None),
            Some(to) => {
                let nodes = db::get_mesh_nodes(app.state::<Db>());
                find_mesh_node(&nodes, to).map(Some)
            }
        };
        if let Some(node_target) = mesh_target {
            if mesh::send_mesh_text(app.state::<MeshState>(), app.state::<Db>(), text.clone(), node_target, 0, m.to_station.is_some()).is_ok() {
                return Some("mesh".to_string());
            }
        }
    }

    if let Some(to) = m.to_station.as_deref() {
        if pat::post_to_outbox(to, "WayStation situational marker", &text).is_ok() {
            return Some("winlink".to_string());
        }
        if js8call::send_message(to, &text).is_ok() {
            return Some("js8call".to_string());
        }
    }

    None
}

#[tauri::command]
pub fn dispatch_marker(app: AppHandle, marker_id: i64) -> Result<MapMarker, String> {
    let existing = {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        db::get_marker(&conn, marker_id).ok_or("marker not found")?
    };

    if let Some(via) = try_dispatch_marker(&app, &existing) {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        db::mark_marker_dispatched(&conn, marker_id, &via);
        Ok(db::get_marker(&conn, marker_id).unwrap_or(existing))
    } else {
        Ok(existing)
    }
}

/// Called alongside `redispatch_queued` whenever a transport comes back
/// up — sweeps every still-queued marker and retries.
pub fn redispatch_queued_markers(app: &AppHandle) {
    let queued = {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        db::queued_markers(&conn)
    };
    for m in queued {
        if let Some(via) = try_dispatch_marker(app, &m) {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            db::mark_marker_dispatched(&conn, m.id, &via);
        }
    }
}
