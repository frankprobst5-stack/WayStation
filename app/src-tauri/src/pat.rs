//! Pat (Winlink) wrapper. Orchestrates the external `pat` binary rather
//! than reimplementing the Winlink protocol — CONTRIBUTING.md's "orchestrate,
//! don't reimplement" principle. Pat is not bundled with WayStation; every
//! command here degrades to a clear status rather than failing silently if
//! it isn't installed or configured.
//!
//! Composing/sending real Winlink traffic is deliberately out of scope here
//! — that needs the operator's own Winlink account password, entered by
//! them directly (into Pat's own config), never handled by WayStation.

use crate::connectivity::{self, Status, Via};
use crate::db::{self, Db};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const HTTP_ADDR: &str = "127.0.0.1:8778";
const HTTP_BASE: &str = "http://127.0.0.1:8778";
const SOURCE_ID: &str = "winlink-pat";
const HEALTH_POLL_INTERVAL: Duration = Duration::from_secs(30);

pub struct PatProcess(pub Mutex<Option<Child>>);

fn pat_dir() -> PathBuf {
    let dir = db::data_dir().join("pat");
    std::fs::create_dir_all(&dir).expect("failed to create pat data directory");
    dir
}

/// Kills any Pat process that's ours, even one we've lost track of.
///
/// Found live: a Pat launched with Waystation's config survives a hard
/// kill of the Waystation process itself (`kill -9`, which skips the
/// RunEvent::Exit handler that's supposed to clean this up), then sits
/// there — undetected until Diagnostics happens to notice — blocking
/// every future spawn attempt with a bind error. The same orphan
/// survived from 01:18 through several dev-stack restarts undiscovered.
///
/// Matches on the exact `--config` path Waystation always uses, never on
/// the process being merely named "pat" — that's the difference between
/// reclaiming our own leftover and killing a Pat the operator started
/// themselves under a different config. If the path doesn't match
/// exactly, this leaves the process alone.
fn reclaim_orphaned_pat() {
    let our_config = pat_dir().join("config.json");
    let our_config = our_config.to_string_lossy().to_string();

    // Plain refresh_processes() leaves cmd() empty on every process --
    // fetching argv is apparently opt-in, not default. Found this only by
    // adding debug output and looking, not by assuming the first version
    // that compiled was correct.
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        true,
        sysinfo::ProcessRefreshKind::new().with_cmd(sysinfo::UpdateKind::Always),
    );

    for process in system.processes().values() {
        let name = process.name().to_string_lossy();
        if !name.contains("pat") {
            continue;
        }
        let matches_our_config = process
            .cmd()
            .iter()
            .any(|arg| arg.to_string_lossy() == our_config);
        if matches_our_config {
            process.kill();
        }
    }
}

fn find_pat_binary() -> Option<PathBuf> {
    if Command::new("pat")
        .arg("version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
    {
        return Some(PathBuf::from("pat"));
    }
    let mut candidates = vec![PathBuf::from("/usr/local/bin/pat"), PathBuf::from("/usr/bin/pat")];
    if let Some(home) = dirs::home_dir() {
        candidates.insert(0, home.join(".local/bin/pat"));
    }
    candidates.into_iter().find(|p| p.exists())
}

#[derive(Debug, Serialize)]
pub struct WinlinkStatus {
    pub binary_found: bool,
    pub callsign_configured: bool,
    pub process_running: bool,
    pub api_reachable: bool,
    /// True when Pat's API answers but the process isn't ours — almost
    /// always an orphan from an earlier session still holding the port,
    /// which means the new Pat we spawned died on a bind error.
    ///
    /// This is worth calling out loudly rather than showing a green
    /// light: an orphan keeps running with whatever callsign it was
    /// started under, so the operator can be transmitting as someone
    /// else entirely while the panel claims everything is fine. A real
    /// instance of this survived three days with `--mycall TEST`.
    pub foreign_process: bool,
    pub raw_status: Option<Value>,
    /// Same reasoning as `RigStatus.enabled`/`MeshStatus.enabled` -- lets
    /// the UI say "switched off in Settings" instead of a bare "Pat isn't
    /// responding" when it's off by choice, not a real failure.
    pub enabled: bool,
}

fn api_get(path: &str) -> Option<Value> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .ok()?;
    client.get(format!("{HTTP_BASE}{path}")).send().ok()?.json().ok()
}

/// Posts a message into Pat's local outbox. Purely local -- this is
/// `postOutboundMessageHandler` -> `h.Mailbox().AddOut(msg)` in Pat's own
/// source, which just writes the message to the mbox directory, no RF or
/// internet involved. Verified directly against Pat's real source
/// (`api/mailbox.go`) rather than assumed, since this endpoint isn't
/// documented anywhere Pat itself publishes. Getting a message *queued*
/// and actually *transmitting* it are separate steps in Pat's own model
/// (the latter is `/api/connect`) -- this deliberately only does the
/// former. A Winlink address is just the recipient's callsign, so
/// `to_station` needs no transformation to be a valid address.
pub fn post_to_outbox(to: &str, subject: &str, body: &str) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let date = chrono::Utc::now().to_rfc3339();
    let resp = client
        .post(format!("{HTTP_BASE}/api/mailbox/out"))
        .form(&[("to", to), ("subject", subject), ("body", body), ("date", &date)])
        .send()
        .map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("Pat returned {}", resp.status()))
    }
}

/// Same real, live-checked pattern `rig::rig_enabled`/`mesh::mesh_enabled`
/// already use.
fn winlink_enabled(app: &AppHandle) -> bool {
    let db = app.state::<Db>();
    let conn = db.0.lock().expect("db mutex poisoned");
    db::station_profile(&conn).winlink_enabled
}

#[tauri::command]
pub fn get_winlink_status(app: AppHandle) -> WinlinkStatus {
    let binary_found = find_pat_binary().is_some();
    let callsign_configured = {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        db::station_profile(&conn).callsign.is_some()
    };
    // Holding a Child handle is not the same as having a live process --
    // the handle stays Some after the process exits, until it's reaped.
    // Checking is_some() alone reported a Pat that died instantly on a
    // bind error as "running", which is exactly how an orphan went
    // unnoticed for three days. try_wait() asks the OS instead of
    // trusting the handle.
    let process_running = {
        let state = app.state::<PatProcess>();
        let mut guard = state.0.lock().expect("pat process mutex poisoned");
        match guard.as_mut().map(|child| child.try_wait()) {
            Some(Ok(None)) => true,
            Some(Ok(Some(_))) => {
                *guard = None;
                false
            }
            Some(Err(_)) | None => false,
        }
    };
    let raw_status = api_get("/api/status");
    let api_reachable = raw_status.is_some();
    WinlinkStatus {
        binary_found,
        callsign_configured,
        process_running,
        api_reachable,
        foreign_process: api_reachable && !process_running,
        raw_status,
        enabled: winlink_enabled(&app),
    }
}

#[tauri::command]
pub fn get_winlink_inbox() -> Vec<Value> {
    api_get("/api/mailbox/in")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}

/// Kills whatever Pat process WayStation itself is holding a handle to, if
/// any, and waits for it to actually exit -- used when the operator
/// switches Winlink off in Settings, so "off" really means no running
/// process, not just a poller that stops reporting on it.
fn stop_pat(app: &AppHandle) {
    let state = app.state::<PatProcess>();
    let mut guard = state.0.lock().expect("pat process mutex poisoned");
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// (Re)spawns the pat http process with the current station callsign.
/// No-ops if Winlink is switched off, the binary isn't found, or no
/// callsign is configured yet — callable again later once any of those
/// changes, without an app restart.
pub fn spawn_or_restart(app: &AppHandle) {
    if !winlink_enabled(app) {
        return;
    }
    let Some(binary) = find_pat_binary() else { return };

    let callsign = {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        db::station_profile(&conn).callsign
    };
    let Some(callsign) = callsign else { return };

    let state = app.state::<PatProcess>();
    let mut guard = state.0.lock().expect("pat process mutex poisoned");
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    drop(guard); // reclaim below re-locks; avoid holding it across a sleep

    reclaim_orphaned_pat();
    // Give the OS a moment to actually free the port after the kill --
    // spawning immediately risked the same bind-error race this exists
    // to prevent.
    std::thread::sleep(Duration::from_millis(300));

    let mut guard = state.0.lock().expect("pat process mutex poisoned");

    let dir = pat_dir();
    let child = Command::new(binary)
        .arg("--mycall")
        .arg(callsign.to_uppercase())
        .arg("--config")
        .arg(dir.join("config.json"))
        .arg("--mbox")
        .arg(dir.join("mailbox"))
        .arg("--log")
        .arg(dir.join("pat.log"))
        .arg("http")
        .arg("--addr")
        .arg(HTTP_ADDR)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    if let Ok(child) = child {
        *guard = Some(child);
    }
}

#[tauri::command]
pub fn restart_winlink_service(app: AppHandle) {
    spawn_or_restart(&app);
}

/// The real Winlink module toggle (Settings > Modules) -- unlike
/// `db::set_mesh_enabled`/`set_rig_enabled`/`set_rotator_enabled`, which
/// only ever flip a column since none of those own a subprocess, this
/// actually stops or (re)starts the real `pat` process, so "off" is
/// honest, not just a poller that stops reporting on a process still
/// running in the background.
#[tauri::command]
pub fn set_winlink_enabled(app: AppHandle, enabled: bool) -> WinlinkStatus {
    {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        db::set_winlink_enabled_flag(&conn, enabled);
    }
    if enabled {
        spawn_or_restart(&app);
    } else {
        stop_pat(&app);
    }
    get_winlink_status(app)
}

/// Reports Winlink/Pat state into `source_health` on its own cadence.
///
/// Previously Pat's state was only ever computed while its panel was on
/// screen, so no other part of the app could see it — which is how an
/// orphaned Pat running `--mycall TEST` stayed invisible for three days.
/// Each failure mode gets a message that says what to do, not just what
/// broke, since the operator reading this may be a newcomer.
///
/// Reported as `Via::Rf`: Winlink's reason for existing is passing mail
/// without the internet.
pub fn spawn_health_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        let status = get_winlink_status(app.clone());
        let (health, detail) = if !status.enabled {
            (Status::Degraded, Some("Switched off in Settings.".to_string()))
        } else if !status.binary_found {
            (Status::Down, Some("Pat isn't installed. Install it to enable Winlink.".to_string()))
        } else if !status.callsign_configured {
            (Status::Down, Some("Set your callsign in Settings to enable Winlink.".to_string()))
        } else if status.foreign_process {
            (
                Status::Degraded,
                Some(
                    "A Pat that Waystation didn't start is using port 8778. It may be running \
                     under a different callsign. Press Restart Service to reclaim and replace it."
                        .to_string(),
                ),
            )
        } else if status.process_running && status.api_reachable {
            (Status::Healthy, None)
        } else {
            (Status::Down, Some("Pat isn't responding. Press Restart Service.".to_string()))
        };

        {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            connectivity::report_source_health(
                &conn,
                SOURCE_ID,
                "Winlink (Pat)",
                health,
                Via::Rf,
                detail.as_deref(),
            );
        }
        std::thread::sleep(HEALTH_POLL_INTERVAL);
    });
}
