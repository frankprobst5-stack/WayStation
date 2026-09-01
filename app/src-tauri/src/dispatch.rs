//! Message dispatcher — closes the real gap flagged in the hybrid-
//! architecture review (2026-08-29): ICS-213 messages only ever got
//! logged locally, never actually sent anywhere. Tries each transport
//! in priority order via the `transport::Transport` trait (see that
//! module for why the trait itself was deferred, then built, rather
//! than designed up front).
//!
//! Three legs, tried in order: Mesh (short range, no dependency on an
//! RMS gateway being reachable), Winlink via Pat's local outbox API
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

use crate::db::{Db, MapMarker, Message};
use crate::transport::{self, Destination, OutboundEnvelope, Payload};
use tauri::{AppHandle, Manager};

/// Tries every transport in priority order, recording a `delivery_attempts`
/// row for each one tried -- success or failure, not just the winner.
/// That's the actual point of v31: `dispatch_status`/`dispatched_via` on
/// the object itself only ever showed the latest outcome; an operator
/// asking "what happened to this message" deserves the real sequence
/// (mesh tried and failed, then Winlink succeeded), not just the last
/// line of it. Shared between messages and markers rather than
/// duplicated, same reasoning as collapsing the two dispatch loops
/// earlier today. Returns which transport it went out on, or None if
/// nothing could reach it right now -- callers leave the object queued
/// rather than treating that as an error, since "no route yet" is the
/// normal state until a transport comes up, not a failure.
fn dispatch_with_logging(app: &AppHandle, object_type: &str, object_uuid: &str, envelope: &OutboundEnvelope) -> Option<String> {
    for t in transport::transports() {
        let result = t.send(app, envelope);
        {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            let outcome: Result<(), &str> = match &result {
                Ok(()) => Ok(()),
                Err(e) => Err(e.as_str()),
            };
            crate::db::record_delivery_attempt(&conn, object_type, object_uuid, t.id(), outcome);
        }
        if result.is_ok() {
            return Some(t.id().to_string());
        }
    }
    None
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
    let envelope = OutboundEnvelope {
        destination: Destination::Station(to.to_string()),
        payload: Payload::IcsMessage {
            id: m.id,
            precedence: &m.precedence,
            subject: m.subject.as_deref(),
            text: &m.message_text,
        },
        want_ack: true,
    };
    dispatch_with_logging(app, "message", &m.uuid, &envelope)
}

#[tauri::command]
pub fn dispatch_message(app: AppHandle, message_id: i64) -> Result<Message, String> {
    let existing = {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        crate::db::get_message(&conn, message_id).ok_or("message not found")?
    };

    if let Some(via) = try_dispatch(&app, &existing) {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        crate::db::mark_message_dispatched(&conn, message_id, &via);
        Ok(crate::db::get_message(&conn, message_id).unwrap_or(existing))
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
        crate::db::queued_messages(&conn)
    };
    for m in queued {
        if let Some(via) = try_dispatch(app, &m) {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            crate::db::mark_message_dispatched(&conn, m.id, &via);
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
/// everyone on the mesh (situational awareness, not a private message).
/// `WinlinkTransport`/`Js8CallTransport` both refuse a `Broadcast`
/// envelope (see `transport.rs`), so those two legs simply don't fire
/// for an unaddressed marker — same outcome as before, now enforced
/// inside the transport instead of by an `if` here.
fn try_dispatch_marker(app: &AppHandle, m: &MapMarker) -> Option<String> {
    let wire = format_marker_for_wire(m);
    let destination = match m.to_station.as_deref() {
        None => Destination::Broadcast,
        Some(to) => Destination::Station(to.to_string()),
    };
    let envelope = OutboundEnvelope {
        destination,
        payload: Payload::Marker(&wire),
        want_ack: m.to_station.is_some(),
    };
    dispatch_with_logging(app, "marker", &m.uuid, &envelope)
}

#[tauri::command]
pub fn dispatch_marker(app: AppHandle, marker_id: i64) -> Result<MapMarker, String> {
    let existing = {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        crate::db::get_marker(&conn, marker_id).ok_or("marker not found")?
    };

    if let Some(via) = try_dispatch_marker(&app, &existing) {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        crate::db::mark_marker_dispatched(&conn, marker_id, &via);
        Ok(crate::db::get_marker(&conn, marker_id).unwrap_or(existing))
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
        crate::db::queued_markers(&conn)
    };
    for m in queued {
        if let Some(via) = try_dispatch_marker(app, &m) {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            crate::db::mark_marker_dispatched(&conn, m.id, &via);
        }
    }
}
