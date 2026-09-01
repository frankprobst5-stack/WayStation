//! POTA (Parks on the Air) activator spots.
//!
//! api.pota.app is a dedicated public JSON API — verified live before
//! building, no ToS block encountered, and third-party clients (visible
//! directly in the `source` field of real spot data: RBN, GridTracker,
//! Ham2K Portable Logger) already consume it openly. Contrast with SOTA,
//! whose terms explicitly forbid AI-written clients, and WWFF, whose
//! public "API" turned out to be a server-rendered HTML page — neither
//! is built here. See db.rs's v12 migration comment for the full story.

use crate::connectivity::{self, Status, Via};
use crate::db::{self, Db, IncomingPotaSpot};
use chrono::Utc;
use serde::Deserialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const SOURCE_ID: &str = "pota";
const FEED_URL: &str = "https://api.pota.app/spot/activator";
// POTA's own docs note the API "expects caching" — spots churn every few
// minutes in practice, so this stays well above their minimum interest.
const POLL_INTERVAL: Duration = Duration::from_secs(5 * 60);
const USER_AGENT: &str = "Waystation/0.1 (https://github.com/frankprobst5-stack/WayStation)";

#[derive(Deserialize)]
struct RawSpot {
    #[serde(rename = "spotId")]
    spot_id: i64,
    activator: String,
    frequency: Option<String>,
    mode: Option<String>,
    reference: String,
    name: Option<String>,
    #[serde(rename = "locationDesc")]
    location_desc: Option<String>,
    grid6: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    #[serde(rename = "spotTime")]
    spot_time: String,
    comments: Option<String>,
}

fn fetch_spots() -> Result<Vec<IncomingPotaSpot>, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let raw: Vec<RawSpot> = client
        .get(FEED_URL)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;

    Ok(raw
        .into_iter()
        .map(|s| {
            // POTA reports frequency in kHz as a string; the rest of this
            // app works in MHz (same convention as channels/band plan).
            let frequency_mhz = s.frequency.and_then(|f| f.parse::<f64>().ok()).map(|khz| khz / 1000.0);
            let spot_time = chrono::NaiveDateTime::parse_from_str(&s.spot_time, "%Y-%m-%dT%H:%M:%S")
                .map(|dt| dt.and_utc().to_rfc3339())
                .unwrap_or(s.spot_time);
            IncomingPotaSpot {
                spot_id: s.spot_id,
                activator: s.activator,
                frequency_mhz,
                mode: s.mode,
                reference: s.reference,
                park_name: s.name,
                location_desc: s.location_desc,
                grid: s.grid6,
                latitude: s.latitude,
                longitude: s.longitude,
                spot_time,
                comments: s.comments,
            }
        })
        .collect())
}

pub fn poll_once(app: &AppHandle) {
    match fetch_spots() {
        Ok(spots) => {
            let fetched_at = Utc::now().to_rfc3339();
            {
                let db = app.state::<Db>();
                let mut conn = db.0.lock().expect("db mutex poisoned");
                db::replace_pota_spots(&mut conn, SOURCE_ID, &fetched_at, &spots);
                connectivity::report_source_health(
                    &conn,
                    SOURCE_ID,
                    "POTA Activator Spots",
                    Status::Healthy,
                    Via::Internet,
                    None,
                );
            }
            let _ = app.emit("pota-spots-changed", ());
        }
        Err(detail) => {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            connectivity::report_source_health(
                &conn,
                SOURCE_ID,
                "POTA Activator Spots",
                Status::Down,
                Via::Internet,
                Some(&detail),
            );
        }
    }
}

pub fn spawn_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        if !connectivity::paused_for_offline(&app, SOURCE_ID, "POTA Activator Spots") {
            poll_once(&app);
        }
        std::thread::sleep(POLL_INTERVAL);
    });
}
