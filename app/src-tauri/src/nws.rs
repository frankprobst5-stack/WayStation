//! NWS active alerts ingest (Phase 1 EmComm core).
//!
//! Deliberately blocking + std::thread, matching connectivity.rs's poller,
//! rather than pulling in an async runtime for a second concurrency model.
//!
//! Polygons aren't fetched yet — this is text-only (event, severity,
//! headline, description, area, effective/expires). Drawing alert polygons
//! on WorldMapPanel is a natural follow-up, not required for the first
//! usable version of this feature.

use crate::connectivity::{self, Status, Via};
use crate::db::{self, Db, IncomingAlert};
use crate::maidenhead::grid_square_to_lat_lon;
use chrono::Utc;
use serde::Deserialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const SOURCE_ID: &str = "nws-alerts";
const POLL_INTERVAL: Duration = Duration::from_secs(5 * 60); // NWS asks clients not to poll more often
const USER_AGENT: &str = "Waystation/0.1 (https://github.com/frankprobst5-stack/WayStation)";

#[derive(Debug, Deserialize)]
struct AlertsResponse {
    features: Vec<AlertFeature>,
}

#[derive(Debug, Deserialize)]
struct AlertFeature {
    id: String,
    properties: AlertProperties,
}

#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AlertProperties {
    event: String,
    severity: String,
    headline: Option<String>,
    description: Option<String>,
    area_desc: Option<String>,
    effective: Option<String>,
    expires: Option<String>,
}

fn fetch_active_alerts(lat: f64, lon: f64) -> Result<Vec<IncomingAlert>, String> {
    let url = format!("https://api.weather.gov/alerts/active?point={lat:.4}%2C{lon:.4}");
    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&url)
        .header("Accept", "application/geo+json")
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;

    let body: AlertsResponse = resp.json().map_err(|e| e.to_string())?;

    Ok(body
        .features
        .into_iter()
        .map(|f| {
            let raw_json = serde_json::to_string(&f.properties).unwrap_or_default();
            let p = f.properties;
            IncomingAlert {
                id: f.id,
                event: p.event,
                severity: p.severity,
                headline: p.headline,
                description: p.description,
                area_desc: p.area_desc,
                effective: p.effective,
                expires: p.expires,
                raw_json,
            }
        })
        .collect())
}

/// Runs one alerts fetch and reports it. Shared by the background poller
/// and `prepare_for_offline`'s on-demand check. No-ops if no grid square is
/// configured yet.
pub fn poll_once(app: &AppHandle) {
    let point = {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        db::station_profile(&conn)
            .grid_square
            .and_then(|g| grid_square_to_lat_lon(&g))
    };

    if let Some((lat, lon)) = point {
        match fetch_active_alerts(lat, lon) {
            Ok(alerts) => {
                let fetched_at = Utc::now().to_rfc3339();
                {
                    let db = app.state::<Db>();
                    let mut conn = db.0.lock().expect("db mutex poisoned");
                    db::replace_alerts(&mut conn, SOURCE_ID, &fetched_at, &alerts);
                    connectivity::report_source_health(
                        &conn,
                        SOURCE_ID,
                        "NWS Active Alerts",
                        Status::Healthy,
                        Via::Internet,
                        None,
                    );
                }
                let _ = app.emit("alerts-changed", ());
            }
            Err(detail) => {
                let db = app.state::<Db>();
                let conn = db.0.lock().expect("db mutex poisoned");
                connectivity::report_source_health(
                    &conn,
                    SOURCE_ID,
                    "NWS Active Alerts",
                    Status::Down,
                    Via::Internet,
                    Some(&detail),
                );
            }
        }
    }
}

pub fn spawn_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        if !connectivity::paused_for_offline(&app, SOURCE_ID, "NWS Active Alerts") {
            poll_once(&app);
        }
        std::thread::sleep(POLL_INTERVAL);
    });
}
