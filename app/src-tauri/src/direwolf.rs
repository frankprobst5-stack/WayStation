//! Direwolf (APRS/packet TNC) orchestration -- Planned backlog's
//! "APRS/packet radio via Direwolf" item, slice 1. Same "orchestrate,
//! don't reimplement" treatment already proven on Pat/JS8Call: WayStation
//! spawns a real `direwolf` process against a config file it generates,
//! and talks to it only enough to report health -- it does not
//! reimplement AX.25/KISS decoding here. Real AX.25/APRS packet parsing
//! and feeding decoded positions onto TacticalMapPanel.tsx as a new
//! source-tagged marker type is a deliberately separate, larger slice,
//! not started yet (see ROADMAP.md's Planned backlog).
//!
//! Unlike Pat, this is never auto-started at app launch. Direwolf opens
//! a real audio capture device the moment it runs -- even RX-only, with
//! no PTT configured, that's a live microphone, and turning one on
//! silently on every app launch (before an operator has confirmed audio
//! routing is even correct) would be a real, avoidable surprise. Start/
//! Stop is an explicit operator action from PacketPanel.tsx.
//!
//! Direwolf has no HTTP status API the way Pat does, so health here means
//! "is our process still alive" plus "does its AGW TCP port accept a
//! connection" -- a raw reachability probe, not a protocol handshake,
//! same technique connectivity.rs's own Phase 0 internet probe uses.
//! AGWPORT/KISSPORT are pinned to WayStation-owned ports (8010/8011)
//! rather than Direwolf's own defaults (8000/8001) -- confirmed live
//! before writing this (installed the real package, ran it with a
//! throwaway config) that Direwolf's KISS TCP listener binds its
//! hardcoded default 8001 *in addition to* whatever KISSPORT is set to,
//! an asymmetric quirk AGWPORT doesn't share. Pinning both to a pair
//! Direwolf never opens on its own avoids ever colliding with a real
//! 8000/8001 instance the operator might run by hand for something else.

use crate::connectivity::{self, Status, Via};
use crate::db::{self, Db};
use serde::Serialize;
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const AGW_PORT: u16 = 8010;
const KISS_PORT: u16 = 8011;
const SOURCE_ID: &str = "direwolf-aprs";
const HEALTH_POLL_INTERVAL: Duration = Duration::from_secs(30);

pub struct DirewolfProcess(pub Mutex<Option<Child>>);

fn direwolf_dir() -> PathBuf {
    let dir = db::data_dir().join("direwolf");
    std::fs::create_dir_all(&dir).expect("failed to create direwolf data directory");
    dir
}

/// Direwolf has no `version`-style subcommand that exits 0 -- confirmed
/// live that even `-h`/`--version` exit 1 after printing their banner,
/// unlike Pat's `pat version`. So existence is "did the OS find and run
/// the binary at all" (`.status()` returning `Ok`), never exit-status
/// success, which would wrongly report a real install as missing.
fn find_direwolf_binary() -> Option<PathBuf> {
    if Command::new("direwolf").arg("-h").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok() {
        return Some(PathBuf::from("direwolf"));
    }
    let candidates = [PathBuf::from("/usr/local/bin/direwolf"), PathBuf::from("/usr/bin/direwolf")];
    candidates.into_iter().find(|p| p.exists())
}

/// Pure so it's directly testable without spawning anything -- generates
/// the literal text written to direwolf.conf. `audio_device` of `None`
/// (or blank) omits the `ADEVICE` line entirely, letting Direwolf fall
/// back to its own default device rather than WayStation guessing one.
/// No PTT line: slice 1 is RX/status only, never transmits, so Direwolf
/// runs in its own documented VOX-fallback mode (a real, printed notice,
/// not an error) until a later slice adds PTT configuration.
fn build_config(callsign: &str, audio_device: Option<&str>) -> String {
    let mut out = String::new();
    out.push_str(&format!("MYCALL {}\n", callsign.trim().to_uppercase()));
    if let Some(device) = audio_device.map(str::trim).filter(|d| !d.is_empty()) {
        out.push_str(&format!("ADEVICE {device}\n"));
    }
    out.push_str(&format!("AGWPORT {AGW_PORT}\n"));
    out.push_str(&format!("KISSPORT {KISS_PORT}\n"));
    out
}

fn write_config(callsign: &str, audio_device: Option<&str>) -> PathBuf {
    let path = direwolf_dir().join("direwolf.conf");
    std::fs::write(&path, build_config(callsign, audio_device)).expect("failed to write direwolf.conf");
    path
}

fn tcp_reachable(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok()
}

#[derive(Debug, Serialize)]
pub struct DirewolfStatus {
    pub binary_found: bool,
    pub callsign_configured: bool,
    pub process_running: bool,
    pub agw_reachable: bool,
    pub kiss_reachable: bool,
}

#[tauri::command]
pub fn get_direwolf_status(app: AppHandle) -> DirewolfStatus {
    let binary_found = find_direwolf_binary().is_some();
    let callsign_configured = {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        db::station_profile(&conn).callsign.is_some()
    };
    // Same try_wait() reasoning as pat.rs: holding a Child handle isn't
    // the same as having a live process, since the handle stays Some
    // after the process exits until something reaps it.
    let process_running = {
        let state = app.state::<DirewolfProcess>();
        let mut guard = state.0.lock().expect("direwolf process mutex poisoned");
        match guard.as_mut().map(|child| child.try_wait()) {
            Some(Ok(None)) => true,
            Some(Ok(Some(_))) => {
                *guard = None;
                false
            }
            Some(Err(_)) | None => false,
        }
    };
    DirewolfStatus {
        binary_found,
        callsign_configured,
        process_running,
        agw_reachable: tcp_reachable(AGW_PORT),
        kiss_reachable: tcp_reachable(KISS_PORT),
    }
}

/// Spawns Direwolf with a freshly generated config, killing any prior
/// instance this station started first. Always an explicit operator
/// click (the Packet panel's Start button), so this returns a real
/// `Result` rather than silently no-op'ing the way Pat's background
/// `spawn_or_restart` does -- an operator pressing Start deserves to
/// know why nothing happened, not a panel that just stays gray.
#[tauri::command]
pub fn start_direwolf(app: AppHandle) -> Result<(), String> {
    let binary = find_direwolf_binary()
        .ok_or_else(|| "Direwolf isn't installed (checked PATH, /usr/bin, /usr/local/bin).".to_string())?;

    let (callsign, audio_device) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        let profile = db::station_profile(&conn);
        (profile.callsign, profile.direwolf_audio_device)
    };
    let callsign = callsign.ok_or_else(|| "Set your callsign in Settings first.".to_string())?;

    let state = app.state::<DirewolfProcess>();
    let mut guard = state.0.lock().expect("direwolf process mutex poisoned");
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }

    let config_path = write_config(&callsign, audio_device.as_deref());
    let child = Command::new(binary)
        .arg("-c")
        .arg(&config_path)
        .arg("-l")
        .arg(direwolf_dir())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to start direwolf: {e}"))?;

    *guard = Some(child);
    Ok(())
}

#[tauri::command]
pub fn stop_direwolf(app: AppHandle) {
    let state = app.state::<DirewolfProcess>();
    let mut guard = state.0.lock().expect("direwolf process mutex poisoned");
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Reports Direwolf state into `source_health` on its own cadence, same
/// reasoning as pat.rs/js8call.rs's pollers -- otherwise its state is
/// only ever known while the Packet panel is on screen. Unlike those
/// two, "not running" is this integration's normal resting state (never
/// auto-started), so that case is reported `Unknown`, not `Down` --
/// `Down` should mean "expected to be up and isn't," not "operator
/// hasn't pressed Start yet."
///
/// Reported as `Via::Aprs`, not `Via::Rf` -- see this module's own doc
/// comment and `Via::Aprs`'s in connectivity.rs for why the two are kept
/// distinct.
pub fn spawn_health_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        let status = get_direwolf_status(app.clone());
        let (health, detail) = if !status.binary_found {
            (Status::Down, Some("Direwolf isn't installed.".to_string()))
        } else if !status.process_running {
            (Status::Unknown, Some("Not running. Press Start on the Packet panel.".to_string()))
        } else if status.agw_reachable {
            (Status::Healthy, None)
        } else {
            (
                Status::Degraded,
                Some("Direwolf is running but its AGW port isn't responding yet.".to_string()),
            )
        };
        {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            connectivity::report_source_health(&conn, SOURCE_ID, "Direwolf (APRS/Packet)", health, Via::Aprs, detail.as_deref());
        }
        std::thread::sleep(HEALTH_POLL_INTERVAL);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_config_uppercases_and_trims_the_callsign() {
        let conf = build_config("  kj4esq-9  ", None);
        assert!(conf.contains("MYCALL KJ4ESQ-9\n"), "got: {conf:?}");
    }

    #[test]
    fn build_config_omits_adevice_when_not_configured() {
        let conf = build_config("KJ4ESQ", None);
        assert!(!conf.contains("ADEVICE"), "got: {conf:?}");
    }

    #[test]
    fn build_config_omits_adevice_for_a_blank_but_present_device_string() {
        // Mirrors the Station Identity form's own "".trim() -> None
        // convention -- a saved-but-blank field must behave exactly like
        // an unset one, not silently emit `ADEVICE ` with nothing after it.
        let conf = build_config("KJ4ESQ", Some("   "));
        assert!(!conf.contains("ADEVICE"), "got: {conf:?}");
    }

    #[test]
    fn build_config_includes_adevice_when_configured() {
        let conf = build_config("KJ4ESQ", Some("plughw:1,0"));
        assert!(conf.contains("ADEVICE plughw:1,0\n"), "got: {conf:?}");
    }

    #[test]
    fn build_config_always_pins_the_waystation_owned_agw_and_kiss_ports() {
        let conf = build_config("KJ4ESQ", None);
        assert!(conf.contains("AGWPORT 8010\n"), "got: {conf:?}");
        assert!(conf.contains("KISSPORT 8011\n"), "got: {conf:?}");
    }

    // -- Live integration check, not a unit test -------------------
    //
    // `#[ignore]`d because it needs the real `direwolf` binary actually
    // installed (confirmed live 2026-09-06: `apt install direwolf`,
    // version 1.8.1). Spawns the real process directly via `Command`,
    // bypassing the tauri `AppHandle`/`State` layer entirely -- same
    // approach mesh.rs's live tests use -- so this exercises
    // `find_direwolf_binary`, `build_config`, and `tcp_reachable`
    // against the real installed binary rather than a mock.
    #[test]
    #[ignore]
    fn starting_the_real_installed_direwolf_makes_its_agw_port_reachable() {
        let binary = find_direwolf_binary().expect("direwolf must be installed for this live test -- `sudo apt install direwolf`");
        let dir = std::env::temp_dir().join("waystation-direwolf-live-test");
        std::fs::create_dir_all(&dir).unwrap();
        let config_path = dir.join("direwolf.conf");
        std::fs::write(&config_path, build_config("N0CALL", None)).unwrap();

        assert!(!tcp_reachable(AGW_PORT), "AGW port was already open before this test started anything -- stale process from a prior run?");

        let mut child = Command::new(binary)
            .arg("-c")
            .arg(&config_path)
            .arg("-l")
            .arg(&dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn the real direwolf binary");

        let mut became_reachable = false;
        for _ in 0..40 {
            if tcp_reachable(AGW_PORT) {
                became_reachable = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }

        let _ = child.kill();
        let _ = child.wait();

        assert!(became_reachable, "real direwolf's AGW port on 8010 never became reachable within 10s");
        assert!(!tcp_reachable(AGW_PORT), "AGW port stayed open after killing the process");
    }
}
