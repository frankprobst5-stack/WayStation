//! Client for Citadel's real Whisper.cpp transcription service, decided
//! 2026-09-07 -- the "offline audio transcription" Local AI backlog item.
//! Citadel owns the actual model/inference (a real `whisper-server`
//! process, apt-installed `whisper.cpp` 1.8.3, verified live before any
//! of this was written: a real 53-second sample clip transcribed
//! correctly in ~5s on Citadel's real i7-4770), this module is just the
//! client -- same "Citadel captures/computes, WayStation is the
//! operator-facing UI" split as `citadel_scanner.rs`.
//!
//! Reuses `station_profile.citadel_map_host` as the base URL, same
//! reasoning as `citadel_scanner.rs`: it's really just "Citadel's
//! cockpit nginx host," not something transcription needs its own
//! separate setting for.

use crate::db::{self, Db};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::State;

fn citadel_base(host: &Option<String>) -> String {
    let h = host.as_deref().unwrap_or("127.0.0.1:8085").trim().to_string();
    format!("http://{h}")
}

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        // Longer than citadel_scanner.rs's 10s status-poll timeout on
        // purpose: transcription.py's own TRANSCRIBE_TIMEOUT_SECONDS is
        // 60s server-side, and a cold `whisper` container (first-ever
        // request after a restart still finishing its own apt-install/
        // model-load) can take a while before it even starts decoding.
        .timeout(Duration::from_secs(90))
        .build()
        .expect("failed to build reqwest client")
}

fn station_citadel_host(db: &State<Db>) -> Option<String> {
    let conn = db.0.lock().expect("db mutex poisoned");
    db::station_profile(&conn).citadel_map_host
}

/// Mirrors `transcription.py`'s `list_recordings()` output exactly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScannerRecording {
    pub filename: String,
    pub size_bytes: u64,
    pub modified_at: f64,
}

/// Real files trunk-recorder's own captureDir has on disk right now --
/// honestly empty (not an error) until a real RTL-SDR dongle and a
/// running trunk-recorder have actually captured something.
#[tauri::command]
pub fn get_scanner_recordings(db: State<Db>) -> Result<Vec<ScannerRecording>, String> {
    let host = station_citadel_host(&db);
    let url = format!("{}/api/scanner/recordings", citadel_base(&host));
    client()
        .get(&url)
        .send()
        .map_err(|e| format!("could not reach Citadel at {url}: {e}"))?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| format!("Citadel returned something unexpected: {e}"))
}

#[derive(Debug, Deserialize)]
struct TranscribeResponse {
    status: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    detail: Option<String>,
}

/// Transcribes one already-captured recording via Citadel's real
/// `/api/scanner/transcribe`. Deliberately does NOT call
/// `.error_for_status()` before parsing, unlike `get_scanner_recordings`
/// above -- every real error case (invalid filename, missing file,
/// whisper unreachable) still comes back as a real JSON body with a
/// real `detail` message, and calling `.error_for_status()` first would
/// throw that useful text away in favor of a generic "400 Bad Request".
#[tauri::command]
pub fn transcribe_recording(db: State<Db>, filename: String) -> Result<String, String> {
    let host = station_citadel_host(&db);
    let url = format!("{}/api/scanner/transcribe", citadel_base(&host));
    let resp: TranscribeResponse = client()
        .post(&url)
        .json(&serde_json::json!({ "filename": filename }))
        .send()
        .map_err(|e| format!("could not reach Citadel at {url}: {e}"))?
        .json()
        .map_err(|e| format!("Citadel returned something unexpected: {e}"))?;

    if resp.status == "success" {
        resp.text.ok_or_else(|| "Citadel reported success but sent no transcript text".to_string())
    } else {
        Err(resp.detail.unwrap_or_else(|| "transcription failed".to_string()))
    }
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
        assert_eq!(citadel_base(&Some("  192.168.1.50:8085  ".to_string())), "http://192.168.1.50:8085");
    }
}
