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
use crate::db::{self, Db, IncomingAlert, IncomingForecastPeriod};
use crate::maidenhead::grid_square_to_lat_lon;
use chrono::Utc;
use serde::Deserialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const SOURCE_ID: &str = "nws-alerts";
const FORECAST_SOURCE_ID: &str = "nws-forecast";
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

#[derive(Debug, Deserialize)]
struct PointsResponse {
    properties: PointsProperties,
}

#[derive(Debug, Deserialize)]
struct PointsProperties {
    forecast: String,
}

#[derive(Debug, Deserialize)]
struct ForecastResponse {
    properties: ForecastProperties,
}

#[derive(Debug, Deserialize)]
struct ForecastProperties {
    periods: Vec<RawForecastPeriod>,
}

#[derive(Debug, Deserialize)]
struct ProbabilityOfPrecipitation {
    value: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawForecastPeriod {
    number: i64,
    name: String,
    start_time: String,
    end_time: String,
    is_daytime: bool,
    temperature: Option<f64>,
    temperature_unit: Option<String>,
    probability_of_precipitation: Option<ProbabilityOfPrecipitation>,
    wind_speed: Option<String>,
    wind_direction: Option<String>,
    icon: Option<String>,
    short_forecast: Option<String>,
    detailed_forecast: Option<String>,
}

/// Pulled out as its own function specifically so it's unit-testable
/// against a real captured NWS response without a live network call --
/// the shape (`probabilityOfPrecipitation` as a nested `{unitCode,value}`
/// object, `value` legitimately null) came from an actual `curl` against
/// api.weather.gov before writing this, not assumed.
fn parse_forecast_periods(raw: Vec<RawForecastPeriod>) -> Vec<IncomingForecastPeriod> {
    raw.into_iter()
        .map(|p| IncomingForecastPeriod {
            period_number: p.number,
            name: p.name,
            start_time: p.start_time,
            end_time: p.end_time,
            is_daytime: p.is_daytime,
            temperature: p.temperature,
            temperature_unit: p.temperature_unit,
            probability_of_precip: p.probability_of_precipitation.and_then(|pp| pp.value),
            wind_speed: p.wind_speed,
            wind_direction: p.wind_direction,
            icon: p.icon,
            short_forecast: p.short_forecast,
            detailed_forecast: p.detailed_forecast,
        })
        .collect()
}

/// Real two-step NWS flow, verified live before writing this: `/points/`
/// resolves a lat/lon to the forecast office grid and hands back the exact
/// forecast URL to call next -- there's no way to build that URL yourself,
/// NWS's own grid layout isn't public/computable, the points lookup is
/// mandatory, not an optimization to skip.
fn fetch_forecast(lat: f64, lon: f64) -> Result<Vec<IncomingForecastPeriod>, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let points_url = format!("https://api.weather.gov/points/{lat:.4},{lon:.4}");
    let points: PointsResponse = client
        .get(&points_url)
        .header("Accept", "application/geo+json")
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;

    let forecast: ForecastResponse = client
        .get(&points.properties.forecast)
        .header("Accept", "application/geo+json")
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;

    Ok(parse_forecast_periods(forecast.properties.periods))
}

/// Same shared/on-demand shape as `poll_once` -- called by both the
/// background poller and `readiness.rs`'s "Prepare for Offline."
pub fn poll_once_forecast(app: &AppHandle) {
    let point = {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        db::station_profile(&conn).grid_square.and_then(|g| grid_square_to_lat_lon(&g))
    };

    if let Some((lat, lon)) = point {
        match fetch_forecast(lat, lon) {
            Ok(periods) => {
                let fetched_at = Utc::now().to_rfc3339();
                {
                    let db = app.state::<Db>();
                    let mut conn = db.0.lock().expect("db mutex poisoned");
                    db::replace_forecast_periods(&mut conn, FORECAST_SOURCE_ID, &fetched_at, &periods);
                    connectivity::report_source_health(&conn, FORECAST_SOURCE_ID, "NWS Forecast", Status::Healthy, Via::Internet, None);
                }
                let _ = app.emit("forecast-changed", ());
            }
            Err(detail) => {
                let db = app.state::<Db>();
                let conn = db.0.lock().expect("db mutex poisoned");
                connectivity::report_source_health(&conn, FORECAST_SOURCE_ID, "NWS Forecast", Status::Down, Via::Internet, Some(&detail));
            }
        }
    }
}

pub fn spawn_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        if !connectivity::paused_for_offline(&app, SOURCE_ID, "NWS Active Alerts") {
            poll_once(&app);
        }
        if !connectivity::paused_for_offline(&app, FORECAST_SOURCE_ID, "NWS Forecast") {
            poll_once_forecast(&app);
        }
        std::thread::sleep(POLL_INTERVAL);
    });
}

#[cfg(test)]
mod tests {
    //! Pure parsing test against a real captured api.weather.gov response
    //! shape -- no live network needed, matching this app's existing
    //! discipline (flight_tracking.rs, pota.rs) of not depending on a
    //! live third-party service in the default test run.
    use super::*;

    #[test]
    fn parse_forecast_periods_reads_the_real_nws_shape() {
        let raw = r#"[{
            "number": 1,
            "name": "This Afternoon",
            "startTime": "2026-09-05T13:00:00-05:00",
            "endTime": "2026-09-05T18:00:00-05:00",
            "isDaytime": true,
            "temperature": 97,
            "temperatureUnit": "F",
            "temperatureTrend": null,
            "probabilityOfPrecipitation": {"unitCode": "wmoUnit:percent", "value": 0},
            "windSpeed": "5 to 10 mph",
            "windDirection": "S",
            "icon": "https://api.weather.gov/icons/land/day/hot?size=medium",
            "shortForecast": "Mostly Sunny",
            "detailedForecast": "Mostly sunny, with a high near 97. South wind 5 to 10 mph."
        }]"#;
        let periods: Vec<RawForecastPeriod> = serde_json::from_str(raw).unwrap();
        let parsed = parse_forecast_periods(periods);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].name, "This Afternoon");
        assert_eq!(parsed[0].temperature, Some(97.0));
        assert_eq!(parsed[0].probability_of_precip, Some(0.0));
        assert_eq!(parsed[0].short_forecast.as_deref(), Some("Mostly Sunny"));
    }

    #[test]
    fn parse_forecast_periods_handles_a_null_precipitation_probability() {
        // A real, observed case -- not every period carries a
        // precipitation forecast.
        let raw = r#"[{
            "number": 2,
            "name": "Tonight",
            "startTime": "2026-09-05T18:00:00-05:00",
            "endTime": "2026-09-06T06:00:00-05:00",
            "isDaytime": false,
            "temperature": 68,
            "temperatureUnit": "F",
            "probabilityOfPrecipitation": {"unitCode": "wmoUnit:percent", "value": null},
            "windSpeed": "5 mph",
            "windDirection": "S",
            "icon": null,
            "shortForecast": "Clear",
            "detailedForecast": "Clear skies."
        }]"#;
        let periods: Vec<RawForecastPeriod> = serde_json::from_str(raw).unwrap();
        let parsed = parse_forecast_periods(periods);
        assert_eq!(parsed[0].probability_of_precip, None);
        assert!(!parsed[0].is_daytime);
    }
}
