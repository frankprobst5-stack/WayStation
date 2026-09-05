//! Local weather-station console polling, decided 2026-09-05 -- the
//! "local" tier of the 3-tier weather picture (online/RF-offline/local
//! console). Unlike the scanner or the RF weather tiers, this needs no
//! Citadel involvement and no hardware WayStation doesn't already have:
//! the console/gateway is just another device on the operator's own LAN
//! with its own reachable IP, so WayStation polls it directly over plain
//! HTTP, the same std::thread + blocking-reqwest shape every other poller
//! in this app already uses.
//!
//! Two brands, chosen deliberately (see ROADMAP.md for the full reasoning
//! from researching this): **Ecowitt** (or any Fine-Offset-protocol-
//! compatible gateway -- Ambient Weather's own console turned out NOT to
//! have a local API, only their Fine-Offset-class gateway does, same
//! protocol family), the budget option (~$60-90, genuinely no internet
//! required, real documented `/get_livedata_info` endpoint); and **Davis
//! WeatherLink Live**, the pricier (~$200+) but well-documented,
//! no-auth-required local API EmComm/prepper circles trust specifically
//! for never phoning home.
//!
//! Both real API shapes were fetched and read before writing this, not
//! assumed. Ecowitt's `common_list`/`rain` entries are a real, honestly
//! inconsistent third-party format -- some values carry a separate `unit`
//! field, others embed the unit directly in the `val` string
//! ("3.2 m/s", "88%") -- parsed defensively by splitting the leading
//! numeric prefix from whatever unit text follows, from either source.
//!
//! Normalizes everything to US-customary units (°F/mph/inHg) regardless
//! of what the device itself reports in, matching the convention
//! `nws.rs`'s forecast periods already established elsewhere in this app.
//! One real, named limitation: Davis's rain rate is reported in raw
//! tipping-bucket "counts," which only converts to inches with the
//! collector's own bucket size (varies by model/region) -- this assumes
//! the standard 0.01in/tip used by the vast majority of US-market Vantage
//! Pro2/Vue stations, and says so plainly in the UI rather than silently
//! presenting a number that could be wrong for a non-standard collector.

use crate::connectivity::{self, Status, Via};
use crate::db::{self, Db, LocalWeatherObservation};
use chrono::Utc;
use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const SOURCE_ID: &str = "local-weather-station";
const SOURCE_LABEL: &str = "Local Weather Station";
const POLL_INTERVAL: Duration = Duration::from_secs(2 * 60);
const USER_AGENT: &str = "Waystation/0.1 (https://github.com/frankprobst5-stack/WayStation)";

// Davis reports rain in raw tipping-bucket "counts" -- there is no way to
// get inches without knowing the collector's own bucket size, which
// varies by model. 0.01in/tip is the documented standard for the vast
// majority of US-market Vantage Pro2/Vue stations; anything else needs a
// real per-device override this module doesn't have yet.
const DAVIS_RAIN_COUNT_INCHES: f64 = 0.01;

fn default_port(host: &str) -> String {
    if host.contains(':') {
        host.to_string()
    } else {
        format!("{host}:80")
    }
}

/// Splits an Ecowitt-style value string into its leading numeric part and
/// whatever unit text follows ("3.2 m/s" -> (3.2, "m/s"), "88%" -> (88.0,
/// "%")). Falls back to a separately-provided `unit` field when the value
/// string carries no trailing text of its own ("6.3" with unit "C") --
/// both shapes appear in real gateway responses, not just one.
fn split_value_and_unit(val: &str, unit_field: Option<&str>) -> Option<(f64, String)> {
    let val = val.trim();
    // A string with no unit suffix at all ("6.3") is a real, valid case --
    // not "no match found" the way an empty numeric prefix ("N/A") is.
    // find() returns None for both, so it can't be used with `?` directly
    // without conflating them.
    let end = val.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-')).unwrap_or(val.len());
    let (num_str, rest) = val.split_at(end);
    let num: f64 = num_str.parse().ok()?;
    let rest = rest.trim();
    let unit = if !rest.is_empty() { rest.to_string() } else { unit_field.unwrap_or("").to_string() };
    Some((num, unit))
}

fn celsius_to_fahrenheit(c: f64) -> f64 {
    c * 9.0 / 5.0 + 32.0
}

fn to_mph(value: f64, unit: &str) -> f64 {
    match unit {
        "m/s" | "mps" => value * 2.23694,
        "km/h" | "kmh" | "kph" => value * 0.621371,
        _ => value, // already mph, or unrecognized -- pass through rather than guess
    }
}

fn to_inhg(value: f64, unit: &str) -> f64 {
    match unit {
        "hPa" | "hpa" => value * 0.02953,
        "mb" | "mbar" => value * 0.02953,
        _ => value, // already inHg
    }
}

fn to_inches(value: f64, unit: &str) -> f64 {
    match unit {
        "mm" | "mm/Hr" | "mm/hr" => value / 25.4,
        _ => value, // already inches
    }
}

fn to_fahrenheit(value: f64, unit: &str) -> f64 {
    match unit {
        "C" | "c" => celsius_to_fahrenheit(value),
        _ => value, // already F
    }
}

// --- Ecowitt / Fine-Offset ---

#[derive(Debug, Deserialize)]
struct EcowittEntry {
    id: Option<String>,
    val: String,
    unit: Option<String>,
}

#[derive(Debug, Deserialize)]
struct EcowittWh25Entry {
    abs: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct EcowittResponse {
    #[serde(default)]
    common_list: Vec<EcowittEntry>,
    #[serde(default)]
    rain: Vec<EcowittEntry>,
    #[serde(default)]
    wh25: Vec<EcowittWh25Entry>,
}

/// Real Ecowitt sensor-ID table (from the official HTTP/TCP API docs) --
/// only the ids this module actually surfaces, not the full set.
const ID_OUTDOOR_TEMP: &str = "0x02";
const ID_OUTDOOR_HUMIDITY: &str = "0x07";
const ID_WIND_DIRECTION: &str = "0x0A";
const ID_WIND_SPEED: &str = "0x0B";
const ID_GUST_SPEED: &str = "0x0C";
const ID_RAIN_RATE: &str = "0x0E";

fn parse_ecowitt(body: &str) -> Result<LocalWeatherObservation, String> {
    let parsed: EcowittResponse = serde_json::from_str(body).map_err(|e| format!("could not parse Ecowitt response: {e}"))?;

    let find = |id: &str| -> Option<(f64, String)> {
        parsed.common_list.iter().chain(parsed.rain.iter()).find(|e| e.id.as_deref() == Some(id)).and_then(|e| split_value_and_unit(&e.val, e.unit.as_deref()))
    };

    let mut obs = LocalWeatherObservation::default();
    if let Some((v, u)) = find(ID_OUTDOOR_TEMP) {
        obs.temperature_f = Some(to_fahrenheit(v, &u));
    }
    if let Some((v, _)) = find(ID_OUTDOOR_HUMIDITY) {
        obs.humidity_pct = Some(v);
    }
    if let Some((v, u)) = find(ID_WIND_SPEED) {
        obs.wind_speed_mph = Some(to_mph(v, &u));
    }
    if let Some((v, u)) = find(ID_GUST_SPEED) {
        obs.wind_gust_mph = Some(to_mph(v, &u));
    }
    if let Some((v, _)) = find(ID_WIND_DIRECTION) {
        obs.wind_direction_deg = Some(v);
    }
    if let Some((v, u)) = find(ID_RAIN_RATE) {
        obs.rain_rate_in_hr = Some(to_inches(v, &u));
    }
    if let Some(abs) = parsed.wh25.first().and_then(|w| w.abs.as_deref()) {
        if let Some((v, u)) = split_value_and_unit(abs, None) {
            obs.pressure_inhg = Some(to_inhg(v, &u));
        }
    }
    Ok(obs)
}

fn fetch_ecowitt(host: &str) -> Result<LocalWeatherObservation, String> {
    let url = format!("http://{}/get_livedata_info", default_port(host));
    let client = reqwest::blocking::Client::builder().user_agent(USER_AGENT).timeout(Duration::from_secs(10)).build().map_err(|e| e.to_string())?;
    let body = client.get(&url).send().map_err(|e| format!("could not reach {url}: {e}"))?.error_for_status().map_err(|e| e.to_string())?.text().map_err(|e| e.to_string())?;
    parse_ecowitt(&body)
}

// --- Davis WeatherLink Live ---

#[derive(Debug, Deserialize)]
struct WllResponse {
    data: Option<WllData>,
}

#[derive(Debug, Deserialize)]
struct WllData {
    #[serde(default)]
    conditions: Vec<Value>,
}

/// WeatherLink Live's own documented `data_structure_type` values --
/// different sensor classes share one flat `conditions` array, so picking
/// the right entries means filtering by this field, not just taking the
/// first one.
const WLL_STRUCTURE_ISS: u64 = 1; // outdoor temp/humidity/wind/rain
const WLL_STRUCTURE_BAROMETER: u64 = 3;

fn parse_weatherlink_live(body: &str) -> Result<LocalWeatherObservation, String> {
    let parsed: WllResponse = serde_json::from_str(body).map_err(|e| format!("could not parse WeatherLink Live response: {e}"))?;
    let conditions = parsed.data.ok_or("WeatherLink Live response had no data field")?.conditions;

    let mut obs = LocalWeatherObservation::default();
    for c in &conditions {
        let structure_type = c.get("data_structure_type").and_then(Value::as_u64);
        if structure_type == Some(WLL_STRUCTURE_ISS) {
            obs.temperature_f = c.get("temp").and_then(Value::as_f64);
            obs.humidity_pct = c.get("hum").and_then(Value::as_f64);
            obs.wind_speed_mph = c.get("wind_speed_last").and_then(Value::as_f64);
            obs.wind_direction_deg = c.get("wind_dir_last").and_then(Value::as_f64);
            obs.wind_gust_mph = c.get("wind_speed_hi_last_10_min").and_then(Value::as_f64);
            obs.rain_rate_in_hr = c.get("rain_rate_last").and_then(Value::as_f64).map(|counts| counts * DAVIS_RAIN_COUNT_INCHES);
        } else if structure_type == Some(WLL_STRUCTURE_BAROMETER) {
            obs.pressure_inhg = c.get("bar_sea_level").and_then(Value::as_f64);
        }
    }
    Ok(obs)
}

fn fetch_weatherlink_live(host: &str) -> Result<LocalWeatherObservation, String> {
    let url = format!("http://{}/v1/current_conditions", default_port(host));
    let client = reqwest::blocking::Client::builder().user_agent(USER_AGENT).timeout(Duration::from_secs(10)).build().map_err(|e| e.to_string())?;
    let body = client.get(&url).send().map_err(|e| format!("could not reach {url}: {e}"))?.error_for_status().map_err(|e| e.to_string())?.text().map_err(|e| e.to_string())?;
    parse_weatherlink_live(&body)
}

pub fn poll_once(app: &AppHandle) {
    let (brand, host) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        let profile = db::station_profile(&conn);
        (profile.local_weather_brand, profile.local_weather_host)
    };

    let (Some(brand), Some(host)) = (brand, host) else {
        // No console configured -- not an error, just nothing to do.
        // Matches flight_tracking.rs's own "no grid square, no poll"
        // pattern rather than reporting a spurious failure.
        return;
    };

    let result = match brand.as_str() {
        "ecowitt" => fetch_ecowitt(&host),
        "davis_weatherlink_live" => fetch_weatherlink_live(&host),
        other => Err(format!("unknown local weather brand {other:?}")),
    };

    match result {
        Ok(obs) => {
            let fetched_at = Utc::now().to_rfc3339();
            {
                let db = app.state::<Db>();
                let conn = db.0.lock().expect("db mutex poisoned");
                db::save_local_weather_observation(&conn, &brand, &fetched_at, &obs);
                connectivity::report_source_health(&conn, SOURCE_ID, SOURCE_LABEL, Status::Healthy, Via::Lan, None);
            }
            let _ = app.emit("local-weather-changed", ());
        }
        Err(detail) => {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            connectivity::report_source_health(&conn, SOURCE_ID, SOURCE_LABEL, Status::Down, Via::Lan, Some(&detail));
        }
    }
}

pub fn spawn_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        poll_once(&app);
        std::thread::sleep(POLL_INTERVAL);
    });
}

#[cfg(test)]
mod tests {
    //! Pure parsing/conversion tests against real captured response
    //! shapes for both brands -- no live device needed, matching this
    //! app's existing discipline (flight_tracking.rs, nws.rs) of not
    //! depending on live third-party/LAN hardware in the default test run.
    use super::*;

    #[test]
    fn split_value_and_unit_handles_the_unit_embedded_in_val() {
        assert_eq!(split_value_and_unit("3.2 m/s", None), Some((3.2, "m/s".to_string())));
        assert_eq!(split_value_and_unit("88%", None), Some((88.0, "%".to_string())));
    }

    #[test]
    fn split_value_and_unit_falls_back_to_the_separate_unit_field() {
        assert_eq!(split_value_and_unit("6.3", Some("C")), Some((6.3, "C".to_string())));
    }

    #[test]
    fn split_value_and_unit_rejects_a_value_with_no_numeric_prefix() {
        assert_eq!(split_value_and_unit("N/A", None), None);
    }

    #[test]
    fn parse_ecowitt_reads_a_real_captured_response() {
        let body = r#"{
            "common_list": [
                { "id": "0x02", "val": "6.3", "unit": "C" },
                { "id": "0x07", "val": "88%" },
                { "id": "0x0B", "val": "3.2 m/s" },
                { "id": "0x0C", "val": "4.1 m/s" },
                { "id": "0x0A", "val": "207" }
            ],
            "rain": [
                { "id": "0x0D", "val": "0.8 mm" },
                { "id": "0x0E", "val": "0.0 mm/Hr" }
            ],
            "wh25": [
                { "intemp": "15.2", "unit": "C", "inhumi": "55%", "abs": "1012.4 hPa", "rel": "1012.4 hPa" }
            ]
        }"#;
        let obs = parse_ecowitt(body).unwrap();
        // 6.3C -> 43.34F
        assert!((obs.temperature_f.unwrap() - 43.34).abs() < 0.01);
        assert_eq!(obs.humidity_pct, Some(88.0));
        // 3.2 m/s -> 7.16 mph
        assert!((obs.wind_speed_mph.unwrap() - 7.158).abs() < 0.01);
        assert_eq!(obs.wind_direction_deg, Some(207.0));
        // 1012.4 hPa -> 29.895 inHg
        assert!((obs.pressure_inhg.unwrap() - 29.895).abs() < 0.01);
        assert_eq!(obs.rain_rate_in_hr, Some(0.0));
    }

    #[test]
    fn parse_ecowitt_leaves_missing_sensors_as_none_not_zero() {
        let body = r#"{"common_list": [{"id": "0x02", "val": "6.3", "unit": "C"}]}"#;
        let obs = parse_ecowitt(body).unwrap();
        assert_eq!(obs.humidity_pct, None);
        assert_eq!(obs.wind_speed_mph, None);
    }

    #[test]
    fn parse_weatherlink_live_reads_a_real_shaped_response() {
        let body = r#"{
            "data": {
                "did": "001D0A700002",
                "ts": 1531754005,
                "conditions": [
                    {
                        "data_structure_type": 1,
                        "temp": 62.7,
                        "hum": 41.2,
                        "wind_speed_last": 1.0,
                        "wind_dir_last": 268,
                        "wind_speed_hi_last_10_min": 8.0,
                        "rain_rate_last": 0
                    },
                    {
                        "data_structure_type": 3,
                        "bar_sea_level": 30.208
                    }
                ]
            },
            "error": null
        }"#;
        let obs = parse_weatherlink_live(body).unwrap();
        assert_eq!(obs.temperature_f, Some(62.7));
        assert_eq!(obs.humidity_pct, Some(41.2));
        assert_eq!(obs.wind_speed_mph, Some(1.0));
        assert_eq!(obs.wind_gust_mph, Some(8.0));
        assert_eq!(obs.pressure_inhg, Some(30.208));
        assert_eq!(obs.rain_rate_in_hr, Some(0.0));
    }

    #[test]
    fn parse_weatherlink_live_converts_rain_counts_using_the_standard_bucket_size() {
        let body = r#"{"data": {"did": "x", "ts": 0, "conditions": [
            {"data_structure_type": 1, "rain_rate_last": 5}
        ]}, "error": null}"#;
        let obs = parse_weatherlink_live(body).unwrap();
        assert_eq!(obs.rain_rate_in_hr, Some(0.05));
    }

    #[test]
    fn parse_weatherlink_live_rejects_a_response_with_no_data_field() {
        let body = r#"{"data": null, "error": "station offline"}"#;
        assert!(parse_weatherlink_live(body).is_err());
    }
}
