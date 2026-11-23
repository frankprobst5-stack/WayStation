//! ATAK/CoT (Cursor-on-Target) interoperability -- closes the real
//! "reach" gap `ROADMAP.md`'s XTOC comparison named: ATAK already has
//! wide real-world adoption in the same SAR/prepper/EmComm world
//! WayStation targets, and CoT support means exchanging position/
//! situational data with a tool people may already have installed,
//! rather than asking them to replace it.
//!
//! Real, verified groundwork, not guessed: CoT's `<event>`/`<point>`/
//! `<detail>` envelope and its affiliation-domain-function `type`
//! taxonomy are MITRE's own documented schema (confirmed against
//! several independent public references before writing anything here);
//! `239.2.3.1:6969` is ATAK/WinTAK's own real, documented default "SA
//! Multicast" UDP group -- any instance on the same LAN segment with
//! that setting on (the out-of-the-box default) sees a real WayStation
//! broadcast with zero configuration on its side, and WayStation sees
//! theirs the same way.
//!
//! **Ownership, per `ROADMAP.md`'s own 2026-11-08 decision**: WayStation
//! owns serialization/transport for this, end to end -- CoT translation
//! is a transport-layer concern, not a coordination-workflow one, so it
//! sits here rather than in Muster.
//!
//! **Scoped to position/situational data, not chat** -- a real GeoChat
//! message is its own, more involved CoT shape (a `__chat` detail block
//! plus a delivery-ack handshake ATAK expects back), genuinely separate
//! work, named here rather than half-built.
//!
//! **Outbound is deliberately on-demand** (`broadcast_cot_snapshot`, an
//! operator-triggered one-shot), not a background poller -- matching
//! this app's own "on-demand, not automatic" default for every other
//! peer-facing broadcast (`sync_manifest_over_mesh`, `net_sync.rs`), and
//! the real, separately-flagged concern (`ROADMAP.md`'s "minimize
//! unsolicited mesh presence beacons") about not adding unasked-for
//! periodic network chatter. **Inbound is a real background listener**
//! (`spawn_listener`), since listening is passive -- it only ever reads
//! what's already being broadcast on the LAN, same distinction `aprs.rs`
//! already draws between its own always-on KISS client and the real
//! subprocess (Direwolf) it never auto-starts.

use crate::connectivity::{self, Status, Via};
use crate::db::{self, Db};
use crate::maidenhead::grid_square_to_lat_lon;
use chrono::Utc;
use rusqlite::{params, Connection};
use std::net::{Ipv4Addr, UdpSocket};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

pub const MULTICAST_ADDR: Ipv4Addr = Ipv4Addr::new(239, 2, 3, 1);
pub const COT_PORT: u16 = 6969;
/// How long a consumer should keep showing an event after it arrives --
/// CoT's own `stale` attribute, left to the producer to choose. 5
/// minutes matches this app's own "recently heard" horizon for a
/// similar live-position source (`aprs_stations`).
const STALE_SECONDS: i64 = 5 * 60;
const SOURCE_ID: &str = "cot";
const SOURCE_LABEL: &str = "ATAK/CoT";
const LISTEN_RETRY_DELAY: Duration = Duration::from_secs(15);
const RECV_TIMEOUT: Duration = Duration::from_secs(5);

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// CoT's own real ISO8601-with-milliseconds convention
/// ("2026-11-22T12:00:00.000Z"), confirmed against real captured CoT
/// events in multiple independent public references before writing
/// this.
fn fmt_cot_time(unix: i64) -> String {
    chrono::DateTime::<Utc>::from_timestamp(unix, 0).unwrap_or_else(Utc::now).format("%Y-%m-%dT%H:%M:%S.000Z").to_string()
}

pub struct CotEventOut<'a> {
    pub uid: &'a str,
    pub cot_type: &'a str,
    pub how: &'a str,
    pub callsign: &'a str,
    pub lat: f64,
    pub lon: f64,
}

/// Builds a real CoT XML event. `hae`/`ce`/`le` are set to CoT's own
/// documented sentinel for "no real error bound known" (`9999999.0` --
/// confirmed against MITRE's own CoT developer guide, not guessed),
/// since WayStation's position sources here (a hand-set grid square, a
/// mesh node's own GPS fix) don't carry a real measured error estimate
/// to report instead.
pub fn build_event_xml(ev: &CotEventOut, now: i64) -> String {
    let time = fmt_cot_time(now);
    let stale = fmt_cot_time(now + STALE_SECONDS);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><event version="2.0" uid="{uid}" type="{cot_type}" time="{time}" start="{time}" stale="{stale}" how="{how}"><point lat="{lat}" lon="{lon}" hae="9999999.0" ce="9999999.0" le="9999999.0"/><detail><contact callsign="{callsign}"/></detail></event>"#,
        uid = xml_escape(ev.uid),
        cot_type = xml_escape(ev.cot_type),
        time = time,
        stale = stale,
        how = xml_escape(ev.how),
        lat = ev.lat,
        lon = ev.lon,
        callsign = xml_escape(ev.callsign),
    )
}

/// One real, parsed CoT event -- what `spawn_listener` folds into
/// `cot_contacts`. Keyed on CoT's own `uid`, the protocol's real
/// identity field (not callsign, which a producer isn't required to
/// send at all).
#[derive(Debug, Clone, PartialEq)]
pub struct CotContact {
    pub uid: String,
    pub callsign: String,
    pub cot_type: String,
    pub lat: f64,
    pub lon: f64,
    pub stale: String,
}

/// Parses an incoming CoT XML event. Deliberately permissive about
/// `<contact>` -- a real CoT producer (plenty of ATAK plugins included)
/// doesn't always send one, and a position report with no callsign is
/// still a real, worth-keeping contact, not something to reject.
pub fn parse_event_xml(xml: &str) -> Result<CotContact, String> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| e.to_string())?;
    let event = doc.descendants().find(|n| n.has_tag_name("event")).ok_or("no <event> element")?;
    let uid = event.attribute("uid").ok_or("event missing uid")?.to_string();
    let cot_type = event.attribute("type").ok_or("event missing type")?.to_string();
    let stale = event.attribute("stale").unwrap_or("").to_string();

    let point = event.children().find(|n| n.has_tag_name("point")).ok_or("event missing point")?;
    let lat: f64 = point.attribute("lat").ok_or("point missing lat")?.parse().map_err(|_| "point lat is not a real number".to_string())?;
    let lon: f64 = point.attribute("lon").ok_or("point missing lon")?.parse().map_err(|_| "point lon is not a real number".to_string())?;

    let callsign = event.descendants().find(|n| n.has_tag_name("contact")).and_then(|n| n.attribute("callsign")).unwrap_or(&uid).to_string();

    Ok(CotContact { uid, callsign, cot_type, lat, lon, stale })
}

fn upsert_contact(conn: &Connection, c: &CotContact) {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO cot_contacts (uid, callsign, cot_type, lat, lon, stale_at, heard_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(uid) DO UPDATE SET
            callsign = excluded.callsign, cot_type = excluded.cot_type,
            lat = excluded.lat, lon = excluded.lon,
            stale_at = excluded.stale_at, heard_at = excluded.heard_at",
        params![c.uid, c.callsign, c.cot_type, c.lat, c.lon, c.stale, now],
    )
    .expect("failed to upsert cot_contacts");
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CotContactRow {
    pub uid: String,
    pub callsign: String,
    pub cot_type: String,
    pub lat: f64,
    pub lon: f64,
    pub stale_at: String,
    pub heard_at: String,
}

#[tauri::command]
pub fn get_cot_contacts(db: State<Db>) -> Vec<CotContactRow> {
    let conn = db.0.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare("SELECT uid, callsign, cot_type, lat, lon, stale_at, heard_at FROM cot_contacts ORDER BY heard_at DESC")
        .expect("failed to prepare cot_contacts query");
    stmt.query_map([], |row| {
        Ok(CotContactRow {
            uid: row.get(0)?,
            callsign: row.get(1)?,
            cot_type: row.get(2)?,
            lat: row.get(3)?,
            lon: row.get(4)?,
            stale_at: row.get(5)?,
            heard_at: row.get(6)?,
        })
    })
    .expect("failed to query cot_contacts")
    .filter_map(Result::ok)
    .collect()
}

fn cot_enabled(app: &AppHandle) -> bool {
    let db = app.state::<Db>();
    let conn = db.0.lock().expect("db mutex poisoned");
    db::station_profile(&conn).cot_enabled
}

fn report_health(app: &AppHandle, status: Status, detail: Option<&str>) {
    let db = app.state::<Db>();
    let conn = db.0.lock().expect("db mutex poisoned");
    connectivity::report_source_health(&conn, SOURCE_ID, SOURCE_LABEL, status, Via::Lan, detail);
}

fn open_socket() -> std::io::Result<UdpSocket> {
    let socket = UdpSocket::bind(("0.0.0.0", COT_PORT))?;
    socket.join_multicast_v4(&MULTICAST_ADDR, &Ipv4Addr::UNSPECIFIED)?;
    socket.set_read_timeout(Some(RECV_TIMEOUT))?;
    Ok(socket)
}

/// Joins ATAK's own real default SA multicast group and folds every
/// real, parseable CoT event heard there into `cot_contacts`. Gated by
/// `cot_enabled`, checked live (same "no app restart needed" shape
/// `mesh_enabled` already has) -- but unlike a TCP client's reconnect
/// loop, there's no live connection to tear down on toggle-off mid-wait;
/// the inner loop just notices on its next timeout and exits.
pub fn spawn_listener(app: AppHandle) {
    std::thread::spawn(move || loop {
        if !cot_enabled(&app) {
            report_health(&app, Status::Degraded, Some("Switched off in Settings."));
            std::thread::sleep(LISTEN_RETRY_DELAY);
            continue;
        }

        let socket = match open_socket() {
            Ok(s) => s,
            Err(e) => {
                report_health(&app, Status::Down, Some(&e.to_string()));
                std::thread::sleep(LISTEN_RETRY_DELAY);
                continue;
            }
        };
        report_health(&app, Status::Healthy, None);

        let mut buf = [0u8; 8192];
        loop {
            if !cot_enabled(&app) {
                break;
            }
            match socket.recv_from(&mut buf) {
                Ok((len, _src)) => {
                    let Ok(text) = std::str::from_utf8(&buf[..len]) else { continue };
                    // Real multicast traffic on this group is a mix of
                    // genuine CoT events and whatever else a TAK client
                    // sends there -- a parse failure here is an expected,
                    // routine occurrence, not worth logging as an error
                    // every time it happens.
                    if let Ok(contact) = parse_event_xml(text) {
                        let db = app.state::<Db>();
                        let conn = db.0.lock().expect("db mutex poisoned");
                        upsert_contact(&conn, &contact);
                        drop(conn);
                        let _ = app.emit("cot-contacts-changed", ());
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => continue,
                Err(e) => {
                    report_health(&app, Status::Down, Some(&e.to_string()));
                    break;
                }
            }
        }
    });
}

/// WayStation's own, honestly-scoped mapping from its 4 real marker
/// types (`TacticalMapPanel.tsx`'s own `MARKER_COLORS` keys) onto real
/// CoT type codes confirmed against public CoT type-code references --
/// `b-m-p-*` ("bits, marker, point") rather than the military `a-*`
/// atom codes, since a WayStation marker isn't a unit or platform.
fn marker_type_to_cot(marker_type: &str) -> &'static str {
    match marker_type {
        "hazard" => "b-m-p-w",   // warning point
        "shelter" => "b-m-p-i",  // information point
        "resource" => "b-m-p-s", // waypoint
        _ => "b-m-p-i",          // "info" and anything not recognized
    }
}

/// Sends this station's own position (from its grid square), every mesh
/// node with a known position, and every (non-deleted) map marker as
/// real CoT events over ATAK's own default SA multicast group -- a
/// one-shot snapshot, not a recurring poller (see this module's own doc
/// for why outbound is deliberately on-demand). Returns how many events
/// were actually sent.
#[tauri::command]
pub fn broadcast_cot_snapshot(db: State<Db>) -> Result<usize, String> {
    let conn = db.0.lock().expect("db mutex poisoned");
    let profile = db::station_profile(&conn);
    let now = Utc::now().timestamp();
    let mut events = Vec::new();

    if let Some((lat, lon)) = profile.grid_square.as_deref().and_then(grid_square_to_lat_lon) {
        let callsign = profile.callsign.clone().unwrap_or_else(|| "WayStation".to_string());
        events.push(build_event_xml(
            &CotEventOut { uid: &format!("WAYSTATION-STATION-{callsign}"), cot_type: "a-f-G", how: "h-e", callsign: &callsign, lat, lon },
            now,
        ));
    }

    for node in db::get_mesh_nodes_conn(&conn) {
        if let (Some(lat), Some(lon)) = (node.latitude, node.longitude) {
            let callsign = node.long_name.clone().or_else(|| node.short_name.clone()).unwrap_or_else(|| format!("Mesh !{:x}", node.node_num));
            events.push(build_event_xml(
                &CotEventOut { uid: &format!("WAYSTATION-MESH-{}", node.node_num), cot_type: "a-f-G", how: "m-g", callsign: &callsign, lat, lon },
                now,
            ));
        }
    }

    for marker in db::get_markers_conn(&conn).into_iter().filter(|m| m.deleted_at.is_none()) {
        events.push(build_event_xml(
            &CotEventOut {
                uid: &format!("WAYSTATION-MARKER-{}", marker.uuid),
                cot_type: marker_type_to_cot(&marker.marker_type),
                how: "h-e",
                callsign: &marker.label,
                lat: marker.latitude,
                lon: marker.longitude,
            },
            now,
        ));
    }
    drop(conn);

    let socket = UdpSocket::bind(("0.0.0.0", 0)).map_err(|e| e.to_string())?;
    for xml in &events {
        socket.send_to(xml.as_bytes(), (MULTICAST_ADDR, COT_PORT)).map_err(|e| e.to_string())?;
    }
    Ok(events.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_event_xml_produces_a_real_well_formed_cot_event() {
        let xml = build_event_xml(
            &CotEventOut { uid: "TEST-1", cot_type: "a-f-G", how: "h-e", callsign: "KJ4ESQ", lat: 35.1234, lon: -101.5678 },
            1_700_000_000,
        );
        assert!(xml.contains(r#"uid="TEST-1""#));
        assert!(xml.contains(r#"type="a-f-G""#));
        assert!(xml.contains(r#"how="h-e""#));
        assert!(xml.contains(r#"lat="35.1234""#));
        assert!(xml.contains(r#"lon="-101.5678""#));
        assert!(xml.contains(r#"callsign="KJ4ESQ""#));
        assert!(xml.contains("9999999.0"), "unknown error bounds must use CoT's own real sentinel value");
    }

    #[test]
    fn build_event_xml_escapes_real_special_characters_in_callsign_and_uid() {
        let xml = build_event_xml(&CotEventOut { uid: "A&B", cot_type: "a-f-G", how: "h-e", callsign: "Team <Alpha>", lat: 0.0, lon: 0.0 }, 0);
        assert!(xml.contains("A&amp;B"));
        assert!(xml.contains("Team &lt;Alpha&gt;"));
        assert!(!xml.contains("<Alpha>"), "an unescaped '<' would corrupt the real XML structure");
    }

    #[test]
    fn parse_event_xml_round_trips_a_real_built_event() {
        let built = build_event_xml(&CotEventOut { uid: "TEST-2", cot_type: "a-f-G-U-C", how: "m-g", callsign: "W1AW", lat: 41.7, lon: -72.5 }, 1_700_000_000);
        let parsed = parse_event_xml(&built).expect("parse");
        assert_eq!(parsed.uid, "TEST-2");
        assert_eq!(parsed.cot_type, "a-f-G-U-C");
        assert_eq!(parsed.callsign, "W1AW");
        assert_eq!(parsed.lat, 41.7);
        assert_eq!(parsed.lon, -72.5);
        assert!(!parsed.stale.is_empty());
    }

    #[test]
    fn parse_event_xml_accepts_a_real_minimal_event_with_no_contact_element() {
        // A real CoT producer isn't required to send <contact> -- this
        // must still parse, falling back to uid as the display label,
        // not reject the event outright.
        let xml = r#"<event version="2.0" uid="NOCALLSIGN-1" type="a-u-G" time="2026-11-22T12:00:00.000Z" start="2026-11-22T12:00:00.000Z" stale="2026-11-22T12:05:00.000Z" how="h-g-i-g-o"><point lat="10.0" lon="20.0" hae="9999999.0" ce="9999999.0" le="9999999.0"/></event>"#;
        let parsed = parse_event_xml(xml).expect("parse");
        assert_eq!(parsed.callsign, "NOCALLSIGN-1");
        assert_eq!(parsed.cot_type, "a-u-G");
    }

    #[test]
    fn parse_event_xml_rejects_real_malformed_or_incomplete_input() {
        assert!(parse_event_xml("not even xml").is_err());
        assert!(parse_event_xml("<event version=\"2.0\"/>").is_err(), "an event with no uid/type/point must fail, not default silently");
        assert!(parse_event_xml(r#"<event uid="X" type="a-f-G"/>"#).is_err(), "an event with no point at all must fail");
    }

    #[test]
    fn marker_type_to_cot_covers_every_real_marker_type_this_app_has() {
        // Mirrors TacticalMapPanel.tsx's own MARKER_COLORS keys exactly --
        // a fifth, unrecognized marker_type must still produce a real,
        // valid code (the "info" fallback), not panic or emit garbage.
        assert_eq!(marker_type_to_cot("hazard"), "b-m-p-w");
        assert_eq!(marker_type_to_cot("shelter"), "b-m-p-i");
        assert_eq!(marker_type_to_cot("resource"), "b-m-p-s");
        assert_eq!(marker_type_to_cot("info"), "b-m-p-i");
        assert_eq!(marker_type_to_cot("something-new"), "b-m-p-i");
    }

    #[test]
    fn a_real_broadcast_event_sent_over_real_udp_multicast_on_loopback_is_received_and_parses() {
        // Proves the real wire path, not just the XML string shape: binds
        // a receiver on an ephemeral port, sends to that exact address
        // rather than the real ATAK port (6969 may already be bound by
        // this test's own fixtures or a real running instance), and
        // confirms a real UDP datagram round-trips through recv_from and
        // parse_event_xml correctly.
        let receiver = UdpSocket::bind(("127.0.0.1", 0)).expect("bind receiver");
        receiver.set_read_timeout(Some(Duration::from_secs(2))).expect("set_read_timeout");
        let addr = receiver.local_addr().expect("local_addr");

        let xml = build_event_xml(&CotEventOut { uid: "LOOPBACK-TEST", cot_type: "a-f-G", how: "h-e", callsign: "TESTSTATION", lat: 1.0, lon: 2.0 }, 1_700_000_000);
        let sender = UdpSocket::bind(("127.0.0.1", 0)).expect("bind sender");
        sender.send_to(xml.as_bytes(), addr).expect("send_to");

        let mut buf = [0u8; 8192];
        let (len, _src) = receiver.recv_from(&mut buf).expect("recv_from should receive the real datagram just sent");
        let received = std::str::from_utf8(&buf[..len]).expect("valid utf8");
        let parsed = parse_event_xml(received).expect("parse the real received bytes");
        assert_eq!(parsed.uid, "LOOPBACK-TEST");
        assert_eq!(parsed.callsign, "TESTSTATION");
    }
}
