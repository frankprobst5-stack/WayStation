//! Contest calendar ingest, from WA7BNM's ICS feed (contestcalendar.com).
//!
//! Their terms of use forbid bot/spider access in general, but explicitly
//! allow "an ICS feed... to load a calendar of contests into a calendar
//! software application for personal use" — exactly this. Deliberately not
//! using their RSS/XML/JSON options, which are either display-only (RSS,
//! for club websites) or require a written agreement (XML/JSON).
//!
//! No ICS-parsing crate pulled in for a handful of flat VEVENT fields —
//! hand-rolled unfold + line parse, same "small enough to not need a
//! dependency" call as elsewhere in this codebase.

use crate::connectivity::{self, Status, Via};
use crate::db::{self, Db, IncomingContest};
use chrono::{NaiveDateTime, Utc};
use std::collections::HashMap;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const SOURCE_ID: &str = "contest-calendar";
const FEED_URL: &str = "https://www.contestcalendar.com/weeklycontcustom.php";
const POLL_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60); // 8-day rolling list, changes rarely
const USER_AGENT: &str = "Waystation/0.1 (https://github.com/frankprobst5-stack/WayStation)";

fn unfold(body: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in body.lines() {
        if (raw.starts_with(' ') || raw.starts_with('\t')) && !lines.is_empty() {
            let last = lines.last_mut().unwrap();
            last.push_str(&raw[1..]);
        } else {
            lines.push(raw.to_string());
        }
    }
    lines
}

fn parse_ics_datetime(v: &str) -> Option<String> {
    NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%SZ")
        .ok()
        .map(|dt| dt.and_utc().to_rfc3339())
}

fn parse_events(body: &str) -> Vec<IncomingContest> {
    let lines = unfold(body);
    let mut events = Vec::new();
    let mut current: Option<HashMap<String, String>> = None;

    for line in lines {
        if line == "BEGIN:VEVENT" {
            current = Some(HashMap::new());
        } else if line == "END:VEVENT" {
            if let Some(fields) = current.take() {
                let id = fields.get("UID").cloned();
                let label = fields.get("SUMMARY").cloned();
                let starts_at = fields.get("DTSTART").and_then(|v| parse_ics_datetime(v));
                if let (Some(id), Some(label), Some(starts_at)) = (id, label, starts_at) {
                    events.push(IncomingContest {
                        id,
                        label,
                        starts_at,
                        ends_at: fields.get("DTEND").and_then(|v| parse_ics_datetime(v)),
                        detail_url: fields.get("URL").cloned(),
                    });
                }
            }
        } else if let Some(fields) = current.as_mut() {
            // Properties can carry ";PARAM=..." before the colon — key is
            // everything before the first ';' or ':', whichever comes first.
            if let Some(colon) = line.find(':') {
                let key_part = &line[..colon];
                let key = key_part.split(';').next().unwrap_or(key_part).to_string();
                let value = line[colon + 1..].to_string();
                fields.insert(key, value);
            }
        }
    }

    events
}

fn fetch_contests() -> Result<Vec<IncomingContest>, String> {
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

    Ok(parse_events(&body))
}

pub fn poll_once(app: &AppHandle) {
    match fetch_contests() {
        Ok(contests) => {
            let fetched_at = Utc::now().to_rfc3339();
            {
                let db = app.state::<Db>();
                let mut conn = db.0.lock().expect("db mutex poisoned");
                db::replace_contests(&mut conn, SOURCE_ID, &fetched_at, &contests);
                connectivity::report_source_health(
                    &conn,
                    SOURCE_ID,
                    "Contest Calendar",
                    Status::Healthy,
                    Via::Internet,
                    None,
                );
            }
            let _ = app.emit("contests-changed", ());
        }
        Err(detail) => {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            connectivity::report_source_health(
                &conn,
                SOURCE_ID,
                "Contest Calendar",
                Status::Down,
                Via::Internet,
                Some(&detail),
            );
        }
    }
}

pub fn spawn_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        if !connectivity::paused_for_offline(&app, SOURCE_ID, "Contest Calendar") {
            poll_once(&app);
        }
        std::thread::sleep(POLL_INTERVAL);
    });
}
