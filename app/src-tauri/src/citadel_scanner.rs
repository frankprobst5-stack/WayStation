//! Client for Citadel's trunked-radio scanner API, decided 2026-09-05.
//!
//! Citadel is the hardware-hub side -- the actual RTL-SDR dongle and the
//! `trunk-recorder` container both live there (see Citadel's
//! `docker-compose.yml`, a `scanner` service under a `hardware` Compose
//! profile). This module is WayStation's client to Citadel's `/api/scanner`
//! and `/api/scanner/config` routes -- the same "Citadel captures/
//! configures hardware, WayStation is the operator-facing UI" pattern the
//! map-tiles integration already established, just applied to a different
//! endpoint. Per Frank's explicit call (2026-09-05): all comms and
//! emergency-traffic UI lives in WayStation, not a second page on Citadel's
//! cockpit -- Citadel's own comms.html was deleted for exactly this reason.
//!
//! Reuses `station_profile.citadel_map_host` as the base URL. That field is
//! named after its first use (map tiles), but it's really just "Citadel's
//! cockpit nginx host" -- equally valid here, and reusing it avoids a
//! second near-identical setting an operator would have to keep in sync.
//!
//! Talks to Citadel over plain `reqwest` from this Rust backend, same as
//! every other external integration in this app (`nws.rs`, `pota.rs`,
//! `flight_tracking.rs`) -- not a browser `fetch()`, so CORS never enters
//! into it the way it does for the map tiles' PMTiles protocol.

use crate::db::{self, Db};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::State;

fn citadel_base(host: &Option<String>) -> String {
    let h = host.as_deref().unwrap_or("127.0.0.1:8085").trim().to_string();
    format!("http://{h}")
}

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("failed to build reqwest client")
}

fn station_citadel_host(db: &State<Db>) -> Option<String> {
    let conn = db.0.lock().expect("db mutex poisoned");
    db::station_profile(&conn).citadel_map_host
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScannerTranscript {
    #[serde(default)]
    pub talkgroup: Option<String>,
    #[serde(default)]
    pub frequency_mhz: Option<f64>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub duration_sec: Option<f64>,
    #[serde(default)]
    pub transcript_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScannerStatus {
    pub status: String,
    pub updated_at: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub transcripts: Vec<ScannerTranscript>,
}

/// Live scanner status/transcripts for display -- mirrors Citadel's
/// `/api/scanner` shape exactly (see that file's own doc comment for why
/// an honest "no_data" default beats a fabricated "listening" claim).
#[tauri::command]
pub fn get_citadel_scanner_status(db: State<Db>) -> Result<ScannerStatus, String> {
    let host = station_citadel_host(&db);
    let url = format!("{}/api/scanner", citadel_base(&host));
    client()
        .get(&url)
        .send()
        .map_err(|e| format!("could not reach Citadel at {url}: {e}"))?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| format!("Citadel returned something unexpected: {e}"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScannerConfigResponse {
    pub configured: bool,
    #[serde(default)]
    pub config: Option<Value>,
    /// Whichever CSV the saved config actually uses -- talkgroups (trunked)
    /// or channel list (conventional/conventionalP25). Renamed from
    /// `talkgroups_csv` 2026-09-06 when conventional support was added on
    /// Citadel's side; one generic field is honest about there being two
    /// real, differently-shaped CSVs behind it, not one.
    #[serde(default)]
    pub csv_data: Option<String>,
}

/// Reads back whatever is already configured on Citadel, so the setup form
/// can pre-populate rather than being a write-only black box.
#[tauri::command]
pub fn get_citadel_scanner_config(db: State<Db>) -> Result<ScannerConfigResponse, String> {
    let host = station_citadel_host(&db);
    let url = format!("{}/api/scanner/config", citadel_base(&host));
    client()
        .get(&url)
        .send()
        .map_err(|e| format!("could not reach Citadel at {url}: {e}"))?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| format!("Citadel returned something unexpected: {e}"))
}

/// `system_type` is one of "trunked" (control-channel-following -- the
/// original and only shape before 2026-09-06), "conventional" (fixed-
/// frequency analog), or "conventionalP25" (fixed-frequency P25) -- added
/// when Frank brought real conventional Sheriff/Fire/EMS frequencies
/// (PANCOM, Donley County) the trunked-only shape couldn't express at
/// all. `control_channels_hz` only matters for "trunked"; `squelch` only
/// matters for the two conventional types (trunked systems default their
/// own squelch on Citadel's side). Both are sent regardless of type
/// rather than making the request shape conditional -- Citadel's route
/// already ignores whichever field doesn't apply to the chosen type.
#[derive(Debug, Serialize, Deserialize)]
pub struct ScannerConfigRequest {
    pub system_type: String,
    pub short_name: String,
    pub driver: String,
    pub device: Option<String>,
    pub center_hz: f64,
    pub rate_hz: f64,
    pub gain: f64,
    pub control_channels_hz: Vec<i64>,
    pub squelch: f64,
    pub ppm: Option<f64>,
    pub csv_data: String,
}

/// Sends a new setup to Citadel, which validates the whole thing (a
/// well-formed `config.json` AND a well-formed talkgroups CSV, or neither
/// written -- see Citadel's `scanner_config.py`) before writing anything.
/// A rejected config surfaces Citadel's own validation message rather than
/// a generic failure, since that message is specific and actionable (e.g.
/// "Row 3: \"Mode\" must be one of ...").
#[tauri::command]
pub fn save_citadel_scanner_config(db: State<Db>, request: ScannerConfigRequest) -> Result<Value, String> {
    let host = station_citadel_host(&db);
    let url = format!("{}/api/scanner/config", citadel_base(&host));
    let resp = client()
        .post(&url)
        .json(&request)
        .send()
        .map_err(|e| format!("could not reach Citadel at {url}: {e}"))?;
    let status = resp.status();
    let body: Value = resp.json().map_err(|e| format!("Citadel returned something unexpected: {e}"))?;
    if !status.is_success() {
        let detail = body.get("detail").and_then(Value::as_str).unwrap_or("Citadel rejected this configuration");
        return Err(detail.to_string());
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn citadel_base_defaults_to_the_documented_local_cockpit_address() {
        assert_eq!(citadel_base(&None), "http://127.0.0.1:8085");
    }

    #[test]
    fn citadel_base_uses_a_configured_host_and_trims_whitespace() {
        assert_eq!(citadel_base(&Some(" 192.168.1.50:8085 ".to_string())), "http://192.168.1.50:8085");
    }

    /// `#[ignore]`d because it needs a real running Citadel instance on
    /// localhost:8085, same discipline `mesh.rs`/`transport.rs` already
    /// use for tests that need real external services. Bypasses
    /// `State<Db>` (not constructible outside a live Tauri app) by calling
    /// the same URLs directly -- the point is proving Citadel's real JSON
    /// shape actually deserializes into `ScannerConfigResponse`/
    /// `ScannerStatus`, not exercising the Tauri command wrapper itself.
    /// Run with: cargo test --lib citadel_scanner -- --ignored
    #[test]
    #[ignore]
    fn real_round_trip_against_a_live_citadel_instance() {
        let base = "http://127.0.0.1:8085";
        let status: ScannerStatus = client().get(format!("{base}/api/scanner")).send().unwrap().json().unwrap();
        assert!(!status.status.is_empty(), "a real Citadel instance must always return a status field");

        let before: ScannerConfigResponse = client().get(format!("{base}/api/scanner/config")).send().unwrap().json().unwrap();

        let request = ScannerConfigRequest {
            system_type: "trunked".to_string(),
            short_name: "test".to_string(),
            driver: "osmosdr".to_string(),
            device: Some("rtl=0".to_string()),
            center_hz: 857_000_000.0,
            rate_hz: 8_000_000.0,
            gain: 40.0,
            control_channels_hz: vec![855_462_500],
            squelch: -50.0,
            ppm: None,
            csv_data: "Decimal,Mode,Description\n101,D,Test Talkgroup\n".to_string(),
        };
        let post_resp = client().post(format!("{base}/api/scanner/config")).json(&request).send().unwrap();
        assert!(post_resp.status().is_success(), "a well-formed config must be accepted");

        let after: ScannerConfigResponse = client().get(format!("{base}/api/scanner/config")).send().unwrap().json().unwrap();
        assert!(after.configured);
        assert_eq!(after.config.unwrap()["systems"][0]["shortName"], "test");

        // Leave Citadel the way this test found it -- a real integration
        // test shouldn't have a side effect that outlives it.
        if !before.configured {
            let _ = std::fs::remove_file("/home/frank/citadel/appdata/media-vault/scanner/config.json");
            let _ = std::fs::remove_file("/home/frank/citadel/appdata/media-vault/scanner/talkgroups.csv");
        }
    }

    /// Live-only, same discipline as the trunked round trip above --
    /// proves the conventional-system path (added 2026-09-06 for real
    /// PANCOM/Donley County frequencies) actually round-trips against the
    /// real running Citadel instance, not just Citadel's own Python tests.
    #[test]
    #[ignore]
    fn real_conventional_round_trip_against_a_live_citadel_instance() {
        let base = "http://127.0.0.1:8085";
        let before: ScannerConfigResponse = client().get(format!("{base}/api/scanner/config")).send().unwrap().json().unwrap();

        let request = ScannerConfigRequest {
            system_type: "conventionalP25".to_string(),
            short_name: "test".to_string(),
            driver: "osmosdr".to_string(),
            device: Some("rtl=0".to_string()),
            center_hz: 155_000_000.0,
            rate_hz: 2_400_000.0,
            gain: 40.0,
            control_channels_hz: vec![],
            squelch: -60.0,
            ppm: None,
            csv_data: "TG Number,Frequency,Tone,Alpha Tag,Description\n1,154.3475,,Sheriff E,Sheriff Repeater East PANCOM\n".to_string(),
        };
        let post_resp = client().post(format!("{base}/api/scanner/config")).json(&request).send().unwrap();
        assert!(post_resp.status().is_success(), "a well-formed conventional config must be accepted");

        let after: ScannerConfigResponse = client().get(format!("{base}/api/scanner/config")).send().unwrap().json().unwrap();
        assert!(after.configured);
        assert_eq!(after.config.as_ref().unwrap()["systems"][0]["type"], "conventionalP25");
        assert_eq!(after.config.unwrap()["systems"][0]["channelFile"], "channels.csv");
        assert!(after.csv_data.unwrap().contains("Sheriff Repeater East PANCOM"));

        if !before.configured {
            let _ = std::fs::remove_file("/home/frank/citadel/appdata/media-vault/scanner/config.json");
            let _ = std::fs::remove_file("/home/frank/citadel/appdata/media-vault/scanner/channels.csv");
        }
    }
}
