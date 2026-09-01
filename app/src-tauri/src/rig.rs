//! Hamlib rig control, via `rigctld`'s TCP protocol (Phase 4).
//!
//! Protocol verified against a real running `rigctld` (Hamlib 4.6.5) with
//! the Dummy rig (model 1) before any of this was written, same discipline
//! as every other transport here.
//!
//! Uses rigctld's **extended response mode** — commands prefixed with `+`.
//! Plain mode returns bare values whose line count varies per command,
//! which forces the client to know in advance how many lines each reply
//! occupies. Extended mode instead terminates every reply with a
//! `RPRT <code>` line, so a reply can be read until the terminator without
//! knowing anything about the command. Verified shapes:
//!
//! ```text
//! +\get_vfo_info VFOA  ->  get_vfo_info: VFOA / Freq: 14074000 /
//!                          Mode: USB / Width: 2400 / Split: 0 /
//!                          SatMode: 0 / RPRT 0
//! +l STRENGTH          ->  get_level: STRENGTH / -1 / RPRT 0
//! +t                   ->  get_ptt: / RPRT -11
//! ```
//!
//! Note that last one: a rig that doesn't implement a function answers
//! `RPRT -11` (Hamlib's RIG_ENAVAIL), which is *not* a failure — it means
//! "this radio can't do that." Reporting it as an error would make every
//! rig look broken for the functions it simply lacks.
//!
//! **Client only — Waystation never spawns `rigctld`.** This is a
//! deliberate departure from the Pat model, for a physical reason: a
//! rig's serial port is exclusive. Many operators already run `rigctld`
//! or FLRig to share one radio between WSJT-X, JS8Call, and a logger, and
//! a second daemon opening the same port would break the setup they
//! already depend on. Connecting to whatever is already there is both
//! safer and how the rest of the ham software ecosystem behaves.
//!
//! Setting frequency and mode is supported. **PTT deliberately is not** —
//! keying a transmitter is not something that should ever be one stray
//! click away in a dashboard, and unattended transmission has real
//! regulatory weight. Reading PTT state would be fine; asserting it is
//! out of scope.

use crate::connectivity::{self, Status, Via};
use crate::db::{self, Db};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const SOURCE_ID: &str = "rigctl";
const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 4532;
const TIMEOUT: Duration = Duration::from_secs(3);
const HEALTH_POLL_INTERVAL: Duration = Duration::from_secs(30);

/// Resolves the configured rigctld target. Same `host` or `host:port`
/// handling as the Meshtastic host field — anything after the last colon
/// that isn't a valid port is treated as part of the hostname rather than
/// silently discarded.
fn rig_target(app: &AppHandle) -> String {
    let configured = {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        db::station_profile(&conn).rigctld_host
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

struct RigReply {
    /// `Key: Value` lines, e.g. `Freq: 14074000`.
    fields: HashMap<String, String>,
    /// Bare lines with no key, in order — how `l STRENGTH` returns its
    /// reading.
    values: Vec<String>,
    /// Hamlib return code. 0 is success; negatives are documented errors.
    code: i32,
}

/// Human text for the Hamlib error codes an operator might actually see.
/// Anything else falls back to the raw code rather than inventing a
/// meaning for it.
fn rig_error_text(code: i32) -> String {
    match code {
        -1 => "invalid parameter".to_string(),
        -2 => "invalid configuration".to_string(),
        -3 => "out of memory".to_string(),
        -4 => "function not implemented".to_string(),
        -5 => "communication timed out".to_string(),
        -6 => "IO error — check the cable and the radio's power".to_string(),
        -8 => "protocol error talking to the radio".to_string(),
        -9 => "command rejected by the radio".to_string(),
        -11 => "this radio doesn't support that function".to_string(),
        other => format!("rigctld error {other}"),
    }
}

/// One request/response against rigctld. Opens a fresh connection per
/// call, matching js8call.rs — rigctld handles short-lived connections
/// fine, and it means there is no connection state to get out of sync.
fn request(target: &str, command: &str) -> Result<RigReply, String> {
    let stream = TcpStream::connect(target).map_err(|e| format!("{target}: {e}"))?;
    stream.set_read_timeout(Some(TIMEOUT)).ok();
    stream.set_write_timeout(Some(TIMEOUT)).ok();

    let mut writer = stream.try_clone().map_err(|e| e.to_string())?;
    writer
        .write_all(format!("+{command}\n").as_bytes())
        .map_err(|e| e.to_string())?;

    let mut reader = BufReader::new(stream);
    let mut fields = HashMap::new();
    let mut values = Vec::new();

    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if read == 0 {
            return Err("rigctld closed the connection before replying".to_string());
        }
        let line = line.trim_end();

        if let Some(rest) = line.strip_prefix("RPRT ") {
            let code = rest.trim().parse::<i32>().map_err(|_| format!("unparseable RPRT: {line}"))?;
            return Ok(RigReply { fields, values, code });
        }
        match line.split_once(": ") {
            Some((k, v)) => {
                fields.insert(k.trim().to_string(), v.trim().to_string());
            }
            None => {
                // The echoed command name arrives as "get_freq:" with an
                // empty value; only keep genuine bare readings.
                if !line.is_empty() && !line.ends_with(':') {
                    values.push(line.to_string());
                }
            }
        }
    }
}

/// True when the configured target is somewhere other than this machine,
/// which means rig control is crossing a network. `rigctld` has **no
/// authentication of any kind**, so anyone who can reach that port can
/// key the transmitter — worth telling the operator at the moment they
/// opt into it, along with the specific fix.
pub fn is_remote_target(target: &str) -> bool {
    let host = target.rsplit_once(':').map(|(h, _)| h).unwrap_or(target);
    !matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]")
}

#[derive(Debug, Default, serde::Serialize)]
pub struct RigStatus {
    pub reachable: bool,
    /// False when the operator has switched rig control off entirely.
    pub enabled: bool,
    /// Set when the target isn't local — see `is_remote_target`.
    pub remote_target: bool,
    pub target: String,
    pub frequency_hz: Option<u64>,
    pub mode: Option<String>,
    pub passband_hz: Option<u32>,
    pub split: Option<bool>,
    pub sat_mode: Option<bool>,
    /// S-meter reading in dB relative to S9. None when the rig doesn't
    /// report one, which is common and not an error.
    pub strength_db: Option<i32>,
    pub detail: Option<String>,
}

fn read_status(target: &str) -> RigStatus {
    let mut status = RigStatus {
        target: target.to_string(),
        enabled: true,
        remote_target: is_remote_target(target),
        ..Default::default()
    };

    match request(target, "\\get_vfo_info VFOA") {
        Ok(reply) if reply.code == 0 => {
            status.reachable = true;
            status.frequency_hz = reply.fields.get("Freq").and_then(|v| v.parse().ok());
            status.mode = reply.fields.get("Mode").cloned();
            status.passband_hz = reply.fields.get("Width").and_then(|v| v.parse().ok());
            status.split = reply.fields.get("Split").map(|v| v != "0");
            status.sat_mode = reply.fields.get("SatMode").map(|v| v != "0");
        }
        Ok(reply) => {
            // Reached rigctld, but it couldn't talk to the radio — a real
            // and distinct state from "nothing is listening."
            status.reachable = true;
            status.detail = Some(rig_error_text(reply.code));
            return status;
        }
        Err(e) => {
            status.detail = Some(e);
            return status;
        }
    }

    // Signal strength is a separate call and frequently unsupported.
    // A rig without an S-meter is not a broken rig, so a failure here
    // leaves the field empty without touching the overall status.
    if let Ok(reply) = request(target, "l STRENGTH") {
        if reply.code == 0 {
            status.strength_db = reply.values.first().and_then(|v| v.parse().ok());
        }
    }

    status
}

fn rig_enabled(app: &AppHandle) -> bool {
    let db = app.state::<Db>();
    let conn = db.0.lock().expect("db mutex poisoned");
    db::station_profile(&conn).rig_enabled
}

#[tauri::command]
pub fn get_rig_status(app: AppHandle) -> RigStatus {
    let target = rig_target(&app);
    if !rig_enabled(&app) {
        return RigStatus {
            target: target.clone(),
            enabled: false,
            remote_target: is_remote_target(&target),
            ..Default::default()
        };
    }
    read_status(&target)
}

#[tauri::command]
pub fn set_rig_frequency(app: AppHandle, hz: u64) -> Result<(), String> {
    if !rig_enabled(&app) {
        return Err("Rig control is switched off in Settings.".to_string());
    }
    let target = rig_target(&app);
    let reply = request(&target, &format!("F {hz}"))?;
    if reply.code != 0 {
        return Err(rig_error_text(reply.code));
    }
    Ok(())
}

#[tauri::command]
pub fn set_rig_mode(app: AppHandle, mode: String, passband_hz: u32) -> Result<(), String> {
    if !rig_enabled(&app) {
        return Err("Rig control is switched off in Settings.".to_string());
    }
    let target = rig_target(&app);
    // Guard the mode string rather than passing operator input straight
    // into the control protocol for a physical transmitter.
    if !mode.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(format!("invalid mode: {mode}"));
    }
    let reply = request(&target, &format!("M {mode} {passband_hz}"))?;
    if reply.code != 0 {
        return Err(rig_error_text(reply.code));
    }
    Ok(())
}

/// Reports rig reachability into `source_health`, so a rig that stopped
/// responding is visible in Diagnostics rather than only on its own panel
/// — the gap that let a misbehaving Pat hide for three days.
pub fn spawn_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        if !rig_enabled(&app) {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            connectivity::report_source_health(
                &conn,
                SOURCE_ID,
                "Rig control (Hamlib)",
                Status::Degraded,
                Via::Rf,
                Some("Switched off in Settings."),
            );
            drop(conn);
            std::thread::sleep(HEALTH_POLL_INTERVAL);
            continue;
        }
        let status = read_status(&rig_target(&app));
        let (health, detail) = if status.reachable && status.detail.is_none() {
            (Status::Healthy, None)
        } else if status.reachable {
            (Status::Degraded, status.detail.clone())
        } else {
            (
                Status::Down,
                Some(format!(
                    "No rigctld on {}. Start it (e.g. `rigctld -m <model> -r <device>`), or set a \
                     different address in Settings. Hamlib model 1 is a dummy rig for testing \
                     without hardware.",
                    status.target
                )),
            )
        };
        {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            connectivity::report_source_health(
                &conn,
                SOURCE_ID,
                "Rig control (Hamlib)",
                health,
                Via::Rf,
                detail.as_deref(),
            );
        }
        std::thread::sleep(HEALTH_POLL_INTERVAL);
    });
}
