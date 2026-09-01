//! Meshtastic mesh integration (Phase 2) — first version: node database
//! and channel/broadcast text chat, receive and send.
//!
//! Protocol verified live against a real running `meshtasticd` (the
//! official native/Portduino Meshtastic build, simulated radio mode) over
//! its TCP API on port 4403 before writing anything here — connected with
//! the official Python client first to see real MyNodeInfo/NodeInfo data,
//! then checked the exact wire framing against Meshtastic's own primary
//! documentation (meshtastic.org/docs/development/device/client-api/):
//! START1 (0x94), START2 (0xc3), a 16-bit big-endian length, then that
//! many bytes of a protobuf-encoded ToRadio/FromRadio message.
//!
//! Uses the official `meshtastic` crate (github.com/meshtastic/rust) for
//! the protobuf message types — hand-transcribing those would have real
//! correctness risk, same "orchestrate, don't reimplement" reasoning as
//! sgp4 for satellite propagation. Deliberately NOT using that crate's
//! own connection API (`StreamApi`), though: it requires tokio, and every
//! other transport in this codebase (Pat, JS8Call, DX cluster, this)
//! is synchronous std::thread + blocking I/O. Pulling in a second
//! concurrency model for one integration wasn't worth it, and the crate's
//! `tokio` feature is optional — `protobufs` (real generated types) stays
//! available without it. The TCP client below is hand-written against the
//! verified framing instead.
//!
//! First-version scope: node list + text messages (broadcast and direct)
//! on channels using the default/known PSK, which the firmware decrypts
//! before handing packets to any client — matches ROADMAP's near-term
//! Phase 2 priorities. Position/telemetry graphs, traceroute, BLE/serial
//! transports, and encrypted-channel handling are real follow-ups, not
//! done here.

use crate::connectivity::{self, Status, Via};
use crate::db::{self, Db};
use chrono::Utc;
use meshtastic::protobufs::{from_radio, mesh_packet, routing, to_radio, Data, FromRadio, MeshPacket, PortNum, Position, ToRadio};
use meshtastic::Message;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const SOURCE_ID: &str = "meshtastic";
// Default target: meshtasticd (or a node) on this machine. Overridable
// per-station via `station_profile.mesh_host`, since real hardware
// usually sits elsewhere on the LAN.
const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 4403;
const RECONNECT_DELAY: Duration = Duration::from_secs(15);
/// The reconnect wait is slept in slices rather than one long block, so a
/// manual reconnect (host changed in Settings) takes effect in about a
/// second instead of up to RECONNECT_DELAY.
const RECONNECT_POLL_SLICE: Duration = Duration::from_secs(1);
const READ_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const START1: u8 = 0x94;
const START2: u8 = 0xc3;
const MAX_PACKET_LEN: usize = 512; // per the client-api doc: >512 assumed corrupted, resync
const BROADCAST_NODE: u32 = 0xFFFFFFFF;

/// Shared connection state. Every other transport in this app is
/// pure poll-and-read; this is the first one that also needs to send
/// on demand, so the write half of the live connection (and the local
/// node's own number, needed to label outbound messages) is kept here
/// for `send_mesh_text` to reach.
pub struct MeshState {
    pub stream: Mutex<Option<TcpStream>>,
    pub my_node_num: Mutex<Option<u32>>,
    /// The host:port the live connection was actually opened against —
    /// shown in the panel so "connected" is never ambiguous about *what*
    /// it's connected to.
    pub target: Mutex<Option<String>>,
    /// Set by `reconnect_mesh` to cut the reconnect wait short.
    pub reconnect_requested: AtomicBool,
}

impl MeshState {
    pub fn new() -> Self {
        MeshState {
            stream: Mutex::new(None),
            my_node_num: Mutex::new(None),
            target: Mutex::new(None),
            reconnect_requested: AtomicBool::new(false),
        }
    }
}

/// Resolves the configured Meshtastic target. Accepts either a bare host
/// (`192.168.1.50`) or `host:port`; anything after the last colon that
/// doesn't parse as a port is treated as part of the host rather than
/// silently discarded, so a typo surfaces as a connection error naming
/// the real string instead of quietly connecting somewhere else.
fn mesh_target(app: &AppHandle) -> String {
    let configured = {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        db::station_profile(&conn).mesh_host
    };
    let host = configured
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| DEFAULT_HOST.to_string());

    match host.rsplit_once(':') {
        Some((_, port)) if port.parse::<u16>().is_ok() => host,
        _ => format!("{host}:{DEFAULT_PORT}"),
    }
}

fn write_to_radio(stream: &mut TcpStream, msg: &ToRadio) -> std::io::Result<()> {
    let mut buf = Vec::new();
    msg.encode(&mut buf).expect("failed to encode ToRadio");
    let len = buf.len();
    let header = [START1, START2, (len >> 8) as u8, (len & 0xff) as u8];
    stream.write_all(&header)?;
    stream.write_all(&buf)?;
    Ok(())
}

/// Reads one FromRadio message per the verified framing. Any stray byte
/// where a header is expected is skipped rather than erroring — matches
/// the documented "return to looking for START1" resync behavior, and a
/// loop rather than recursion so a burst of garbage can't blow the stack.
fn read_from_radio(stream: &mut TcpStream) -> std::io::Result<FromRadio> {
    loop {
        let mut byte = [0u8; 1];
        loop {
            stream.read_exact(&mut byte)?;
            if byte[0] == START1 {
                break;
            }
        }
        stream.read_exact(&mut byte)?;
        if byte[0] != START2 {
            continue;
        }

        let mut len_bytes = [0u8; 2];
        stream.read_exact(&mut len_bytes)?;
        let len = u16::from_be_bytes(len_bytes) as usize;
        if len > MAX_PACKET_LEN {
            continue;
        }

        let mut payload = vec![0u8; len];
        stream.read_exact(&mut payload)?;
        return FromRadio::decode(payload.as_slice())
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e));
    }
}

fn generate_config_id() -> u32 {
    (Utc::now().timestamp_millis() & 0xFFFF_FFFF) as u32
}

/// Human-readable text for the routing::Error variants an operator would
/// actually need to understand — the rest fall back to Debug formatting
/// rather than hand-transcribing all ~15 variants.
fn routing_error_text(err: routing::Error) -> String {
    match err {
        routing::Error::None => "delivered".to_string(),
        routing::Error::NoRoute => "no route to destination".to_string(),
        routing::Error::GotNak => "received a NAK while forwarding".to_string(),
        routing::Error::Timeout => "timed out".to_string(),
        routing::Error::NoInterface => "no interface available to send".to_string(),
        routing::Error::MaxRetransmit => "max retransmissions reached".to_string(),
        routing::Error::NoChannel => "channel not configured on this node".to_string(),
        routing::Error::TooLarge => "message too large".to_string(),
        other => format!("{other:?}"),
    }
}

fn handle_mesh_packet(app: &AppHandle, packet: MeshPacket) {
    if let Some(mesh_packet::PayloadVariant::Decoded(data)) = packet.payload_variant {
        if data.portnum == PortNum::TextMessageApp as i32 {
            if let Ok(text) = String::from_utf8(data.payload) {
                if let Some(marker) = crate::dispatch::parse_marker_wire(&text) {
                    // A situational pin, not a chat message -- plotted on
                    // the map instead of appearing in the message list.
                    // insert_received_marker dedupes on content_hash, so
                    // a mesh hop rebroadcasting the same pin (including
                    // our own, echoed back after a relay) is a no-op.
                    let db = app.state::<Db>();
                    let conn = db.0.lock().expect("db mutex poisoned");
                    db::insert_received_marker(
                        &conn,
                        &marker.label,
                        &marker.marker_type,
                        marker.latitude,
                        marker.longitude,
                        marker.origin.as_deref(),
                        "mesh",
                    );
                    drop(conn);
                    let _ = app.emit("map-markers-changed", ());
                } else {
                    let db = app.state::<Db>();
                    let conn = db.0.lock().expect("db mutex poisoned");
                    db::insert_mesh_message(
                        &conn,
                        packet.from as i64,
                        packet.to as i64,
                        packet.channel as i64,
                        &text,
                        packet.rx_time as i64,
                        false,
                        None,
                    );
                    drop(conn);
                    let _ = app.emit("mesh-messages-changed", ());
                }
            }
        } else if data.portnum == PortNum::PositionApp as i32 {
            // Covers both a reply to send_mesh_position/request_mesh_position
            // and a GPS-equipped node's own unprompted periodic broadcast --
            // same packet shape either way. An empty/all-absent payload (a
            // bare position *request*, which also travels as PositionApp)
            // decodes fine but has no lat/lon, so it's a no-op here.
            if let Ok(position) = Position::decode(data.payload.as_slice()) {
                if let (Some(lat_i), Some(lon_i)) = (position.latitude_i, position.longitude_i) {
                    let db = app.state::<Db>();
                    let conn = db.0.lock().expect("db mutex poisoned");
                    db::update_mesh_node_position(
                        &conn,
                        packet.from as i64,
                        lat_i as f64 * 1e-7,
                        lon_i as f64 * 1e-7,
                        packet.rx_time as i64,
                    );
                    drop(conn);
                    let _ = app.emit("mesh-nodes-changed", ());
                }
            }
        } else if data.portnum == PortNum::RoutingApp as i32 {
            // A delivery status response for something WE sent — verified
            // live that this is real and needed: a test send to a
            // disabled channel was silently shown as "sent" even though
            // meshtasticd's own log showed it NAK'd with NoChannel.
            if let Ok(routing) = meshtastic::protobufs::Routing::decode(data.payload.as_slice()) {
                if let Some(routing::Variant::ErrorReason(err_i32)) = routing.variant {
                    let err = routing::Error::try_from(err_i32).unwrap_or(routing::Error::None);
                    let status = if err == routing::Error::None { "delivered" } else { "failed" };
                    let reason = routing_error_text(err);
                    let db = app.state::<Db>();
                    let conn = db.0.lock().expect("db mutex poisoned");
                    db::set_mesh_message_status(&conn, data.request_id as i64, status, Some(&reason));
                    drop(conn);
                    let _ = app.emit("mesh-messages-changed", ());
                }
            }
        }
        // Other portnums on decoded packets (telemetry, admin) aren't
        // surfaced yet — real follow-up, not this version.
    }
    // Encrypted packets (channels we don't have the PSK for) are silently
    // dropped for now — no decryption implemented.
}

fn handle_from_radio(app: &AppHandle, mesh_state: &MeshState, msg: FromRadio) {
    match msg.payload_variant {
        Some(from_radio::PayloadVariant::MyInfo(info)) => {
            *mesh_state.my_node_num.lock().expect("mesh state mutex poisoned") = Some(info.my_node_num);
        }
        Some(from_radio::PayloadVariant::NodeInfo(node)) => {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            let user = node.user.as_ref();
            db::upsert_mesh_node(
                &conn,
                node.num as i64,
                user.map(|u| u.id.as_str()),
                user.map(|u| u.long_name.as_str()),
                user.map(|u| u.short_name.as_str()),
                None, // hw_model: HardwareModel enum -> name mapping deferred, not done this version
                if node.snr != 0.0 { Some(node.snr as f64) } else { None },
                if node.last_heard != 0 { Some(node.last_heard as i64) } else { None },
                node.device_metrics.as_ref().and_then(|m| m.battery_level).map(|b| b as i64),
                node.is_favorite,
            );
            drop(conn);
            let _ = app.emit("mesh-nodes-changed", ());
        }
        Some(from_radio::PayloadVariant::Packet(packet)) => {
            handle_mesh_packet(app, packet);
        }
        Some(from_radio::PayloadVariant::ConfigCompleteId(_)) => {
            let _ = app.emit("mesh-config-complete", ());
        }
        _ => {}
    }
}

fn run_connection(app: &AppHandle) -> Result<(), String> {
    let target = mesh_target(app);
    let mut stream = TcpStream::connect(&target).map_err(|e| format!("{target}: {e}"))?;
    stream.set_read_timeout(Some(READ_TIMEOUT)).map_err(|e| e.to_string())?;
    let write_stream = stream.try_clone().map_err(|e| e.to_string())?;

    let mesh_state = app.state::<MeshState>();
    *mesh_state.stream.lock().expect("mesh state mutex poisoned") = Some(write_stream);
    *mesh_state.target.lock().expect("mesh state mutex poisoned") = Some(target);

    let want_config = ToRadio {
        payload_variant: Some(to_radio::PayloadVariant::WantConfigId(generate_config_id())),
    };
    if let Err(e) = write_to_radio(&mut stream, &want_config) {
        clear_connection(&mesh_state);
        return Err(e.to_string());
    }

    {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        connectivity::report_source_health(&conn, SOURCE_ID, "Meshtastic", Status::Healthy, Via::Mesh, None);
    }
    // A fresh connection is exactly when a queued message might finally
    // have somewhere to go -- retry them now rather than waiting for the
    // next manual dispatch attempt.
    crate::dispatch::redispatch_queued(app);
    crate::dispatch::redispatch_queued_markers(app);

    loop {
        match read_from_radio(&mut stream) {
            Ok(msg) => handle_from_radio(app, &mesh_state, msg),
            Err(e) => {
                clear_connection(&mesh_state);
                return Err(e.to_string());
            }
        }
    }
}

fn clear_connection(mesh_state: &MeshState) {
    *mesh_state.stream.lock().expect("mesh state mutex poisoned") = None;
    *mesh_state.target.lock().expect("mesh state mutex poisoned") = None;
}

pub fn spawn_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        if let Err(detail) = run_connection(&app) {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            connectivity::report_source_health(&conn, SOURCE_ID, "Meshtastic", Status::Down, Via::Mesh, Some(&detail));
        }

        // Deliberately not cleared before the wait: `reconnect_mesh` sets
        // the flag *then* shuts the socket down, so the request is
        // usually already pending by the time the reader errors out and
        // arrives here. Clearing first would swallow it and force a full
        // RECONNECT_DELAY wait.
        let mesh_state = app.state::<MeshState>();
        let mut waited = Duration::ZERO;
        while waited < RECONNECT_DELAY {
            if mesh_state.reconnect_requested.swap(false, Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(RECONNECT_POLL_SLICE);
            waited += RECONNECT_POLL_SLICE;
        }
    });
}

#[derive(serde::Serialize)]
pub struct MeshStatus {
    pub connected: bool,
    pub my_node_num: Option<i64>,
    /// What the live connection is actually pointed at, or — when
    /// disconnected — what the next attempt will use.
    pub target: String,
}

#[tauri::command]
pub fn get_mesh_status(app: AppHandle, mesh_state: State<MeshState>) -> MeshStatus {
    let live_target = mesh_state.target.lock().expect("mesh state mutex poisoned").clone();
    MeshStatus {
        connected: mesh_state.stream.lock().expect("mesh state mutex poisoned").is_some(),
        my_node_num: mesh_state
            .my_node_num
            .lock()
            .expect("mesh state mutex poisoned")
            .map(|n| n as i64),
        target: live_target.unwrap_or_else(|| mesh_target(&app)),
    }
}

/// Drops the current connection so the poller immediately reconnects,
/// picking up a changed `mesh_host`. Same explicit-button model as Pat's
/// `restart_winlink_service` — a settings change never silently kills a
/// live link out from under the operator.
#[tauri::command]
pub fn reconnect_mesh(mesh_state: State<MeshState>) {
    mesh_state.reconnect_requested.store(true, Ordering::SeqCst);
    // Shutting down the socket is what actually unblocks the reader
    // thread, which is otherwise parked in a blocking read for up to
    // READ_TIMEOUT.
    if let Some(stream) = mesh_state.stream.lock().expect("mesh state mutex poisoned").as_ref() {
        let _ = stream.shutdown(std::net::Shutdown::Both);
    }
}

#[tauri::command]
pub fn send_mesh_text(
    mesh_state: State<MeshState>,
    db: State<Db>,
    text: String,
    to_node: Option<i64>,
    channel: i64,
    want_ack: bool,
) -> Result<(), String> {
    let to = to_node.map(|n| n as u32).unwrap_or(BROADCAST_NODE);
    let my_node_num = mesh_state.my_node_num.lock().expect("mesh state mutex poisoned").unwrap_or(0);
    // A real, non-zero id -- needed both so the firmware's routing
    // response can reference something, and so this app can match that
    // response back to this specific message via Data.request_id.
    let packet_id = generate_config_id();

    let packet = MeshPacket {
        from: my_node_num,
        to,
        id: packet_id,
        channel: channel as u32,
        want_ack,
        payload_variant: Some(mesh_packet::PayloadVariant::Decoded(Data {
            portnum: PortNum::TextMessageApp as i32,
            payload: text.clone().into_bytes(),
            ..Default::default()
        })),
        ..Default::default()
    };
    let to_radio = ToRadio { payload_variant: Some(to_radio::PayloadVariant::Packet(packet)) };

    let mut guard = mesh_state.stream.lock().expect("mesh state mutex poisoned");
    let stream = guard.as_mut().ok_or("not connected to a mesh node")?;
    write_to_radio(stream, &to_radio).map_err(|e| e.to_string())?;
    drop(guard);

    // Log our own outbound message locally too, since the radio doesn't
    // echo our own packets back to us over the same connection. Starts as
    // "sent"; handle_mesh_packet flips it to "delivered" or "failed" if a
    // routing response for this packet_id arrives.
    let conn = db.0.lock().expect("db mutex poisoned");
    db::insert_mesh_message(
        &conn,
        my_node_num as i64,
        to as i64,
        channel,
        &text,
        Utc::now().timestamp(),
        true,
        Some(packet_id as i64),
    );
    drop(conn);

    Ok(())
}

/// Broadcasts this station's fixed QTH, derived from the grid square in
/// Settings rather than a GPS fix -- correct for the common case here of a
/// stationary home/EOC node with no GPS attached. First cut of position
/// support; unlike the rest of this module, not yet confirmed against a
/// real node (see module docs) -- verify against real hardware before
/// relying on it.
#[tauri::command]
pub fn send_mesh_position(mesh_state: State<MeshState>, db: State<Db>, to_node: Option<i64>) -> Result<(), String> {
    let grid = db::station_profile(&db.0.lock().expect("db mutex poisoned")).grid_square;
    let (lat, lon) = grid
        .as_deref()
        .and_then(crate::maidenhead::grid_square_to_lat_lon)
        .ok_or("set a grid square in Settings first")?;

    let position = Position {
        latitude_i: Some((lat * 1e7) as i32),
        longitude_i: Some((lon * 1e7) as i32),
        ..Default::default()
    };

    send_position_packet(&mesh_state, to_node, position.encode_to_vec(), false)
}

/// Asks another node (or the whole channel) to reply with its own
/// position -- an empty Position payload with `want_response` set, per
/// the client-api convention. Same first-cut caveat as send_mesh_position.
#[tauri::command]
pub fn request_mesh_position(mesh_state: State<MeshState>, to_node: Option<i64>) -> Result<(), String> {
    send_position_packet(&mesh_state, to_node, Vec::new(), true)
}

fn send_position_packet(
    mesh_state: &State<MeshState>,
    to_node: Option<i64>,
    payload: Vec<u8>,
    want_response: bool,
) -> Result<(), String> {
    let to = to_node.map(|n| n as u32).unwrap_or(BROADCAST_NODE);
    let my_node_num = mesh_state.my_node_num.lock().expect("mesh state mutex poisoned").unwrap_or(0);
    let packet = MeshPacket {
        from: my_node_num,
        to,
        id: generate_config_id(),
        channel: 0,
        want_ack: false,
        payload_variant: Some(mesh_packet::PayloadVariant::Decoded(Data {
            portnum: PortNum::PositionApp as i32,
            payload,
            want_response,
            ..Default::default()
        })),
        ..Default::default()
    };
    let to_radio = ToRadio { payload_variant: Some(to_radio::PayloadVariant::Packet(packet)) };

    let mut guard = mesh_state.stream.lock().expect("mesh state mutex poisoned");
    let stream = guard.as_mut().ok_or("not connected to a mesh node")?;
    write_to_radio(stream, &to_radio).map_err(|e| e.to_string())
}
