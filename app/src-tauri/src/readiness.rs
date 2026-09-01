//! "Prepare for offline" (ROADMAP Phase 1): forces an immediate poll of
//! every network source and reports what's actually in the local store
//! right now, so an operator heading into a drill or a forecast outage can
//! confirm things are current before losing the connection that would let
//! them fix a gap.

use crate::connectivity::{self, ConnectivitySnapshot};
use crate::db::{self, Db};
use crate::nws;
use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize)]
pub struct ReadinessReport {
    pub connectivity: ConnectivitySnapshot,
    pub station_configured: bool,
    pub alerts_count: i64,
    pub messages_count: i64,
    pub roster_count: i64,
    pub resources_count: i64,
    pub checked_at: String,
}

#[tauri::command]
pub fn prepare_for_offline(app: AppHandle) -> ReadinessReport {
    // Topping up caches is the whole point of this button, so it has to
    // reach the network — but only if the operator hasn't deliberately
    // switched that off. Quietly fetching anyway would override an
    // explicit instruction; quietly doing nothing would let someone think
    // they were topped up when they weren't. So: skip, and say so.
    if !connectivity::is_manual_offline(&app) {
        connectivity::poll_once(&app);
        nws::poll_once(&app);
    }

    let db = app.state::<Db>();
    let conn = db.0.lock().expect("db mutex poisoned");

    let station_configured = db::station_profile(&conn).grid_square.is_some();
    let count = |table: &str| -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
            .unwrap_or(0)
    };

    ReadinessReport {
        connectivity: connectivity::snapshot(&conn),
        station_configured,
        alerts_count: count("alerts"),
        messages_count: count("messages"),
        roster_count: count("net_roster"),
        resources_count: count("resources"),
        checked_at: chrono::Utc::now().to_rfc3339(),
    }
}
