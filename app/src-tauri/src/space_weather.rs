//! Space weather ingest. Built ahead of its nominal Phase 4 slot because,
//! like Phase 1's NWS alerts, it's pure HTTP ingest that needs no hardware.
//!
//! Source: N0NBH's hamqsl.com solarxml.php feed — the same one HamClock and
//! OpenHamClock use. Updates roughly every 3 hours per the source itself;
//! polled here every 30 minutes, comfortably within that and reasonable
//! for a free community-run feed. Field parsing was written against the
//! real live feed, not assumed from memory: notably the feed itself
//! spells the electron-flux tag `<electonflux>` (missing the "r"), a
//! long-standing quirk on N0NBH's end that must be matched exactly.

use crate::connectivity::{self, Status, Via};
use crate::db::{self, Db, SpaceWeather};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const SOURCE_ID: &str = "n0nbh-solar";
const FEED_URL: &str = "https://www.hamqsl.com/solarxml.php";
// Official NOAA/SWPC scales feed — same government-source standing as
// api.weather.gov (already used for NWS alerts), not a third-party
// aggregator, so no access-control questions apply here.
const NOAA_SCALES_URL: &str = "https://services.swpc.noaa.gov/products/noaa-scales.json";
const POLL_INTERVAL: Duration = Duration::from_secs(30 * 60);
const USER_AGENT: &str = "Waystation/0.1 (https://github.com/frankprobst5-stack/WayStation)";

fn text_of(doc: &roxmltree::Document, tag: &str) -> Option<String> {
    doc.descendants()
        .find(|n| n.has_tag_name(tag))
        .and_then(|n| n.text())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[derive(Serialize)]
struct BandCondition {
    name: String,
    time: String,
    condition: String,
}

fn parse_band_conditions(doc: &roxmltree::Document) -> Option<String> {
    let container = doc.descendants().find(|n| n.has_tag_name("calculatedconditions"))?;
    let conditions: Vec<BandCondition> = container
        .children()
        .filter(|n| n.has_tag_name("band"))
        .filter_map(|n| {
            Some(BandCondition {
                name: n.attribute("name")?.to_string(),
                time: n.attribute("time")?.to_string(),
                condition: n.text()?.trim().to_string(),
            })
        })
        .collect();
    if conditions.is_empty() {
        None
    } else {
        serde_json::to_string(&conditions).ok()
    }
}

#[derive(Deserialize)]
struct NoaaScaleValue {
    #[serde(rename = "Scale")]
    scale: Option<String>,
    #[serde(rename = "Text")]
    text: Option<String>,
}

#[derive(Deserialize)]
struct NoaaScaleEntry {
    #[serde(rename = "R")]
    r: NoaaScaleValue,
    #[serde(rename = "S")]
    s: NoaaScaleValue,
    #[serde(rename = "G")]
    g: NoaaScaleValue,
}

struct NoaaScales {
    r_scale: Option<i64>,
    r_text: Option<String>,
    s_scale: Option<i64>,
    s_text: Option<String>,
    g_scale: Option<i64>,
    g_text: Option<String>,
}

/// The "0" entry is today's current scale; other keys ("1", "2", "3",
/// "-1"...) are forecast/historical days, not surfaced yet.
fn fetch_noaa_scales() -> Result<NoaaScales, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let entries: HashMap<String, NoaaScaleEntry> = client
        .get(NOAA_SCALES_URL)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;

    let current = entries.get("0").ok_or("no \"0\" (current) entry in NOAA scales response")?;
    Ok(NoaaScales {
        r_scale: current.r.scale.as_ref().and_then(|s| s.parse::<i64>().ok()),
        r_text: current.r.text.clone(),
        s_scale: current.s.scale.as_ref().and_then(|s| s.parse::<i64>().ok()),
        s_text: current.s.text.clone(),
        g_scale: current.g.scale.as_ref().and_then(|s| s.parse::<i64>().ok()),
        g_text: current.g.text.clone(),
    })
}

fn fetch_space_weather() -> Result<SpaceWeather, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let body = client
        .get(FEED_URL)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .map_err(|e| e.to_string())?;

    let doc = roxmltree::Document::parse(&body).map_err(|e| e.to_string())?;
    let parse_int = |tag: &str| text_of(&doc, tag).and_then(|s| s.parse::<i64>().ok());
    let parse_float = |tag: &str| text_of(&doc, tag).and_then(|s| s.parse::<f64>().ok());
    let band_conditions = parse_band_conditions(&doc);

    // NOAA scales come from a separate feed — a failure there shouldn't
    // sink the whole N0NBH fetch, since it's a bonus field, not core data.
    let scales = fetch_noaa_scales().ok();

    Ok(SpaceWeather {
        fetched_at: None, // set by the caller at save time
        updated_label: text_of(&doc, "updated"),
        solar_flux: parse_int("solarflux"),
        a_index: parse_int("aindex"),
        k_index: parse_int("kindex"),
        sunspots: parse_int("sunspots"),
        xray: text_of(&doc, "xray"),
        proton_flux: parse_int("protonflux"),
        electron_flux: parse_int("electonflux"), // sic — matches the real feed
        aurora: parse_int("aurora"),
        solar_wind: parse_float("solarwind"),
        magnetic_field: parse_float("magneticfield"),
        geomag_field: text_of(&doc, "geomagfield"),
        signal_noise: text_of(&doc, "signalnoise"),
        band_conditions,
        r_scale: scales.as_ref().and_then(|s| s.r_scale),
        r_text: scales.as_ref().and_then(|s| s.r_text.clone()),
        s_scale: scales.as_ref().and_then(|s| s.s_scale),
        s_text: scales.as_ref().and_then(|s| s.s_text.clone()),
        g_scale: scales.as_ref().and_then(|s| s.g_scale),
        g_text: scales.as_ref().and_then(|s| s.g_text.clone()),
    })
}

pub fn poll_once(app: &AppHandle) {
    match fetch_space_weather() {
        Ok(sw) => {
            let fetched_at = Utc::now().to_rfc3339();
            {
                let db = app.state::<Db>();
                let conn = db.0.lock().expect("db mutex poisoned");
                db::save_space_weather(&conn, SOURCE_ID, &fetched_at, &sw);
                connectivity::report_source_health(
                    &conn,
                    SOURCE_ID,
                    "Space Weather (N0NBH)",
                    Status::Healthy,
                    Via::Internet,
                    None,
                );
            }
            let _ = app.emit("space-weather-changed", ());
        }
        Err(detail) => {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            connectivity::report_source_health(
                &conn,
                SOURCE_ID,
                "Space Weather (N0NBH)",
                Status::Down,
                Via::Internet,
                Some(&detail),
            );
        }
    }
}

pub fn spawn_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        if !connectivity::paused_for_offline(&app, SOURCE_ID, "Space Weather (N0NBH)") {
            poll_once(&app);
        }
        std::thread::sleep(POLL_INTERVAL);
    });
}
