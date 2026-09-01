//! Amateur satellite tracking: TLE ingest (CelesTrak) + pass prediction.
//!
//! Orbital propagation itself uses the `sgp4` crate (a real, widely used
//! pure-Rust SGP4 implementation) rather than a hand-rolled version —
//! SGP4 has too many well-known correctness pitfalls to reimplement, the
//! same "orchestrate, don't reimplement" reasoning this project already
//! applies to Pat/JS8Call/Hamlib.
//!
//! The TEME-to-topocentric (azimuth/elevation) math below is NOT from the
//! sgp4 crate — it's implemented directly against CelesTrak's own
//! reference formulas (Kelso, "Orbital Coordinate Systems" series,
//! celestrak.org/columns/v02n02/), verified against that primary source
//! rather than assumed from memory before writing this. SGP4's TEME
//! output is treated as ECI directly, the same simplification the wider
//! amateur/open-source satellite tracking community uses (Gpredict,
//! PREDICT, etc.) — the precession/nutation correction it skips is well
//! under a degree over the timescales SGP4 is valid for, immaterial for
//! horizon-crossing predictions.

use crate::connectivity::{self, Status, Via};
use crate::db::{self, Db, IncomingTle};
use crate::maidenhead::grid_square_to_lat_lon;
use chrono::{DateTime, TimeZone, Utc};
use std::f64::consts::PI;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const SOURCE_ID: &str = "celestrak-amateur";
const FEED_URL: &str = "https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=tle";
// CelesTrak's own guidance: GP data only changes every ~2 hours, no need
// to check more often. This polls every 6, comfortably above that floor.
const POLL_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const USER_AGENT: &str = "Waystation/0.1 (https://github.com/frankprobst5-stack/WayStation)";

const EARTH_RADIUS_KM: f64 = 6378.135; // spherical Earth model, per Kelso's reference formulas
const EARTH_ROTATION_RAD_PER_SEC: f64 = 7.29211510e-5; // ωe, per Kelso

fn fetch_tles() -> Result<Vec<IncomingTle>, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(20))
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

    // Parsed directly from the raw text (name line + two TLE lines,
    // repeating) rather than round-tripped through sgp4::Elements — the
    // crate has no lines-serializer, and storing the exact original lines
    // is simpler anyway. sgp4::Elements is still what does the actual
    // propagation work, built from these stored lines at query time.
    let lines: Vec<&str> = body.lines().collect();
    let mut tles = Vec::new();
    let mut i = 0;
    while i + 2 < lines.len() {
        let name = lines[i].trim().to_string();
        let line1 = lines[i + 1].trim().to_string();
        let line2 = lines[i + 2].trim().to_string();
        if line1.starts_with('1') && line2.starts_with('2') {
            if let Some(norad_id) = line1.get(2..7).and_then(|s| s.trim().parse::<i64>().ok()) {
                tles.push(IncomingTle { norad_id, name, line1, line2 });
            }
        }
        i += 3;
    }

    Ok(tles)
}

pub fn poll_once(app: &AppHandle) {
    match fetch_tles() {
        Ok(tles) => {
            let fetched_at = Utc::now().to_rfc3339();
            {
                let db = app.state::<Db>();
                let mut conn = db.0.lock().expect("db mutex poisoned");
                db::replace_satellite_tles(&mut conn, SOURCE_ID, &fetched_at, &tles);
                connectivity::report_source_health(
                    &conn,
                    SOURCE_ID,
                    "Satellite TLEs (CelesTrak)",
                    Status::Healthy,
                    Via::Internet,
                    None,
                );
            }
            let _ = app.emit("satellites-changed", ());
        }
        Err(detail) => {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            connectivity::report_source_health(
                &conn,
                SOURCE_ID,
                "Satellite TLEs (CelesTrak)",
                Status::Down,
                Via::Internet,
                Some(&detail),
            );
        }
    }
}

pub fn spawn_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        if !connectivity::paused_for_offline(&app, SOURCE_ID, "Satellite TLEs (CelesTrak)") {
            poll_once(&app);
        }
        std::thread::sleep(POLL_INTERVAL);
    });
}

/// Julian Date via chrono's date arithmetic against the J2000.0 epoch
/// (2000-01-01 12:00:00 UTC = JD 2451545.0 exactly), rather than a
/// hand-rolled calendar-to-JD formula — chrono's calendar math is already
/// correct and well-tested, no reason to duplicate it.
fn julian_date(dt: DateTime<Utc>) -> f64 {
    let j2000 = Utc.with_ymd_and_hms(2000, 1, 1, 12, 0, 0).unwrap();
    let delta_ms = dt.signed_duration_since(j2000).num_milliseconds() as f64;
    2451545.0 + delta_ms / 86_400_000.0
}

/// Greenwich Mean Sidereal Time, in radians. Two-step formula exactly as
/// given in Kelso's reference: θg(0h) via the IAU 1982 polynomial, then
/// θg(τ) = θg(0h) + ωe·Δτ for the elapsed time since 0h UTC.
fn gmst_radians(dt: DateTime<Utc>) -> f64 {
    let midnight_naive = dt.date_naive().and_hms_opt(0, 0, 0).unwrap();
    let midnight = Utc.from_utc_datetime(&midnight_naive);

    let du = julian_date(midnight) - 2451545.0;
    let tu = du / 36525.0;
    let theta_g0h_seconds =
        24110.54841 + 8640184.812866 * tu + 0.093104 * tu * tu - 6.2e-6 * tu * tu * tu;
    let theta_g0h_radians = theta_g0h_seconds.rem_euclid(86400.0) * (2.0 * PI / 86400.0);

    let delta_tau_seconds = dt.signed_duration_since(midnight).num_milliseconds() as f64 / 1000.0;
    (theta_g0h_radians + EARTH_ROTATION_RAD_PER_SEC * delta_tau_seconds).rem_euclid(2.0 * PI)
}

struct LookAngles {
    azimuth_deg: f64,
    elevation_deg: f64,
}

/// Converts a satellite's TEME position (treated as ECI, see module docs)
/// plus an observer's geodetic lat/lon into topocentric azimuth/elevation,
/// following Kelso's SEZ (South-East-Zenith) formulas exactly.
fn look_angles(lat_deg: f64, lon_deg: f64, gmst_rad: f64, sat_pos_km: [f64; 3]) -> LookAngles {
    let phi = lat_deg.to_radians();
    let theta = gmst_rad + lon_deg.to_radians();

    let obs_x = EARTH_RADIUS_KM * phi.cos() * theta.cos();
    let obs_y = EARTH_RADIUS_KM * phi.cos() * theta.sin();
    let obs_z = EARTH_RADIUS_KM * phi.sin();

    let rx = sat_pos_km[0] - obs_x;
    let ry = sat_pos_km[1] - obs_y;
    let rz = sat_pos_km[2] - obs_z;

    let r_s = phi.sin() * theta.cos() * rx + phi.sin() * theta.sin() * ry - phi.cos() * rz;
    let r_e = -theta.sin() * rx + theta.cos() * ry;
    let r_z = phi.cos() * theta.cos() * rx + phi.cos() * theta.sin() * ry + phi.sin() * rz;

    let range = (r_s * r_s + r_e * r_e + r_z * r_z).sqrt();
    let elevation = (r_z / range).asin();

    let mut azimuth = (-r_e / r_s).atan();
    if r_s > 0.0 {
        azimuth += PI;
    }
    if azimuth < 0.0 {
        azimuth += 2.0 * PI;
    }

    LookAngles { azimuth_deg: azimuth.to_degrees(), elevation_deg: elevation.to_degrees() }
}

/// Line-of-sight (radial) velocity between observer and satellite, in
/// km/s — positive means the satellite is receding (range increasing).
/// Includes the observer's own velocity from Earth's rotation (ω × r),
/// not just the satellite's TEME velocity — small (well under 0.5 km/s at
/// most latitudes) next to a LEO satellite's ~7.5 km/s orbital velocity,
/// but a real vector quantity, not a rounding-error-sized correction, so
/// it's included rather than assumed negligible.
fn range_rate_km_s(lat_deg: f64, lon_deg: f64, gmst_rad: f64, sat_pos: [f64; 3], sat_vel: [f64; 3]) -> f64 {
    let phi = lat_deg.to_radians();
    let theta = gmst_rad + lon_deg.to_radians();

    let obs_x = EARTH_RADIUS_KM * phi.cos() * theta.cos();
    let obs_y = EARTH_RADIUS_KM * phi.cos() * theta.sin();
    let obs_z = EARTH_RADIUS_KM * phi.sin();

    let obs_vx = -EARTH_ROTATION_RAD_PER_SEC * obs_y;
    let obs_vy = EARTH_ROTATION_RAD_PER_SEC * obs_x;

    let rx = sat_pos[0] - obs_x;
    let ry = sat_pos[1] - obs_y;
    let rz = sat_pos[2] - obs_z;
    let range = (rx * rx + ry * ry + rz * rz).sqrt();

    let rel_vx = sat_vel[0] - obs_vx;
    let rel_vy = sat_vel[1] - obs_vy;
    let rel_vz = sat_vel[2];

    (rx * rel_vx + ry * rel_vy + rz * rel_vz) / range
}

fn elevation_at(constants: &sgp4::Constants, epoch: DateTime<Utc>, lat: f64, lon: f64, t: DateTime<Utc>) -> Option<f64> {
    let minutes = t.signed_duration_since(epoch).num_milliseconds() as f64 / 60_000.0;
    let prediction = constants.propagate(sgp4::MinutesSinceEpoch(minutes)).ok()?;
    let gmst = gmst_radians(t);
    Some(look_angles(lat, lon, gmst, prediction.position).elevation_deg)
}

#[derive(serde::Serialize)]
pub struct PassWindow {
    pub aos: String,
    pub los: String,
    pub max_elevation_deg: f64,
}

#[derive(serde::Serialize)]
pub struct SatelliteStatus {
    pub norad_id: i64,
    pub name: String,
    pub tle_fetched_at: String,
    pub currently_visible: bool,
    pub azimuth_deg: f64,
    pub elevation_deg: f64,
    /// Radial velocity in km/s, positive = receding. The frontend applies
    /// the classical Doppler formula itself (shift = -f * v/c) for
    /// whatever frequency the operator enters, rather than this command
    /// taking a frequency parameter — avoids a round-trip per keystroke.
    pub range_rate_km_s: f64,
    /// Current ground subpoint — free to compute alongside az/el (same
    /// propagated position already in hand), lets the frontend's "you are
    /// here" marker on the ground-track map update on the same 5s cadence
    /// as everything else in this response without refetching the whole
    /// track.
    pub subpoint_lat_deg: f64,
    pub subpoint_lon_deg: f64,
    pub next_pass: Option<PassWindow>,
}

const STEP_SECONDS: i64 = 20;
const LOOKAHEAD_HOURS: i64 = 48;

/// Steps forward in short intervals from now, tracking elevation
/// sign-crossings to find the next (or current, if already overhead)
/// pass. A brute-force scan rather than a root-finder — simple, robust
/// against SGP4's non-closed-form geometry, and cheap enough for an
/// on-demand single-satellite query (a few thousand propagate() calls).
#[tauri::command]
pub fn get_satellite_status(db: State<Db>, norad_id: i64) -> Result<SatelliteStatus, String> {
    let (tle, station_lat, station_lon) = {
        let conn = db.0.lock().expect("db mutex poisoned");
        let tle = conn
            .query_row(
                "SELECT norad_id, name, fetched_at, line1, line2 FROM satellite_tles WHERE norad_id = ?1",
                rusqlite::params![norad_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )
            .map_err(|_| "satellite not found in cached TLE list".to_string())?;

        let profile = db::station_profile(&conn);
        let (lat, lon) = profile
            .grid_square
            .and_then(|g| grid_square_to_lat_lon(&g))
            .ok_or("set your station's grid square (Station panel) to compute look angles")?;

        (tle, lat, lon)
    };

    let (_, name, fetched_at, line1, line2) = tle;
    let elements = sgp4::Elements::from_tle(Some(name.clone()), line1.as_bytes(), line2.as_bytes())
        .map_err(|e| e.to_string())?;
    let epoch = elements.datetime.and_utc();
    let constants = sgp4::Constants::from_elements(&elements).map_err(|e| e.to_string())?;

    let now = Utc::now();
    let current_elevation = elevation_at(&constants, epoch, station_lat, station_lon, now)
        .ok_or("failed to propagate satellite position")?;
    let minutes_now = now.signed_duration_since(epoch).num_milliseconds() as f64 / 60_000.0;
    let prediction_now = constants
        .propagate(sgp4::MinutesSinceEpoch(minutes_now))
        .map_err(|e| e.to_string())?;
    let gmst_now = gmst_radians(now);
    let current_look = look_angles(station_lat, station_lon, gmst_now, prediction_now.position);
    let range_rate = range_rate_km_s(station_lat, station_lon, gmst_now, prediction_now.position, prediction_now.velocity);
    let (subpoint_lat_deg, subpoint_lon_deg) = subpoint(prediction_now.position, gmst_now);

    let mut t = now;
    let end = now + chrono::Duration::hours(LOOKAHEAD_HOURS);
    let mut prev_elevation = current_elevation;
    let mut aos: Option<DateTime<Utc>> = if current_elevation > 0.0 { Some(now) } else { None };
    let mut max_elevation = current_elevation;
    let mut next_pass: Option<PassWindow> = None;

    while t < end {
        t += chrono::Duration::seconds(STEP_SECONDS);
        let Some(el) = elevation_at(&constants, epoch, station_lat, station_lon, t) else { break };

        if aos.is_none() && prev_elevation <= 0.0 && el > 0.0 {
            aos = Some(t);
            max_elevation = el;
        } else if aos.is_some() {
            if el > max_elevation {
                max_elevation = el;
            }
            if prev_elevation > 0.0 && el <= 0.0 {
                next_pass = Some(PassWindow {
                    aos: aos.unwrap().to_rfc3339(),
                    los: t.to_rfc3339(),
                    max_elevation_deg: max_elevation,
                });
                break;
            }
        }

        prev_elevation = el;
    }

    Ok(SatelliteStatus {
        norad_id,
        name,
        tle_fetched_at: fetched_at,
        currently_visible: current_elevation > 0.0,
        azimuth_deg: current_look.azimuth_deg,
        elevation_deg: current_look.elevation_deg,
        range_rate_km_s: range_rate,
        subpoint_lat_deg,
        subpoint_lon_deg,
        next_pass,
    })
}

/// Ground subpoint (lat/lon directly below the satellite) from its TEME
/// position and the current GMST — same primitive relationship as
/// `look_angles`, just without an observer. Verified against `skyfield`
/// during the Doppler work the same night this module was first written;
/// wasn't kept as permanent code then since it was only needed for that
/// one-off check, brought back now for the ground track.
fn subpoint(sat_pos_km: [f64; 3], gmst_rad: f64) -> (f64, f64) {
    let r = (sat_pos_km[0] * sat_pos_km[0] + sat_pos_km[1] * sat_pos_km[1] + sat_pos_km[2] * sat_pos_km[2]).sqrt();
    let lat = (sat_pos_km[2] / r).asin();
    let right_ascension = sat_pos_km[1].atan2(sat_pos_km[0]);
    let lon = (right_ascension - gmst_rad + PI).rem_euclid(2.0 * PI) - PI;
    (lat.to_degrees(), lon.to_degrees())
}

#[derive(serde::Serialize)]
pub struct GroundTrackPoint {
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub minutes_from_now: f64,
}

const GROUND_TRACK_STEP_SECONDS: f64 = 30.0;

/// One full orbit centered on "now" (half a period in the past, half in
/// the future), so the operator sees both where the satellite has been
/// and where it's headed. The orbital period comes from the TLE's own
/// mean motion (revs/day) rather than an assumed value, since different
/// amateur satellites orbit at genuinely different altitudes/periods.
#[tauri::command]
pub fn get_satellite_ground_track(db: State<Db>, norad_id: i64) -> Result<Vec<GroundTrackPoint>, String> {
    let (name, line1, line2) = {
        let conn = db.0.lock().expect("db mutex poisoned");
        conn.query_row(
            "SELECT name, line1, line2 FROM satellite_tles WHERE norad_id = ?1",
            rusqlite::params![norad_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        )
        .map_err(|_| "satellite not found in cached TLE list".to_string())?
    };

    let elements = sgp4::Elements::from_tle(Some(name), line1.as_bytes(), line2.as_bytes())
        .map_err(|e| e.to_string())?;
    let epoch = elements.datetime.and_utc();
    let period_minutes = 1440.0 / elements.mean_motion;
    let constants = sgp4::Constants::from_elements(&elements).map_err(|e| e.to_string())?;

    let now = Utc::now();
    let half_period = period_minutes / 2.0;
    let step_minutes = GROUND_TRACK_STEP_SECONDS / 60.0;

    let mut points = Vec::new();
    let mut m = -half_period;
    while m <= half_period {
        let t = now + chrono::Duration::milliseconds((m * 60_000.0) as i64);
        let minutes_since_epoch = t.signed_duration_since(epoch).num_milliseconds() as f64 / 60_000.0;
        if let Ok(prediction) = constants.propagate(sgp4::MinutesSinceEpoch(minutes_since_epoch)) {
            let (lat_deg, lon_deg) = subpoint(prediction.position, gmst_radians(t));
            points.push(GroundTrackPoint { lat_deg, lon_deg, minutes_from_now: m });
        }
        m += step_minutes;
    }

    Ok(points)
}
