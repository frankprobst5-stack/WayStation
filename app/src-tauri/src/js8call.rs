//! JS8Call TCP API client (Phase 3 off-grid messaging).
//!
//! Unlike Pat, WayStation does not spawn JS8Call — it needs its own audio
//! device and rig configured through its own GUI, which we can't automate.
//! This module is purely a client: connect, send a newline-delimited JSON
//! request, read newline-delimited JSON responses until one matches the
//! type we're waiting for (other clients' traffic is broadcast on the same
//! socket, so unrelated messages must be skipped, not treated as errors).
//!
//! Protocol confirmed against the JS8Call API ecosystem's Python clients
//! (js8net, pyjs8call) since JS8Call's own API docs are openly incomplete.
//! Response envelope: `{"type": ..., "value": ..., "params": {...}}`.
//! The exact shape of INBOX.MESSAGES' contents isn't pinned down without a
//! live instance, so it's returned as raw JSON rather than a typed struct —
//! the frontend reads it defensively, same posture as the Winlink inbox.

use crate::connectivity::{self, Status, Via};
use crate::db::Db;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2442;
const TIMEOUT: Duration = Duration::from_secs(3);
const SOURCE_ID: &str = "js8call";
const HEALTH_POLL_INTERVAL: Duration = Duration::from_secs(30);

fn request(msg_type: &str, value: &str, expect_type: &str) -> Result<Value, String> {
    let stream = TcpStream::connect((HOST, PORT)).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(TIMEOUT)).ok();
    stream.set_write_timeout(Some(TIMEOUT)).ok();

    let id = chrono::Utc::now().timestamp_millis().to_string();
    let payload = json!({"type": msg_type, "value": value, "params": {"_ID": id}});
    let mut line = payload.to_string();
    line.push('\n');

    let mut writer = stream.try_clone().map_err(|e| e.to_string())?;
    writer.write_all(line.as_bytes()).map_err(|e| e.to_string())?;

    let reader = BufReader::new(stream);
    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let parsed: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue, // malformed or partial line; keep reading
        };
        if parsed.get("type").and_then(Value::as_str) == Some(expect_type) {
            return Ok(parsed);
        }
        // Unrelated broadcast traffic from other activity on the shared
        // socket (JS8Call fans out RX.* events to every connected client).
    }
    Err("no response before timeout — is JS8Call running with its TCP API enabled?".to_string())
}

/// Queues a message for transmission. Fire-and-forget, deliberately not
/// built on `request()` above — confirmed live 2026-08-30 (no radio
/// attached, message appeared queued in JS8Call's own TX window rather
/// than transmitting) that TX.SEND_MESSAGE gets no distinct response type
/// back at all, unlike every other command here, so waiting for one would
/// just time out and wrongly report failure on a send that actually
/// worked. JS8Call's own convention for a directed message is
/// "<CALLSIGN>: <text>"; JS8Call splits long text across multiple
/// over-the-air frames itself, so no chunking is needed on this end.
pub fn send_message(to: &str, text: &str) -> Result<(), String> {
    let mut stream = TcpStream::connect((HOST, PORT)).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(TIMEOUT)).ok();
    let value = format!("{}: {}", to.trim().to_uppercase(), text);
    let payload = json!({"type": "TX.SEND_MESSAGE", "value": value, "params": {}});
    let mut line = payload.to_string();
    line.push('\n');
    stream.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

#[derive(Debug, serde::Serialize)]
pub struct Js8CallStatus {
    pub reachable: bool,
    pub callsign: Option<String>,
    pub detail: Option<String>,
}

#[tauri::command]
pub fn get_js8call_status() -> Js8CallStatus {
    match request("STATION.GET_CALLSIGN", "", "STATION.CALLSIGN") {
        Ok(resp) => {
            let callsign = resp.get("value").and_then(Value::as_str).map(str::to_string);
            Js8CallStatus { reachable: true, callsign, detail: None }
        }
        Err(detail) => Js8CallStatus { reachable: false, callsign: None, detail: Some(detail) },
    }
}

/// Reports JS8Call reachability into `source_health` on its own cadence.
///
/// Without this, JS8Call's state was only ever computed while its panel
/// was on screen, so nothing outside that tab — the diagnostics panel, the
/// connectivity state machine — could see it. Pat had the same gap, and
/// that is exactly how a Pat running under the wrong callsign went
/// unnoticed for three days.
///
/// Reported as `Via::Rf`: JS8Call is an RF mode, so a healthy JS8Call is
/// evidence the station can still pass traffic with the internet gone.
pub fn spawn_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        let status = get_js8call_status();
        let (health, detail) = if status.reachable {
            (Status::Healthy, None)
        } else {
            // The raw connect error ("Connection refused") is less useful
            // to an operator than what to actually do about it.
            (
                Status::Down,
                Some(
                    "JS8Call isn't reachable on 127.0.0.1:2442. Start JS8Call and enable its TCP \
                     server (File > Settings > Reporting)."
                        .to_string(),
                ),
            )
        };
        {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            connectivity::report_source_health(
                &conn,
                SOURCE_ID,
                "JS8Call",
                health,
                Via::Rf,
                detail.as_deref(),
            );
        }
        std::thread::sleep(HEALTH_POLL_INTERVAL);
    });
}

#[tauri::command]
pub fn get_js8call_inbox() -> Vec<Value> {
    let Ok(resp) = request("INBOX.GET_MESSAGES", "", "INBOX.MESSAGES") else {
        return Vec::new();
    };
    // Defensive: try the two most plausible shapes rather than assume one.
    if let Some(arr) = resp.get("params").and_then(|p| p.get("MESSAGES")).and_then(Value::as_array) {
        return arr.clone();
    }
    if let Some(arr) = resp.get("value").and_then(Value::as_array) {
        return arr.clone();
    }
    Vec::new()
}
