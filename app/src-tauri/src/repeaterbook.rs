//! RepeaterBook lookup (Phase 4 operating awareness). As of a March 2026
//! policy change, RepeaterBook's export API requires an approved app
//! token — the operator requests their own at
//! repeaterbook.com/api/token_request.php and enters it in the Station
//! panel. This is an app-level API key, not a personal login password, so
//! (unlike the Winlink account password — see pat.rs) it's appropriate for
//! WayStation to store and use directly.
//!
//! No lat/lon "near me" parameter is documented; search is by US state
//! (converted here to the FIPS code the API actually wants) plus optional
//! city/callsign.

use crate::db::{self, Db};
use serde_json::Value;
use std::time::Duration;
use tauri::{Manager, State};

const USER_AGENT: &str = "Waystation/0.1 (+https://github.com/frankprobst5-stack/WayStation; contact via GitHub issues)";

fn us_state_fips(abbr: &str) -> Option<&'static str> {
    Some(match abbr.to_uppercase().as_str() {
        "AL" => "01", "AK" => "02", "AZ" => "04", "AR" => "05", "CA" => "06",
        "CO" => "08", "CT" => "09", "DE" => "10", "DC" => "11", "FL" => "12",
        "GA" => "13", "HI" => "15", "ID" => "16", "IL" => "17", "IN" => "18",
        "IA" => "19", "KS" => "20", "KY" => "21", "LA" => "22", "ME" => "23",
        "MD" => "24", "MA" => "25", "MI" => "26", "MN" => "27", "MS" => "28",
        "MO" => "29", "MT" => "30", "NE" => "31", "NV" => "32", "NH" => "33",
        "NJ" => "34", "NM" => "35", "NY" => "36", "NC" => "37", "ND" => "38",
        "OH" => "39", "OK" => "40", "OR" => "41", "PA" => "42", "RI" => "44",
        "SC" => "45", "SD" => "46", "TN" => "47", "TX" => "48", "UT" => "49",
        "VT" => "50", "VA" => "51", "WA" => "53", "WV" => "54", "WI" => "55",
        "WY" => "56",
        _ => return None,
    })
}

#[tauri::command]
pub fn search_repeaters(
    app: tauri::AppHandle,
    state: String,
    city: Option<String>,
    callsign: Option<String>,
) -> Result<Vec<Value>, String> {
    let token = {
        let db: State<Db> = app.state();
        let conn = db.0.lock().expect("db mutex poisoned");
        db::station_profile(&conn).repeaterbook_token
    };
    let Some(token) = token else {
        return Err("No RepeaterBook API token set — request one at repeaterbook.com/api/token_request.php and enter it in the Station panel.".to_string());
    };

    let Some(fips) = us_state_fips(&state) else {
        return Err(format!("\"{state}\" isn't a recognized US state abbreviation."));
    };

    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let mut query = vec![("country", "United States".to_string()), ("state_id", fips.to_string())];
    if let Some(c) = &city {
        if !c.is_empty() {
            query.push(("city", c.clone()));
        }
    }
    if let Some(cs) = &callsign {
        if !cs.is_empty() {
            query.push(("callsign", cs.clone()));
        }
    }

    let resp = client
        .get("https://www.repeaterbook.com/api/export.php")
        .query(&query)
        .header("X-RB-App-Token", &token)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("RepeaterBook returned HTTP {}", resp.status()));
    }

    // Response shape isn't fully documented publicly; try the common
    // {"results": [...]} wrapper, then a bare array, before giving up.
    let body: Value = resp.json().map_err(|e| e.to_string())?;
    if let Some(arr) = body.get("results").and_then(Value::as_array) {
        return Ok(arr.clone());
    }
    if let Some(arr) = body.as_array() {
        return Ok(arr.clone());
    }
    Ok(Vec::new())
}
