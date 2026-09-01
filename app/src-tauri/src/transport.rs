//! `Transport` trait, derived from three real, working implementations
//! (mesh, Winlink, JS8Call) rather than designed speculatively.
//!
//! Worth being explicit about the history here: this exact abstraction
//! was considered and rejected earlier (dispatch.rs, 2026-08-29) --
//! "a trait with only one real implementation behind it doesn't save
//! any code, it just adds one." That call made sense at the time. It no
//! longer does: there are three real, proven send paths now, each with
//! genuinely different semantics (delivery-confirmed / store-and-forward
//! / fire-and-forget with no confirmation at all), which is exactly the
//! condition under which a shared interface earns its keep instead of
//! just adding a layer of indirection over one concrete implementation.

use crate::db::{self, Db, MeshNode};
use crate::js8call;
use crate::mesh::{self, MeshState};
use crate::pat;
use tauri::{AppHandle, Manager};

/// Who an outbound object is for. Messages are always targeted; map
/// markers can also broadcast (situational awareness for everyone on
/// the mesh, not a private send). Winlink and JS8Call have no broadcast
/// concept -- their `send` impls simply refuse a `Broadcast` envelope
/// rather than guessing at a recipient.
pub enum Destination {
    Station(String),
    Broadcast,
}

/// What's being sent. Deliberately *not* one pre-formatted string for
/// both variants -- the two object types have opposite formatting
/// needs. An ICS-213 message is prose meant for a human, and each
/// transport already tailors its verbosity to its own bandwidth (mesh:
/// one compact line; Winlink: a full multi-line body, bandwidth isn't
/// the constraint there; JS8Call: the most compact of all, matching
/// real JS8 payload limits) -- collapsing that into one shared string
/// would be a real behavior regression, not a simplification. A
/// situational marker is the opposite: a parseable `WSPIN|...` wire
/// record another station's WayStation decodes on the far end, so it
/// has to be byte-identical no matter which transport carried it.
pub enum Payload<'a> {
    IcsMessage {
        id: i64,
        precedence: &'a str,
        subject: Option<&'a str>,
        text: &'a str,
    },
    /// Already fully formatted (`WSPIN|label|type|lat|lon|origin`) --
    /// see `dispatch::format_marker_for_wire`.
    Marker(&'a str),
}

pub struct OutboundEnvelope<'a> {
    pub destination: Destination,
    pub payload: Payload<'a>,
    /// Only mesh currently has a real concept of a delivery
    /// confirmation (Meshtastic ACKs) -- ignored by transports that
    /// don't.
    pub want_ack: bool,
}

pub trait Transport: Send + Sync {
    fn id(&self) -> &'static str;
    /// `Ok` means the transport actually accepted it for delivery (or,
    /// for mesh, that Meshtastic's firmware did) -- not that it's been
    /// confirmed received at the far end. `Err` means try the next
    /// transport; "no route available right now" is the normal case
    /// here, not something worth logging as an error.
    fn send(&self, app: &AppHandle, envelope: &OutboundEnvelope) -> Result<(), String>;
}

/// Finds exactly one mesh node whose name/ID case-insensitively matches
/// a callsign. Deliberately returns `None` on zero *or multiple*
/// matches -- moved here unchanged from the original dispatch.rs: a
/// station's callsign isn't a guaranteed-unique field on a Meshtastic
/// node (long_name/short_name/user_id are whatever the node owner
/// typed), so guessing which of two similarly-named nodes is the right
/// one is worse than an honest "couldn't find a route."
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

/// Pulled out as a standalone pure function (rather than left inline in
/// `MeshTransport::send`) specifically so it's unit-testable without a
/// live `AppHandle` -- this is the exact string `format_for_mesh` used
/// to produce in the pre-refactor dispatch.rs, verified by test below,
/// not just re-derived from memory.
fn mesh_wire_text(payload: &Payload) -> String {
    match payload {
        Payload::IcsMessage { id, precedence, subject, text } => format!(
            "ICS-213 #{id} [{}] {} :: {text}",
            precedence.to_uppercase(),
            subject.unwrap_or("(no subject)"),
        ),
        Payload::Marker(wire) => wire.to_string(),
    }
}

/// Same reasoning as `mesh_wire_text`: pulled out so the exact (subject,
/// body) pair Winlink gets can be asserted in a test against the
/// pre-refactor format, not just trusted by inspection.
fn winlink_subject_and_body<'a>(payload: &'a Payload) -> (&'a str, String) {
    match payload {
        Payload::IcsMessage { id, precedence, subject, text } => (
            subject.unwrap_or("(no subject)"),
            format!("ICS-213 #{id} [{}]\n\n{text}", precedence.to_uppercase()),
        ),
        Payload::Marker(wire) => ("WayStation situational marker", wire.to_string()),
    }
}

/// Same reasoning again -- JS8Call's the most bandwidth-constrained leg,
/// so its format is the most compact, and the one most worth pinning
/// down with a real test rather than trusting by eye.
fn js8_wire_text(payload: &Payload) -> String {
    match payload {
        Payload::IcsMessage { id, text, .. } => format!("ICS-213 #{id}: {text}"),
        Payload::Marker(wire) => wire.to_string(),
    }
}

pub struct MeshTransport;

impl Transport for MeshTransport {
    fn id(&self) -> &'static str {
        "mesh"
    }

    fn send(&self, app: &AppHandle, envelope: &OutboundEnvelope) -> Result<(), String> {
        let connected = app
            .state::<MeshState>()
            .stream
            .lock()
            .expect("mesh state mutex poisoned")
            .is_some();
        if !connected {
            return Err("mesh not connected".to_string());
        }
        let to_node = match &envelope.destination {
            Destination::Broadcast => None,
            Destination::Station(callsign) => {
                let nodes = db::get_mesh_nodes(app.state::<Db>());
                Some(
                    find_mesh_node(&nodes, callsign)
                        .ok_or_else(|| format!("no unique mesh node matching {callsign}"))?,
                )
            }
        };
        let text = mesh_wire_text(&envelope.payload);
        mesh::send_mesh_text(app.state::<MeshState>(), app.state::<Db>(), text, to_node, 0, envelope.want_ack)
    }
}

pub struct WinlinkTransport;

impl Transport for WinlinkTransport {
    fn id(&self) -> &'static str {
        "winlink"
    }

    fn send(&self, _app: &AppHandle, envelope: &OutboundEnvelope) -> Result<(), String> {
        let Destination::Station(to) = &envelope.destination else {
            return Err("winlink has no broadcast concept".to_string());
        };
        let (subject, body) = winlink_subject_and_body(&envelope.payload);
        pat::post_to_outbox(to, subject, &body)
    }
}

pub struct Js8CallTransport;

impl Transport for Js8CallTransport {
    fn id(&self) -> &'static str {
        "js8call"
    }

    fn send(&self, _app: &AppHandle, envelope: &OutboundEnvelope) -> Result<(), String> {
        let Destination::Station(to) = &envelope.destination else {
            return Err("js8call has no broadcast concept".to_string());
        };
        let text = js8_wire_text(&envelope.payload);
        js8call::send_message(to, &text)
    }
}

/// The three real transports, in priority order: mesh first (short
/// range, no dependency on a gateway being reachable), then Winlink,
/// then JS8Call last (long range, slowest of the three) -- the same
/// order dispatch.rs always tried them in.
pub fn transports() -> Vec<Box<dyn Transport>> {
    vec![Box::new(MeshTransport), Box::new(WinlinkTransport), Box::new(Js8CallTransport)]
}

#[cfg(test)]
mod tests {
    //! Real risk this protects against: the dispatch.rs rewrite that
    //! introduced this trait was supposed to be a pure control-flow
    //! refactor with zero change to what actually gets transmitted --
    //! but three different transports each format an ICS-213 message
    //! differently (mesh: one compact line; Winlink: full multi-line
    //! body with a separate subject; JS8Call: the most compact of all),
    //! and it would be very easy to accidentally collapse that during a
    //! refactor without noticing, since every path still compiles and
    //! still "sends something." These pin the exact strings the
    //! pre-refactor dispatch.rs produced, byte for byte, rather than
    //! trusting a manual before/after comparison.
    use super::*;

    fn sample_message() -> Payload<'static> {
        Payload::IcsMessage {
            id: 42,
            precedence: "priority",
            subject: Some("Generator fuel"),
            text: "Shelter 3 needs 40 gallons",
        }
    }

    fn sample_message_no_subject() -> Payload<'static> {
        Payload::IcsMessage { id: 7, precedence: "routine", subject: None, text: "status ok" }
    }

    #[test]
    fn mesh_format_matches_pre_refactor_format_for_mesh() {
        assert_eq!(
            mesh_wire_text(&sample_message()),
            "ICS-213 #42 [PRIORITY] Generator fuel :: Shelter 3 needs 40 gallons"
        );
    }

    #[test]
    fn mesh_format_falls_back_to_no_subject_placeholder() {
        assert_eq!(mesh_wire_text(&sample_message_no_subject()), "ICS-213 #7 [ROUTINE] (no subject) :: status ok");
    }

    #[test]
    fn winlink_format_matches_pre_refactor_body_and_keeps_subject_separate() {
        let payload = sample_message();
        let (subject, body) = winlink_subject_and_body(&payload);
        assert_eq!(subject, "Generator fuel");
        assert_eq!(body, "ICS-213 #42 [PRIORITY]\n\nShelter 3 needs 40 gallons");
    }

    #[test]
    fn winlink_format_falls_back_to_no_subject_placeholder() {
        let payload = sample_message_no_subject();
        let (subject, body) = winlink_subject_and_body(&payload);
        assert_eq!(subject, "(no subject)");
        assert_eq!(body, "ICS-213 #7 [ROUTINE]\n\nstatus ok");
    }

    #[test]
    fn js8_format_matches_pre_refactor_format_and_ignores_subject() {
        // JS8Call's leg never included the subject at all, even before
        // this refactor -- real bandwidth constraint, not an oversight.
        assert_eq!(js8_wire_text(&sample_message()), "ICS-213 #42: Shelter 3 needs 40 gallons");
    }

    #[test]
    fn marker_payload_passes_through_unchanged_on_every_transport() {
        let wire = "WSPIN|Shelter 3|shelter|35.220000|-100.760000|KJ4ESQ";
        let payload = Payload::Marker(wire);
        assert_eq!(mesh_wire_text(&payload), wire);
        assert_eq!(js8_wire_text(&payload), wire);
        let (subject, body) = winlink_subject_and_body(&payload);
        assert_eq!(subject, "WayStation situational marker");
        assert_eq!(body, wire);
    }

    fn node(user_id: Option<&str>, long_name: Option<&str>, short_name: Option<&str>, node_num: i64) -> MeshNode {
        MeshNode {
            node_num,
            user_id: user_id.map(String::from),
            long_name: long_name.map(String::from),
            short_name: short_name.map(String::from),
            hw_model: None,
            snr: None,
            last_heard: None,
            battery_pct: None,
            is_favorite: false,
            updated_at: String::new(),
            latitude: None,
            longitude: None,
            position_updated_at: None,
        }
    }

    #[test]
    fn find_mesh_node_matches_case_insensitively_on_any_of_three_fields() {
        let nodes = vec![node(Some("KJ4ESQ"), Some("Frank's Base"), Some("FRNK"), 1)];
        assert_eq!(find_mesh_node(&nodes, "kj4esq"), Some(1));
        assert_eq!(find_mesh_node(&nodes, "FRNK"), Some(1));
        assert_eq!(find_mesh_node(&nodes, "frank's base"), Some(1));
    }

    #[test]
    fn find_mesh_node_returns_none_on_zero_matches() {
        let nodes = vec![node(Some("KJ4ESQ"), None, None, 1)];
        assert_eq!(find_mesh_node(&nodes, "W1AW"), None);
    }

    #[test]
    fn find_mesh_node_returns_none_on_ambiguous_multiple_matches() {
        // Two nodes both claiming the same short_name -- guessing which
        // one is "right" is worse than an honest "no route."
        let nodes = vec![node(Some("KJ4ESQ"), None, Some("BASE"), 1), node(Some("KJ4XYZ"), None, Some("BASE"), 2)];
        assert_eq!(find_mesh_node(&nodes, "BASE"), None);
    }

    #[test]
    fn find_mesh_node_returns_none_on_empty_callsign() {
        let nodes = vec![node(Some("KJ4ESQ"), None, None, 1)];
        assert_eq!(find_mesh_node(&nodes, "   "), None);
    }

    // -- Live integration checks, not unit tests --------------------
    //
    // `#[ignore]`d because they need Pat and JS8Call actually running
    // and logged in (`cargo test -- --ignored` to run them). These call
    // the exact functions `WinlinkTransport`/`Js8CallTransport` wrap
    // (`pat::post_to_outbox`, `js8call::send_message`) with the exact
    // text `winlink_subject_and_body`/`js8_wire_text` would produce --
    // real confirmation that the new formatting pipeline still reaches
    // the real local APIs correctly, not just that the strings look
    // right in isolation. Neither transmits over real RF: Pat only
    // queues into the local outbox (this deliberately never calls
    // `/api/connect`), and JS8Call's TX.SEND_MESSAGE queues into its TX
    // window rather than keying the radio -- confirmed 2026-08-30 in
    // dispatch.rs's original version, true of the underlying calls
    // regardless of this refactor. Run with Frank's explicit knowledge
    // 2026-09-01 that a real, clearly-labeled test message would land
    // in his actual outbox/TX window for him to remove by hand
    // afterward -- there's no delete-from-outbox API exposed here to
    // clean it up automatically.
    #[test]
    #[ignore]
    fn winlink_transport_reaches_the_real_local_pat_api() {
        let payload = Payload::IcsMessage {
            id: 999999,
            precedence: "routine",
            subject: Some("WAYSTATION TEST -- SAFE TO DELETE"),
            text: "Automated transport-refactor verification, 2026-09-01. Not a real message -- delete from outbox.",
        };
        let (subject, body) = winlink_subject_and_body(&payload);
        pat::post_to_outbox("TEST", subject, &body).expect("post_to_outbox failed against the live local Pat API");
    }

    #[test]
    #[ignore]
    fn js8call_transport_reaches_the_real_local_js8call_api() {
        let payload = Payload::IcsMessage {
            id: 999999,
            precedence: "routine",
            subject: Some("ignored by js8"),
            text: "WAYSTATION TEST -- SAFE TO DELETE -- automated transport-refactor verification, 2026-09-01",
        };
        let text = js8_wire_text(&payload);
        js8call::send_message("TEST", &text).expect("send_message failed against the live local JS8Call API");
    }
}
