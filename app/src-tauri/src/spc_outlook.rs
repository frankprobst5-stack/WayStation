//! Storm Prediction Center Day 1 convective outlook, decided 2026-09-25 --
//! second of the four real NWS map products named in a storm-chaser field
//! tester's request (2026-09-16, this project's own ROADMAP.md), after the
//! NWS alert-polygon layer.
//!
//! Real, free, keyless, government-source GeoJSON, same standing as
//! api.weather.gov (already used for NWS alerts/forecast) -- verified live
//! before writing this: `GET
//! https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson`
//! returns a real `FeatureCollection` whose properties already carry SPC's
//! own `fill`/`stroke` hex colors per risk category (e.g. `"LABEL":"TSTM"`,
//! `"fill":"#C1E9C1"`, `"stroke":"#55BB55"`) -- stored and drawn as-is on
//! the map rather than re-deriving a color scheme, so what WayStation shows
//! matches SPC's own real convention exactly.
//!
//! A national product, not a per-station point query -- unlike alerts.rs's
//! `?point=lat,lon` fetch, this is the same one small FeatureCollection for
//! every station, so there's no lat/lon parameter here at all.

use crate::connectivity::{self, Status, Via};
use crate::db::{self, Db, IncomingSpcOutlookArea};
use chrono::Utc;
use serde::Deserialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const SOURCE_ID: &str = "spc-outlook-day1";
const OUTLOOK_URL: &str = "https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson";
// SPC issues/updates the Day 1 outlook a handful of times per day (roughly
// 0600/1300/1630/2000 UTC) -- 30 minutes is comfortably frequent without
// hammering a free government feed, same cadence this app already uses for
// space_weather.rs's similarly slow-changing N0NBH feed.
const POLL_INTERVAL: Duration = Duration::from_secs(30 * 60);
const USER_AGENT: &str = "Waystation/0.1 (https://github.com/frankprobst5-stack/WayStation)";

#[derive(Debug, Deserialize)]
struct OutlookResponse {
    features: Vec<OutlookFeature>,
}

#[derive(Debug, Deserialize)]
struct OutlookFeature {
    geometry: serde_json::Value,
    properties: OutlookProperties,
}

#[derive(Debug, Deserialize)]
struct OutlookProperties {
    #[serde(rename = "DN")]
    dn: i64,
    #[serde(rename = "LABEL")]
    label: String,
    #[serde(rename = "LABEL2")]
    label2: String,
    fill: String,
    stroke: String,
    #[serde(rename = "VALID_ISO")]
    valid_iso: Option<String>,
    #[serde(rename = "EXPIRE_ISO")]
    expire_iso: Option<String>,
    #[serde(rename = "ISSUE_ISO")]
    issue_iso: Option<String>,
}

/// Pure so the real shape (SPC's own fill/stroke passed straight through,
/// geometry captured rather than discarded) is directly testable against a
/// real captured response, same reasoning `nws::parse_alert_features` is
/// its own function.
fn parse_outlook_features(features: Vec<OutlookFeature>) -> Vec<IncomingSpcOutlookArea> {
    features
        .into_iter()
        .map(|f| IncomingSpcOutlookArea {
            dn: f.properties.dn,
            label: f.properties.label,
            label2: f.properties.label2,
            fill: f.properties.fill,
            stroke: f.properties.stroke,
            valid: f.properties.valid_iso,
            expire: f.properties.expire_iso,
            issue: f.properties.issue_iso,
            geometry_json: serde_json::to_string(&f.geometry).unwrap_or_default(),
        })
        .collect()
}

fn fetch_outlook() -> Result<Vec<IncomingSpcOutlookArea>, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(OUTLOOK_URL)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;

    let body: OutlookResponse = resp.json().map_err(|e| e.to_string())?;
    Ok(parse_outlook_features(body.features))
}

pub fn poll_once(app: &AppHandle) {
    match fetch_outlook() {
        Ok(areas) => {
            let fetched_at = Utc::now().to_rfc3339();
            {
                let db = app.state::<Db>();
                let mut conn = db.0.lock().expect("db mutex poisoned");
                db::replace_spc_outlook(&mut conn, SOURCE_ID, &fetched_at, &areas);
                connectivity::report_source_health(
                    &conn,
                    SOURCE_ID,
                    "SPC Convective Outlook",
                    Status::Healthy,
                    Via::Internet,
                    None,
                );
            }
            let _ = app.emit("spc-outlook-changed", ());
        }
        Err(detail) => {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            connectivity::report_source_health(
                &conn,
                SOURCE_ID,
                "SPC Convective Outlook",
                Status::Down,
                Via::Internet,
                Some(&detail),
            );
        }
    }
}

pub fn spawn_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        if !connectivity::paused_for_offline(&app, SOURCE_ID, "SPC Convective Outlook") {
            poll_once(&app);
        }
        std::thread::sleep(POLL_INTERVAL);
    });
}

#[cfg(test)]
mod tests {
    //! Pure parsing test against a real captured spc.noaa.gov response --
    //! no live network needed, same discipline as nws.rs's alert tests.
    use super::*;

    // Captured live, 2026-09-25, from a real
    // `GET https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson`
    // request -- not hand-invented. Coordinates trimmed to a small real
    // ring; SPC's own fill/stroke/label values are verbatim.
    const REAL_CAPTURED_OUTLOOK: &str = r##"{
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "geometry": {"type": "MultiPolygon", "coordinates": [[[[-108.7, 31.63], [-108.59, 32.39], [-108.6, 32.69], [-108.7, 31.63]]]]},
            "properties": {
                "DN": 2,
                "VALID": "202609251630",
                "EXPIRE": "202609261200",
                "ISSUE": "202609251609",
                "VALID_ISO": "2026-09-25T16:30:00+00:00",
                "EXPIRE_ISO": "2026-09-26T12:00:00+00:00",
                "ISSUE_ISO": "2026-09-25T16:09:00+00:00",
                "FORECASTER": "Leitman/Chalmers",
                "LABEL": "TSTM",
                "LABEL2": "General Thunderstorms Risk",
                "stroke": "#55BB55",
                "fill": "#C1E9C1"
            }
        }]
    }"##;

    #[test]
    fn parse_outlook_features_reads_the_real_spc_shape() {
        let body: OutlookResponse = serde_json::from_str(REAL_CAPTURED_OUTLOOK).unwrap();
        let parsed = parse_outlook_features(body.features);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].dn, 2);
        assert_eq!(parsed[0].label, "TSTM");
        assert_eq!(parsed[0].label2, "General Thunderstorms Risk");
        assert_eq!(parsed[0].fill, "#C1E9C1");
        assert_eq!(parsed[0].stroke, "#55BB55");
        assert_eq!(parsed[0].valid.as_deref(), Some("2026-09-25T16:30:00+00:00"));

        let geometry: serde_json::Value = serde_json::from_str(&parsed[0].geometry_json).unwrap();
        assert_eq!(geometry["type"], "MultiPolygon");
    }

    #[test]
    fn parse_outlook_features_handles_an_empty_feature_collection() {
        // A real, observed case on a genuinely quiet weather day (verified
        // live: an "area=OK" query with no active outlook returned zero
        // features) -- must produce an empty list, not an error.
        let body: OutlookResponse = serde_json::from_str(r#"{"type":"FeatureCollection","features":[]}"#).unwrap();
        assert!(parse_outlook_features(body.features).is_empty());
    }
}
