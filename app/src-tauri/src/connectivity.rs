//! Connectivity state machine (ROADMAP Phase 0).
//!
//! Overall state is derived from per-source health, not tracked directly:
//! any source with `via = internet` healthy means ONLINE; none healthy but
//! one degraded means DEGRADED; otherwise RF-ONLY — the app has fallen back
//! to whatever mesh/RF/manual data it has, which is the normal operating
//! mode this whole project exists for, not an error state.
//!
//! Phase 1+ ingest workers (NOAA SWPC, DX cluster, AREDN sysinfo, ...) each
//! report their own health here via `report_source_health`. Phase 0 wires
//! up exactly one source — a raw TCP reachability probe — to prove the
//! machine reacts to a real unplugged cable instead of a stub.

use crate::db::Db;
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Healthy,
    Degraded,
    Down,
    Unknown,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Status::Healthy => "healthy",
            Status::Degraded => "degraded",
            Status::Down => "down",
            Status::Unknown => "unknown",
        }
    }

    fn from_str(s: &str) -> Status {
        match s {
            "healthy" => Status::Healthy,
            "degraded" => Status::Degraded,
            "down" => Status::Down,
            _ => Status::Unknown,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Via {
    Internet,
    Mesh,
    Rf,
    Manual,
}

impl Via {
    fn as_str(self) -> &'static str {
        match self {
            Via::Internet => "internet",
            Via::Mesh => "mesh",
            Via::Rf => "rf",
            Via::Manual => "manual",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceHealth {
    pub source_id: String,
    pub label: String,
    pub status: String,
    pub via: String,
    pub last_success_at: Option<String>,
    pub last_attempt_at: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OverallState {
    Online,
    Degraded,
    RfOnly,
    /// The operator switched the internet off deliberately. Kept distinct
    /// from RfOnly on purpose: showing a manual choice as though the
    /// network had failed would be the app telling a small lie about its
    /// own state, in the one component whose entire job is reporting that
    /// state honestly.
    OfflineManual,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectivitySnapshot {
    pub overall: OverallState,
    pub sources: Vec<SourceHealth>,
}

/// True when the operator has switched Waystation off the internet.
///
/// Deliberately scoped to *internet* sources. "Offline" for a ham
/// dashboard cannot mean "stop all communication" — the whole premise is
/// that mesh and RF keep working when the internet doesn't, so the mesh
/// client, Pat, JS8Call and rig control are untouched by this.
pub fn manual_offline(conn: &rusqlite::Connection) -> bool {
    crate::db::station_profile(conn).manual_offline
}

pub fn is_manual_offline(app: &AppHandle) -> bool {
    let db = app.state::<crate::db::Db>();
    let conn = db.0.lock().expect("db mutex poisoned");
    manual_offline(&conn)
}


/// Returns true when the operator has switched Waystation offline, and
/// records that as this source's reason for not updating.
///
/// Reporting it rather than silently skipping matters: a paused source
/// that still showed `healthy` from an hour ago would be the app implying
/// data is current when it has stopped looking. Degraded-with-a-reason
/// says what is actually true, and Diagnostics shows it.
pub fn paused_for_offline(app: &AppHandle, source_id: &str, label: &str) -> bool {
    if !is_manual_offline(app) {
        return false;
    }
    let db = app.state::<crate::db::Db>();
    let conn = db.0.lock().expect("db mutex poisoned");
    report_source_health(
        &conn,
        source_id,
        label,
        Status::Degraded,
        Via::Internet,
        Some("Paused — Waystation is switched offline by the operator."),
    );
    true
}

fn compute_overall(sources: &[SourceHealth], offline: bool) -> OverallState {
    if offline {
        return OverallState::OfflineManual;
    }
    let internet_sources = sources.iter().filter(|s| s.via == "internet");
    let mut any_healthy = false;
    let mut any_degraded = false;
    for s in internet_sources {
        match Status::from_str(&s.status) {
            Status::Healthy => any_healthy = true,
            Status::Degraded => any_degraded = true,
            _ => {}
        }
    }
    if any_healthy {
        OverallState::Online
    } else if any_degraded {
        OverallState::Degraded
    } else {
        OverallState::RfOnly
    }
}

pub fn report_source_health(
    conn: &rusqlite::Connection,
    source_id: &str,
    label: &str,
    status: Status,
    via: Via,
    detail: Option<&str>,
) {
    let now = Utc::now().to_rfc3339();
    let last_success_at: Option<String> = if status == Status::Healthy {
        Some(now.clone())
    } else {
        conn.query_row(
            "SELECT last_success_at FROM source_health WHERE source_id = ?1",
            params![source_id],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
    };

    conn.execute(
        "INSERT INTO source_health (source_id, label, status, via, last_success_at, last_attempt_at, detail)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(source_id) DO UPDATE SET
            label = excluded.label,
            status = excluded.status,
            via = excluded.via,
            last_success_at = excluded.last_success_at,
            last_attempt_at = excluded.last_attempt_at,
            detail = excluded.detail",
        params![source_id, label, status.as_str(), via.as_str(), last_success_at, now, detail],
    )
    .expect("failed to write source_health");
}

pub fn snapshot(conn: &rusqlite::Connection) -> ConnectivitySnapshot {
    let mut stmt = conn
        .prepare("SELECT source_id, label, status, via, last_success_at, last_attempt_at, detail FROM source_health ORDER BY source_id")
        .expect("failed to prepare source_health query");
    let sources: Vec<SourceHealth> = stmt
        .query_map([], |row| {
            Ok(SourceHealth {
                source_id: row.get(0)?,
                label: row.get(1)?,
                status: row.get(2)?,
                via: row.get(3)?,
                last_success_at: row.get(4)?,
                last_attempt_at: row.get(5)?,
                detail: row.get(6)?,
            })
        })
        .expect("failed to query source_health")
        .filter_map(Result::ok)
        .collect();

    let overall = compute_overall(&sources, manual_offline(conn));
    ConnectivitySnapshot { overall, sources }
}

/// Raw TCP reachability probe — the Phase 0 stand-in for a real ingest
/// worker. Deliberately not an HTTP client: Phase 0 has no HTTP dependency
/// yet, and "can I open a socket to a well-known host" is enough to prove
/// the state machine responds to a real unplugged cable.
fn probe_internet() -> (Status, Option<String>) {
    let target = "1.1.1.1:443";
    match target.to_socket_addrs() {
        Ok(mut addrs) => match addrs.next() {
            Some(addr) => match TcpStream::connect_timeout(&addr, Duration::from_secs(3)) {
                Ok(_) => (Status::Healthy, None),
                Err(e) => (Status::Down, Some(e.to_string())),
            },
            None => (Status::Down, Some("no address resolved".into())),
        },
        Err(e) => (Status::Down, Some(e.to_string())),
    }
}

const POLL_INTERVAL: Duration = Duration::from_secs(10);

/// Runs one reachability probe and reports it. Shared by the background
/// poller and `prepare_for_offline`'s on-demand check.
pub fn poll_once(app: &AppHandle) {
    // The reachability probe is itself an outbound connection, so it has
    // to stand down too — otherwise "offline" would still be talking to
    // the network, which is exactly the kind of quiet dishonesty this
    // toggle exists to let people test for.
    let (status, detail) = if is_manual_offline(app) {
        (Status::Degraded, Some("Waystation is switched offline by the operator.".to_string()))
    } else {
        probe_internet()
    };
    {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        report_source_health(
            &conn,
            "internet-reachability",
            "Internet reachability",
            status,
            Via::Internet,
            detail.as_deref(),
        );
    }
    let snap = get_snapshot(app);
    let _ = app.emit("connectivity-changed", &snap);
}

pub fn spawn_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        poll_once(&app);
        std::thread::sleep(POLL_INTERVAL);
    });
}

pub fn get_snapshot(app: &AppHandle) -> ConnectivitySnapshot {
    let db = app.state::<Db>();
    let conn = db.0.lock().expect("db mutex poisoned");
    snapshot(&conn)
}

#[tauri::command]
pub fn get_connectivity_state(app: AppHandle) -> ConnectivitySnapshot {
    get_snapshot(&app)
}


#[tauri::command]
pub fn get_manual_offline(app: AppHandle) -> bool {
    is_manual_offline(&app)
}

/// Flips the manual offline switch and immediately re-publishes
/// connectivity, so the badge reflects the operator's choice at once
/// rather than at the next poll tick.
#[tauri::command]
pub fn set_manual_offline(app: AppHandle, offline: bool) {
    {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        conn.execute(
            "UPDATE station_profile SET manual_offline = ?1 WHERE id = 1",
            params![offline as i64],
        )
        .expect("failed to update manual_offline");
        // A profile row may not exist yet on a first run.
        if conn.query_row("SELECT COUNT(*) FROM station_profile WHERE id = 1", [], |r| r.get::<_, i64>(0))
            .unwrap_or(0)
            == 0
        {
            conn.execute(
                "INSERT INTO station_profile (id, manual_offline, updated_at) VALUES (1, ?1, ?2)",
                params![offline as i64, Utc::now().to_rfc3339()],
            )
            .expect("failed to create station_profile for manual_offline");
        }
    }
    poll_once(&app);
}
