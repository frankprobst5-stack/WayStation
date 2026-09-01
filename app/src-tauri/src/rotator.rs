//! Hamlib rotator control, via `rotctld`'s TCP protocol (Phase 4).
//!
//! Same wire protocol as `rig.rs`'s `rigctld` client — extended response
//! mode (`+` prefix commands, every reply terminated by `RPRT <code>`) —
//! verified directly against a real running `rotctld` (Hamlib, Dummy
//! rotator model 1) before writing anything: `+p` reads azimuth/elevation,
//! `+P <az> <el>` sets a target position, both confirmed live.
//!
//! Same reasoning as rig.rs for every other design choice: client only,
//! never spawns `rotctld` (an operator may already be sharing one rotator
//! between multiple programs), address configurable per-station, an
//! explicit enable switch so it can be fully off with no antenna hardware
//! attached, and a security warning the moment the configured host isn't
//! local, since rotctld has the same no-authentication exposure rigctld
//! does.

use crate::connectivity::{self, Status, Via};
use crate::db::{self, Db};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const SOURCE_ID: &str = "rotctl";
const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 4533;
const TIMEOUT: Duration = Duration::from_secs(3);
const HEALTH_POLL_INTERVAL: Duration = Duration::from_secs(30);

fn rotator_target(app: &AppHandle) -> String {
    let configured = {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        db::station_profile(&conn).rotctld_host
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

/// Same check as `rig::is_remote_target` — worth duplicating rather than
/// sharing, since the two targets (rig vs. rotator) are independently
/// configurable and a future refactor coupling them would be a real
/// regression if someone points one locally and the other remotely.
pub fn is_remote_target(target: &str) -> bool {
    let host = target.rsplit_once(':').map(|(h, _)| h).unwrap_or(target);
    !matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]")
}

struct RotctlReply {
    fields: HashMap<String, String>,
    code: i32,
}

fn rotctl_error_text(code: i32) -> String {
    match code {
        -1 => "invalid parameter".to_string(),
        -2 => "invalid configuration".to_string(),
        -5 => "communication timed out".to_string(),
        -6 => "IO error — check the cable and the rotator's power".to_string(),
        -8 => "protocol error talking to the rotator".to_string(),
        -9 => "command rejected by the rotator".to_string(),
        -11 => "this rotator doesn't support that function".to_string(),
        other => format!("rotctld error {other}"),
    }
}

fn request(target: &str, command: &str) -> Result<RotctlReply, String> {
    let stream = TcpStream::connect(target).map_err(|e| format!("{target}: {e}"))?;
    stream.set_read_timeout(Some(TIMEOUT)).ok();
    stream.set_write_timeout(Some(TIMEOUT)).ok();

    let mut writer = stream.try_clone().map_err(|e| e.to_string())?;
    writer
        .write_all(format!("+{command}\n").as_bytes())
        .map_err(|e| e.to_string())?;

    let mut reader = BufReader::new(stream);
    let mut fields = HashMap::new();

    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if read == 0 {
            return Err("rotctld closed the connection before replying".to_string());
        }
        let line = line.trim_end();

        if let Some(rest) = line.strip_prefix("RPRT ") {
            let code = rest.trim().parse::<i32>().map_err(|_| format!("unparseable RPRT: {line}"))?;
            return Ok(RotctlReply { fields, code });
        }
        if let Some((k, v)) = line.split_once(": ") {
            fields.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
}

#[derive(Debug, Default, serde::Serialize)]
pub struct RotatorStatus {
    pub reachable: bool,
    pub enabled: bool,
    pub remote_target: bool,
    pub target: String,
    pub azimuth_deg: Option<f64>,
    pub elevation_deg: Option<f64>,
    pub detail: Option<String>,
}

fn rotator_enabled(app: &AppHandle) -> bool {
    let db = app.state::<Db>();
    let conn = db.0.lock().expect("db mutex poisoned");
    db::station_profile(&conn).rotator_enabled
}

fn read_status(target: &str) -> RotatorStatus {
    let mut status = RotatorStatus {
        target: target.to_string(),
        enabled: true,
        remote_target: is_remote_target(target),
        ..Default::default()
    };

    match request(target, "p") {
        Ok(reply) if reply.code == 0 => {
            status.reachable = true;
            status.azimuth_deg = reply.fields.get("Azimuth").and_then(|v| v.parse().ok());
            status.elevation_deg = reply.fields.get("Elevation").and_then(|v| v.parse().ok());
        }
        Ok(reply) => {
            status.reachable = true;
            status.detail = Some(rotctl_error_text(reply.code));
        }
        Err(e) => {
            status.detail = Some(e);
        }
    }
    status
}

#[tauri::command]
pub fn get_rotator_status(app: AppHandle) -> RotatorStatus {
    let target = rotator_target(&app);
    if !rotator_enabled(&app) {
        return RotatorStatus {
            target: target.clone(),
            enabled: false,
            remote_target: is_remote_target(&target),
            ..Default::default()
        };
    }
    read_status(&target)
}

#[tauri::command]
pub fn set_rotator_position(app: AppHandle, azimuth_deg: f64, elevation_deg: f64) -> Result<(), String> {
    if !rotator_enabled(&app) {
        return Err("Rotator control is switched off in Settings.".to_string());
    }
    if !(0.0..=360.0).contains(&azimuth_deg) || !(-90.0..=90.0).contains(&elevation_deg) {
        return Err("Azimuth must be 0-360°, elevation -90-90°.".to_string());
    }
    let target = rotator_target(&app);
    let reply = request(&target, &format!("P {azimuth_deg} {elevation_deg}"))?;
    if reply.code != 0 {
        return Err(rotctl_error_text(reply.code));
    }
    Ok(())
}

/// Reports rotator reachability into `source_health`, same reasoning as
/// every other transport here — visible in Diagnostics, not just on its
/// own panel.
pub fn spawn_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        if !rotator_enabled(&app) {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            connectivity::report_source_health(
                &conn,
                SOURCE_ID,
                "Rotator control (Hamlib)",
                Status::Degraded,
                Via::Rf,
                Some("Switched off in Settings."),
            );
            drop(conn);
            std::thread::sleep(HEALTH_POLL_INTERVAL);
            continue;
        }
        let status = read_status(&rotator_target(&app));
        let (health, detail) = if status.reachable && status.detail.is_none() {
            (Status::Healthy, None)
        } else if status.reachable {
            (Status::Degraded, status.detail.clone())
        } else {
            (
                Status::Down,
                Some(format!(
                    "No rotctld on {}. Start it (e.g. `rotctld -m <model> -r <device>`), or set a \
                     different address in Settings. Hamlib model 1 is a dummy rotator for testing \
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
                "Rotator control (Hamlib)",
                health,
                Via::Rf,
                detail.as_deref(),
            );
        }
        std::thread::sleep(HEALTH_POLL_INTERVAL);
    });
}
