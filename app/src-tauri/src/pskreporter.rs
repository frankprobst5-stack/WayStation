//! PSKReporter reception reports — "who's hearing my station."
//!
//! Built against pskreporter.info's own ADIF "Download" link
//! (`cgi-bin/pskdata.pl?adif=1`), the same endpoint their map UI exposes to
//! end users for downloading their own reception history, rather than
//! reverse-engineering their internal JSONP query API
//! (`cgi-bin/pskquery5.pl`) that the map itself uses. Verified live before
//! writing this: `pskdata.pl?adif=1&days=1&senderCallsign=W1AW` returns
//! real, well-formed ADIF.
//!
//! RBN (Reverse Beacon Network) and WSPRnet are NOT built here — RBN's
//! actual feed protocol (telnet? MQTT?) hasn't been verified against a
//! live source, and WSPRnet wasn't reached this session. Both stay on
//! the roadmap as separate, unverified work.

use crate::connectivity::{self, Status, Via};
use crate::db::{self, Db, IncomingPskSpot};
use chrono::Utc;
use std::collections::HashMap;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const SOURCE_ID: &str = "pskreporter";
const POLL_INTERVAL: Duration = Duration::from_secs(20 * 60);
const USER_AGENT: &str = "Waystation/0.1 (https://github.com/frankprobst5-stack/WayStation)";

/// Hand-rolled ADIF parser — no crate pulled in for a well-documented flat
/// tag format, same call as the ICS parser in contest_calendar.rs. Each
/// `<TAG:LEN[:TYPE]>value` is read by byte length, `<eoh>` discards the
/// header's fields, `<eor>` closes out one record.
fn parse_adif(body: &str) -> Vec<HashMap<String, String>> {
    let mut records = Vec::new();
    let mut current: HashMap<String, String> = HashMap::new();
    let mut rest = body;

    while let Some(lt) = rest.find('<') {
        let after_lt = &rest[lt + 1..];
        let gt = match after_lt.find('>') {
            Some(g) => g,
            None => break,
        };
        let tag_spec = &after_lt[..gt];
        let after_tag = &after_lt[gt + 1..];

        let mut parts = tag_spec.splitn(3, ':');
        let name = parts.next().unwrap_or("").to_ascii_uppercase();

        if name == "EOR" {
            if !current.is_empty() {
                records.push(std::mem::take(&mut current));
            }
            rest = after_tag;
            continue;
        }
        if name == "EOH" {
            current.clear();
            rest = after_tag;
            continue;
        }

        let len: usize = match parts.next().and_then(|s| s.parse().ok()) {
            Some(l) => l,
            None => {
                rest = after_tag;
                continue;
            }
        };

        if after_tag.len() < len {
            break;
        }
        current.insert(name, after_tag[..len].to_string());
        rest = &after_tag[len..];
    }

    records
}

fn parse_adif_datetime(date: &str, time: &str) -> Option<String> {
    let date = chrono::NaiveDate::parse_from_str(date, "%Y%m%d").ok()?;
    let time_str = if time.len() >= 6 { &time[..6] } else { &format!("{time:0<6}")[..] };
    let time = chrono::NaiveTime::parse_from_str(time_str, "%H%M%S").ok()?;
    Some(chrono::NaiveDateTime::new(date, time).and_utc().to_rfc3339())
}

fn fetch_spots(callsign: &str) -> Result<Vec<IncomingPskSpot>, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!(
        "https://pskreporter.info/cgi-bin/pskdata.pl?adif=1&days=1&senderCallsign={callsign}"
    );
    let body = client
        .get(&url)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .map_err(|e| e.to_string())?;

    let records = parse_adif(&body);
    let spots = records
        .into_iter()
        .filter_map(|r| {
            let heard_by_call = r.get("OPERATOR")?.clone();
            let heard_at = parse_adif_datetime(r.get("QSO_DATE")?, r.get("TIME_ON")?)?;
            Some(IncomingPskSpot {
                heard_by_call,
                heard_by_grid: r.get("MY_GRIDSQUARE").cloned(),
                freq_mhz: r.get("FREQ").and_then(|s| s.parse().ok()),
                mode: r.get("MODE").cloned(),
                snr: r.get("APP_PSKREP_SNR").and_then(|s| s.parse().ok()),
                distance_km: r.get("DISTANCE").and_then(|s| s.parse().ok()),
                bearing_deg: r.get("APP_PSKREP_BRG").and_then(|s| s.parse().ok()),
                heard_at,
            })
        })
        .collect();

    Ok(spots)
}

pub fn poll_once(app: &AppHandle) {
    let callsign = {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        db::station_profile(&conn).callsign
    };

    let Some(callsign) = callsign.filter(|c| !c.trim().is_empty()) else {
        return;
    };

    match fetch_spots(&callsign) {
        Ok(spots) => {
            let fetched_at = Utc::now().to_rfc3339();
            {
                let db = app.state::<Db>();
                let mut conn = db.0.lock().expect("db mutex poisoned");
                db::replace_psk_spots(&mut conn, SOURCE_ID, &fetched_at, &callsign, &spots);
                connectivity::report_source_health(
                    &conn,
                    SOURCE_ID,
                    "PSKReporter",
                    Status::Healthy,
                    Via::Internet,
                    None,
                );
            }
            let _ = app.emit("psk-spots-changed", ());
        }
        Err(detail) => {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            connectivity::report_source_health(
                &conn,
                SOURCE_ID,
                "PSKReporter",
                Status::Down,
                Via::Internet,
                Some(&detail),
            );
        }
    }
}

pub fn spawn_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        if !connectivity::paused_for_offline(&app, SOURCE_ID, "PSKReporter") {
            poll_once(&app);
        }
        std::thread::sleep(POLL_INTERVAL);
    });
}
