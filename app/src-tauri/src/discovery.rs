//! mDNS/DNS-SD local peer discovery, decided 2026-09-03 (roadmap
//! reconciliation session).
//!
//! **Discovery only, never automatic sync** -- this is this document's
//! own second non-negotiable principle (see ROADMAP.md). This module's
//! entire job is answering "who else is running WayStation on this
//! LAN," nothing more. It never opens a data connection to anyone it
//! finds, never transfers an object, and never even implies a click
//! target that would. Moving data to a discovered peer stays exactly
//! what it already is -- an explicit, deliberate Export/Import through
//! the Peer Sync panel.
//!
//! Built on `mdns-sd`, chosen specifically because its core is
//! synchronous ("no async runtime dependency," per its own
//! description) -- same "no second concurrency model for one
//! integration" reasoning as `meshtastic` in Cargo.toml. Every other
//! transport in this codebase (Pat, JS8Call, DX cluster, mesh) is
//! std::thread + blocking I/O; this fits the same shape.

use crate::db::{self, Db};
use mdns_sd::{ResolvedService, ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::Serialize;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

const SERVICE_TYPE: &str = "_waystation._tcp.local.";

/// A station seen on the network, nothing more -- no capability to act
/// on this beyond looking at it. `last_seen` is a Unix timestamp so the
/// frontend can show "seen 2 minutes ago" honestly rather than implying
/// a live connection that doesn't exist.
#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredPeer {
    pub instance_name: String,
    pub callsign: Option<String>,
    pub host: String,
    pub addresses: Vec<String>,
    pub last_seen: i64,
}

pub struct DiscoveryState {
    peers: Mutex<Vec<DiscoveredPeer>>,
    last_change: AtomicI64,
}

impl DiscoveryState {
    pub fn new() -> Self {
        DiscoveryState { peers: Mutex::new(Vec::new()), last_change: AtomicI64::new(0) }
    }
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Builds this station's own advertisement. `port` is a nominal value,
/// not a live listening socket -- there is no WayStation network sync
/// server yet (file exchange is still the only real transport, see
/// sync.rs), so this purely announces presence and a callsign, laying
/// groundwork for a real sync-over-LAN transport later without
/// building one now.
fn build_service_info(callsign: Option<&str>) -> Result<ServiceInfo, String> {
    let hostname = format!("waystation-{}.local.", instance_suffix());
    let properties: Vec<(&str, &str)> = match callsign {
        Some(cs) => vec![("callsign", cs)],
        None => vec![],
    };
    ServiceInfo::new(SERVICE_TYPE, &instance_suffix(), &hostname, "", DISCOVERY_NOMINAL_PORT, &properties[..])
        .map_err(|e| e.to_string())
        .map(|info| info.enable_addr_auto())
}

/// A stable-per-process suffix so this station's own advertisement
/// doesn't collide with another real WayStation instance's on the same
/// LAN, and so re-registering after a callsign change is a clean
/// replace rather than a duplicate.
fn instance_suffix() -> String {
    use std::sync::OnceLock;
    static SUFFIX: OnceLock<String> = OnceLock::new();
    SUFFIX.get_or_init(|| uuid::Uuid::new_v4().simple().to_string()[..8].to_string()).clone()
}

const DISCOVERY_NOMINAL_PORT: u16 = 51820;

/// Advertises this station on the LAN. Runs for the life of the app;
/// re-advertises are handled by `mdns-sd` itself (responds to queries
/// as they arrive), so this just needs to register once and hold the
/// daemon alive.
pub fn spawn_advertiser(app: AppHandle) {
    std::thread::spawn(move || {
        let mdns = match ServiceDaemon::new() {
            Ok(d) => d,
            Err(e) => {
                eprintln!("discovery: could not start mDNS daemon for advertising: {e}");
                return;
            }
        };
        let callsign = {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            db::station_profile(&conn).callsign
        };
        match build_service_info(callsign.as_deref()) {
            Ok(info) => {
                if let Err(e) = mdns.register(info) {
                    eprintln!("discovery: could not register mDNS advertisement: {e}");
                }
            }
            Err(e) => eprintln!("discovery: could not build mDNS advertisement: {e}"),
        }
        // Keep the daemon (and this thread) alive for the app's
        // lifetime -- dropping ServiceDaemon tears down advertising.
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3600));
        }
    });
}

/// Browses for other WayStation instances. Purely observational: adds/
/// refreshes/removes entries in `DiscoveryState`, emits an event the
/// frontend listens for, never touches the database beyond reading the
/// callsign once at advertise time, never opens a connection to
/// anything it finds.
pub fn spawn_browser(app: AppHandle) {
    std::thread::spawn(move || {
        let mdns = match ServiceDaemon::new() {
            Ok(d) => d,
            Err(e) => {
                eprintln!("discovery: could not start mDNS daemon for browsing: {e}");
                return;
            }
        };
        let receiver = match mdns.browse(SERVICE_TYPE) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("discovery: could not browse for peers: {e}");
                return;
            }
        };
        while let Ok(event) = receiver.recv() {
            let state = app.state::<DiscoveryState>();
            let mut peers = state.peers.lock().expect("discovery state mutex poisoned");
            match event {
                ServiceEvent::ServiceResolved(info) => {
                    upsert_peer(&mut peers, &info);
                }
                ServiceEvent::ServiceRemoved(_, fullname) => {
                    peers.retain(|p| p.instance_name != fullname);
                }
                _ => continue,
            }
            drop(peers);
            state.last_change.store(now(), Ordering::SeqCst);
            let _ = app.emit("discovered-peers-changed", ());
        }
    });
}

fn upsert_peer(peers: &mut Vec<DiscoveredPeer>, info: &ResolvedService) {
    let callsign = info.get_property_val_str("callsign").map(|s| s.to_string());
    let peer = DiscoveredPeer {
        instance_name: info.get_fullname().to_string(),
        callsign,
        host: info.get_hostname().to_string(),
        addresses: info.get_addresses().iter().map(|a| a.to_string()).collect(),
        last_seen: now(),
    };
    match peers.iter_mut().find(|p| p.instance_name == peer.instance_name) {
        Some(existing) => *existing = peer,
        None => peers.push(peer),
    }
}

#[tauri::command]
pub fn get_discovered_peers(state: State<DiscoveryState>) -> Vec<DiscoveredPeer> {
    state.peers.lock().expect("discovery state mutex poisoned").clone()
}

#[cfg(test)]
mod tests {
    //! -- Real, non-ignored, because this only needs loopback --
    //!
    //! Unlike mesh.rs's live tests (need a real meshtasticd running) or
    //! transport.rs's (need real Pat/JS8Call sessions), this one only
    //! needs multicast on the local machine -- one process advertising,
    //! the same process browsing, over loopback. No external service,
    //! no operator setup. If this doesn't pass, mDNS genuinely doesn't
    //! work in whatever environment it's run in, which is itself
    //! important to know before shipping the feature on top of it.
    use super::*;

    #[test]
    fn advertising_and_browsing_in_the_same_process_finds_each_other() {
        let advertiser = ServiceDaemon::new().expect("failed to start advertiser daemon");
        let info = build_service_info(Some("KJ4ESQ")).expect("failed to build service info");
        advertiser.register(info).expect("failed to register advertisement");

        let browser = ServiceDaemon::new().expect("failed to start browser daemon");
        let receiver = browser.browse(SERVICE_TYPE).expect("failed to browse");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        let mut found_callsign = None;
        while std::time::Instant::now() < deadline {
            if let Ok(event) = receiver.recv_timeout(std::time::Duration::from_secs(1)) {
                if let ServiceEvent::ServiceResolved(resolved) = event {
                    found_callsign = resolved.get_property_val_str("callsign").map(|s| s.to_string());
                    break;
                }
            }
        }

        let _ = advertiser.shutdown();
        let _ = browser.shutdown();

        assert_eq!(found_callsign.as_deref(), Some("KJ4ESQ"), "browser must resolve the advertiser's service and read its callsign back within 15s");
    }
}
