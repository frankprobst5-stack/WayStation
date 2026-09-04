//! ADS-B flight tracking via the OpenSky Network public API, decided
//! 2026-09-04 -- the online-first half of the operator-flagged
//! critical "Flight tracking (ADS-B)" backlog item (real high-
//! disaster-risk location; a nearby SAR/medevac/firefighting aircraft
//! is genuinely operationally relevant here, not a hobbyist feature).
//!
//! **What's built here:** OpenSky's `/states/all` endpoint is a free,
//! keyless public API -- verified live before writing any code (same
//! discipline `pota.rs` already established: check for a ToS block or
//! an undocumented auth wall before building on a third-party feed,
//! don't assume). No API key, no account, worked from a plain `curl`.
//! Rate-limited for anonymous use, but a 5-minute poll interval stays
//! comfortably inside that budget.
//!
//! **What's explicitly not built here, named rather than silently
//! absent:** the local SDR fallback (`dump1090`/`readsb`, decoding
//! real 1090MHz ADS-B transponder signals directly when the internet
//! is down) is real remaining work -- genuinely blocked on SDR
//! hardware the same way multi-node mesh testing is blocked on a
//! second physical node, not on more code. This module's whole
//! offline story today is "no internet, no aircraft data," the same
//! honest gap `PskReporterPanel`/`DxClusterPanel`/`PotaPanel` already
//! have and say so (`offlineBehavior: "internet-only"`).

use crate::connectivity::{self, Status, Via};
use crate::db::{self, Db, IncomingAircraftTrack};
use crate::maidenhead::grid_square_to_lat_lon;
use chrono::Utc;
use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const SOURCE_ID: &str = "opensky";
const SOURCE_LABEL: &str = "Flight Tracking (ADS-B)";
const FEED_URL: &str = "https://opensky-network.org/api/states/all";
const POLL_INTERVAL: Duration = Duration::from_secs(5 * 60);
const USER_AGENT: &str = "Waystation/0.1 (https://github.com/frankprobst5-stack/WayStation)";

/// Half-width of the bounding box queried around the station's own
/// grid square, in degrees. ~220km/135mi north-south at mid latitudes
/// -- a real, accepted approximation, not a precise radius (degrees of
/// longitude compress toward the poles, same caveat every grid-square
/// distance calculation in this app already carries). Fixed for now;
/// a configurable radius is real future work if "regional" turns out
/// to be the wrong default for some station.
const BOX_HALF_DEGREES: f64 = 2.0;

#[derive(Deserialize)]
struct StatesResponse {
    states: Option<Vec<Vec<Value>>>,
}

fn value_as_f64(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}

fn value_as_str(v: Option<&Value>) -> Option<String> {
    // OpenSky pads callsigns to 8 characters with trailing spaces
    // ("UAL123  ") -- trim on the way in so nothing downstream has to
    // know that.
    v.and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

fn value_as_bool(v: Option<&Value>) -> bool {
    v.and_then(Value::as_bool).unwrap_or(false)
}

fn value_as_i64(v: Option<&Value>) -> Option<i64> {
    v.and_then(Value::as_i64)
}

/// One OpenSky "state vector" is a heterogeneous JSON array (mixed
/// strings/numbers/nulls/bools by fixed position), not an object --
/// deliberately parsed by index into `Value` rather than a typed tuple,
/// since a tuple deserialization fails the whole record on any one
/// unexpected type, and this is real third-party data this app doesn't
/// control the shape of. Field order per OpenSky's own documented
/// schema: icao24(0), callsign(1), origin_country(2), time_position(3),
/// last_contact(4), longitude(5), latitude(6), baro_altitude(7),
/// on_ground(8), velocity(9), true_track(10), vertical_rate(11),
/// sensors(12), geo_altitude(13), squawk(14), spi(15), position_source(16).
fn parse_state(fields: &[Value]) -> Option<IncomingAircraftTrack> {
    let icao24 = value_as_str(fields.get(0))?;
    Some(IncomingAircraftTrack {
        icao24,
        callsign: value_as_str(fields.get(1)),
        origin_country: value_as_str(fields.get(2)),
        latitude: value_as_f64(fields.get(6)),
        longitude: value_as_f64(fields.get(5)),
        // Barometric altitude is the primary reading; an aircraft on
        // the ground or between readings sometimes reports it null
        // while still having a valid geometric (GPS) altitude -- fall
        // back rather than showing no altitude at all when one exists.
        altitude_m: value_as_f64(fields.get(7)).or_else(|| value_as_f64(fields.get(13))),
        on_ground: value_as_bool(fields.get(8)),
        velocity_ms: value_as_f64(fields.get(9)),
        true_track: value_as_f64(fields.get(10)),
        vertical_rate_ms: value_as_f64(fields.get(11)),
        squawk: value_as_str(fields.get(14)),
        last_contact: value_as_i64(fields.get(4)).unwrap_or(0),
    })
}

fn fetch_states(lat: f64, lon: f64) -> Result<Vec<IncomingAircraftTrack>, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let resp: StatesResponse = client
        .get(FEED_URL)
        .query(&[
            ("lamin", (lat - BOX_HALF_DEGREES).to_string()),
            ("lamax", (lat + BOX_HALF_DEGREES).to_string()),
            ("lomin", (lon - BOX_HALF_DEGREES).to_string()),
            ("lomax", (lon + BOX_HALF_DEGREES).to_string()),
        ])
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;

    Ok(resp.states.unwrap_or_default().iter().filter_map(|f| parse_state(f)).collect())
}

pub fn poll_once(app: &AppHandle) {
    let grid = {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        db::station_profile(&conn).grid_square
    };
    let Some((lat, lon)) = grid.as_deref().and_then(grid_square_to_lat_lon) else {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        connectivity::report_source_health(
            &conn,
            SOURCE_ID,
            SOURCE_LABEL,
            Status::Degraded,
            Via::Internet,
            Some("Set this station's grid square (Settings → Station Identity) to see nearby aircraft"),
        );
        return;
    };

    match fetch_states(lat, lon) {
        Ok(tracks) => {
            let fetched_at = Utc::now().to_rfc3339();
            {
                let db = app.state::<Db>();
                let mut conn = db.0.lock().expect("db mutex poisoned");
                db::replace_aircraft_tracks(&mut conn, SOURCE_ID, &fetched_at, &tracks);
                connectivity::report_source_health(&conn, SOURCE_ID, SOURCE_LABEL, Status::Healthy, Via::Internet, None);
            }
            let _ = app.emit("aircraft-tracks-changed", ());
        }
        Err(detail) => {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            connectivity::report_source_health(&conn, SOURCE_ID, SOURCE_LABEL, Status::Down, Via::Internet, Some(&detail));
        }
    }
}

pub fn spawn_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        if !connectivity::paused_for_offline(&app, SOURCE_ID, SOURCE_LABEL) {
            poll_once(&app);
        }
        std::thread::sleep(POLL_INTERVAL);
    });
}

#[cfg(test)]
mod tests {
    //! Pure parsing tests against real OpenSky field-order data, no live
    //! network needed -- matching this app's existing discipline
    //! (`pota.rs`/`nws.rs`) of not depending on a live third-party
    //! service in the default test run.
    use super::*;

    fn fields(json: &str) -> Vec<Value> {
        serde_json::from_str::<Value>(json).unwrap().as_array().unwrap().clone()
    }

    #[test]
    fn parse_state_reads_the_real_opensky_field_order() {
        let f = fields(r#"["a1b2c3","UAL123  ","United States",1699999000,1699999005,-122.4,37.7,3500.0,false,210.5,270.0,0.0,null,3600.0,"1200",false,0]"#);
        let track = parse_state(&f).expect("a well-formed state vector must parse");
        assert_eq!(track.icao24, "a1b2c3");
        assert_eq!(track.callsign.as_deref(), Some("UAL123"));
        assert_eq!(track.origin_country.as_deref(), Some("United States"));
        assert_eq!(track.latitude, Some(37.7));
        assert_eq!(track.longitude, Some(-122.4));
        assert_eq!(track.altitude_m, Some(3500.0));
        assert!(!track.on_ground);
        assert_eq!(track.velocity_ms, Some(210.5));
        assert_eq!(track.squawk.as_deref(), Some("1200"));
        assert_eq!(track.last_contact, 1699999005);
    }

    #[test]
    fn parse_state_falls_back_to_geo_altitude_when_baro_altitude_is_null() {
        let f = fields(r#"["a1b2c3",null,"United States",null,1699999005,-122.4,37.7,null,true,null,null,null,null,150.0,null,false,0]"#);
        let track = parse_state(&f).expect("a state vector on the ground with no barometric reading must still parse");
        assert_eq!(track.altitude_m, Some(150.0));
        assert!(track.on_ground);
        assert_eq!(track.callsign, None, "a null callsign must stay None, not the literal string \"null\"");
    }

    #[test]
    fn parse_state_rejects_a_state_vector_with_no_icao24() {
        let f = fields(r#"[null,"UAL123","United States",null,0,null,null,null,false,null,null,null,null,null,null,false,0]"#);
        assert!(parse_state(&f).is_none(), "an aircraft with no identity at all is not a real track");
    }

    #[test]
    fn parse_state_trims_the_space_padded_callsign_opensky_actually_sends() {
        let f = fields(r#"["a1b2c3","SKW5768 ","United States",null,0,null,null,null,false,null,null,null,null,null,null,false,0]"#);
        let track = parse_state(&f).unwrap();
        assert_eq!(track.callsign.as_deref(), Some("SKW5768"));
    }
}
