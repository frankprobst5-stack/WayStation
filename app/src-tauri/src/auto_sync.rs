//! Automated background sync loop, decided 2026-09-04 -- the last open
//! piece of "Peer synchronization" from `ROADMAP.md`'s "The missing
//! shared operational core" section. `net_sync.rs` already has an
//! authenticated transport; `discovery.rs` already knows who's on the
//! LAN right now. What was still missing was purely "run this
//! automatically, on a schedule, without a click" -- and, per the
//! backlog note that named this item, a real explicit per-peer opt-in,
//! since trusting someone enough to click "Sync via Network" once is
//! not automatically the same as trusting them enough to sync with
//! unattended, every few minutes, forever.
//!
//! **Two independent gates, both required, every pass:**
//! 1. `trusted_peers.auto_sync` -- an operator decision, off by
//!    default even for an existing trusted peer (migration v39).
//! 2. Currently present in `discovery::DiscoveryState` -- being
//!    opted in is not permission to reach out to a stale address from
//!    an hour ago; this only ever acts on a station seen on the LAN
//!    *right now*, same "discovery tells you who's there, nothing
//!    more" principle `discovery.rs`'s own doc comment states.
//!
//! Every attempt, success or failure, lands in `AutoSyncState` and
//! fires an event -- this runs unattended, but it does not run
//! silently. An operator can always see exactly what happened and
//! when in the Peer Sync panel.

use crate::db::{self, Db, TrustedPeer};
use crate::discovery::{self, DiscoveredPeer, DiscoveryState};
use crate::net_sync;
use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// How often to check for opted-in, currently-discovered peers.
/// Deliberately not aggressive -- this is a LAN convenience loop, not
/// a latency-sensitive one, and every pass is a real authenticated TCP
/// connection to another operator's machine.
const POLL_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Bounded so a station left running for weeks doesn't grow this
/// forever -- recent activity is what an operator actually wants to
/// see, not a permanent audit log (that's what `delivery_attempts` and
/// `incident_events` are for, on the objects that actually matter).
const MAX_HISTORY: usize = 50;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "outcome")]
pub enum AutoSyncOutcome {
    Synced { inserted: usize, updated: usize, conflicts: usize },
    Failed { reason: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct AutoSyncRecord {
    pub callsign: String,
    pub attempted_at: i64,
    pub outcome: AutoSyncOutcome,
}

pub struct AutoSyncState(Mutex<Vec<AutoSyncRecord>>);

impl AutoSyncState {
    pub fn new() -> Self {
        AutoSyncState(Mutex::new(Vec::new()))
    }
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// The real decision logic, pulled out as a pure function specifically
/// so it's testable without a real mDNS browse or a real trusted-peer
/// database -- just two plain slices in, a list of connect targets
/// out. Matching is by callsign, case-insensitive (same normalization
/// `db::add_trusted_peer_conn` already applies on write), since a
/// discovered station's advertised callsign and a trusted-peer record
/// aren't guaranteed to share exact case.
fn eligible_peers(trusted: &[TrustedPeer], discovered: &[DiscoveredPeer]) -> Vec<(String, String, u16)> {
    trusted
        .iter()
        .filter(|p| p.auto_sync)
        .filter_map(|p| {
            discovered
                .iter()
                .find(|d| d.callsign.as_deref().map(|c| c.eq_ignore_ascii_case(&p.callsign)).unwrap_or(false))
                .map(|d| (p.callsign.clone(), d.host.clone(), d.port))
        })
        .collect()
}

fn record(state: &AutoSyncState, callsign: String, outcome: AutoSyncOutcome) {
    let mut history = state.0.lock().expect("auto_sync state mutex poisoned");
    history.push(AutoSyncRecord { callsign, attempted_at: now(), outcome });
    let len = history.len();
    if len > MAX_HISTORY {
        history.drain(0..len - MAX_HISTORY);
    }
}

fn run_one_pass(app: &AppHandle) {
    let trusted = db::get_trusted_peers(app.state::<Db>());
    let discovered = discovery::get_discovered_peers(app.state::<DiscoveryState>());
    let targets = eligible_peers(&trusted, &discovered);
    if targets.is_empty() {
        return;
    }
    let db = app.state::<Db>();
    let auto_sync_state = app.state::<AutoSyncState>();
    for (callsign, host, port) in targets {
        let outcome = {
            let conn = db.0.lock().expect("db mutex poisoned");
            match net_sync::sync_with_peer_conn(&conn, &host, port) {
                Ok(report) => AutoSyncOutcome::Synced { inserted: report.inserted.len(), updated: report.updated.len(), conflicts: report.conflicts.len() },
                Err(reason) => AutoSyncOutcome::Failed { reason },
            }
        };
        record(&auto_sync_state, callsign, outcome);
    }
    let _ = app.emit("auto-sync-changed", ());
}

pub fn spawn_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        run_one_pass(&app);
        std::thread::sleep(POLL_INTERVAL);
    });
}

#[tauri::command]
pub fn get_auto_sync_history(state: State<AutoSyncState>) -> Vec<AutoSyncRecord> {
    state.0.lock().expect("auto_sync state mutex poisoned").clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(callsign: &str, auto_sync: bool) -> TrustedPeer {
        TrustedPeer { id: 1, callsign: callsign.to_string(), shared_secret: "secret".to_string(), added_at: "2026-09-04T00:00:00Z".to_string(), notes: None, auto_sync }
    }

    fn discovered(callsign: Option<&str>, host: &str, port: u16) -> DiscoveredPeer {
        DiscoveredPeer { instance_name: format!("{host}._waystation._tcp.local."), callsign: callsign.map(str::to_string), host: host.to_string(), addresses: vec![], port, last_seen: 0 }
    }

    #[test]
    fn a_trusted_peer_not_opted_in_is_never_a_target_even_if_discovered() {
        let trusted = vec![peer("K7WSP", false)];
        let discovered = vec![discovered(Some("K7WSP"), "waystation-abc.local.", 51820)];
        assert!(eligible_peers(&trusted, &discovered).is_empty(), "auto_sync=false must never produce a sync target, no matter what's on the network");
    }

    #[test]
    fn an_opted_in_peer_not_currently_discovered_is_never_a_target() {
        let trusted = vec![peer("K7WSP", true)];
        let discovered: Vec<DiscoveredPeer> = vec![];
        assert!(eligible_peers(&trusted, &discovered).is_empty(), "opting in is not permission to reach a station that isn't actually seen on the network right now");
    }

    #[test]
    fn an_opted_in_and_discovered_peer_becomes_a_real_connect_target() {
        let trusted = vec![peer("K7WSP", true)];
        let discovered = vec![discovered(Some("K7WSP"), "waystation-abc.local.", 51820)];
        let targets = eligible_peers(&trusted, &discovered);
        assert_eq!(targets, vec![("K7WSP".to_string(), "waystation-abc.local.".to_string(), 51820)]);
    }

    #[test]
    fn callsign_matching_is_case_insensitive() {
        let trusted = vec![peer("k7wsp", true)];
        let discovered = vec![discovered(Some("K7WSP"), "waystation-abc.local.", 51820)];
        assert_eq!(eligible_peers(&trusted, &discovered).len(), 1);
    }

    #[test]
    fn a_discovered_station_with_no_callsign_never_matches_anyone() {
        let trusted = vec![peer("K7WSP", true)];
        let discovered = vec![discovered(None, "waystation-abc.local.", 51820)];
        assert!(eligible_peers(&trusted, &discovered).is_empty());
    }

    #[test]
    fn only_opted_in_peers_are_selected_out_of_a_mixed_list() {
        let trusted = vec![peer("K7WSP", true), peer("KJ4ESQ", false)];
        let discovered = vec![discovered(Some("K7WSP"), "host-a.local.", 51820), discovered(Some("KJ4ESQ"), "host-b.local.", 51820)];
        let targets = eligible_peers(&trusted, &discovered);
        assert_eq!(targets, vec![("K7WSP".to_string(), "host-a.local.".to_string(), 51820)]);
    }
}
