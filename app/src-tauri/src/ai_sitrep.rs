//! AI narrative synthesis over an already-generated SITREP, per the
//! Planned backlog's "SITREP synthesizer + tactical-shorthand compressor"
//! item and AI-INTEGRATION.md's rules: WayStation builds the prompt from
//! real structured data (a `Sitrep.body` already produced by
//! `db::create_sitrep`, not a guess), sends it to Citadel's local Ollama,
//! and shows the result clearly labeled as AI-generated -- never presented
//! as verified fact, never a replacement for the structured report it
//! summarizes. The underlying SITREP works today with zero AI involvement;
//! this is a pure add-on that degrades to "unavailable" if Citadel/Ollama
//! isn't reachable, not a dependency the structured report needs.
//!
//! Talks to Citadel's cockpit nginx proxy, which forwards `/api/chat` to
//! the real `citadel-ollama` container (confirmed live 2026-09-06: a cold
//! model load took ~23s on the actual running stack, dwarfing the ~10s
//! timeout every other Citadel-facing client in this app uses for a
//! status poll -- this one gets its own, much longer timeout for exactly
//! that reason, not copied from citadel_scanner.rs's client().

use crate::db::{self, Db};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::State;

const OLLAMA_MODEL: &str = "llama3.2:1b";
const AI_TIMEOUT: Duration = Duration::from_secs(120);

fn citadel_base(host: &Option<String>) -> String {
    let h = host.as_deref().unwrap_or("127.0.0.1:8085").trim().to_string();
    format!("http://{h}")
}

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(AI_TIMEOUT)
        .build()
        .expect("failed to build reqwest client")
}

/// Pure and testable without any network: turns a real SITREP body into
/// the instruction Ollama actually receives. Kept separate from the HTTP
/// call itself for exactly that reason -- this is the part a test can
/// check the wording of, the HTTP part is what has to be `#[ignore]`d.
fn build_prompt(sitrep_body: &str) -> String {
    format!(
        "You are assisting an emergency communications operator. Below is a \
         structured situation report (SITREP) generated directly from this \
         station's real incident data. Write a short, plain-language \
         narrative summary (3-5 sentences) of the situation for someone \
         about to take over the shift. Do not invent any fact, name, \
         number, or status that isn't in the SITREP text below -- if \
         something is unclear or missing, say so rather than guessing.\n\n\
         SITREP:\n{sitrep_body}"
    )
}

#[derive(Debug, Serialize)]
struct ChatMessage {
    role: &'static str,
    content: String,
}

#[derive(Debug, Serialize)]
struct ChatRequest {
    model: &'static str,
    messages: Vec<ChatMessage>,
    stream: bool,
}

#[derive(Debug, Deserialize)]
struct ChatResponseMessage {
    content: String,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    message: ChatResponseMessage,
}

fn synthesize(base: &str, sitrep_body: &str) -> Result<String, String> {
    let request = ChatRequest {
        model: OLLAMA_MODEL,
        messages: vec![ChatMessage { role: "user", content: build_prompt(sitrep_body) }],
        stream: false,
    };
    let url = format!("{base}/api/chat");
    let resp = client()
        .post(&url)
        .json(&request)
        .send()
        .map_err(|e| format!("could not reach Citadel/Ollama at {url}: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Citadel/Ollama returned an error: {e}"))?;
    let parsed: ChatResponse = resp.json().map_err(|e| format!("Ollama returned something unexpected: {e}"))?;
    Ok(parsed.message.content.trim().to_string())
}

/// Deliberately takes the SITREP body as a plain argument rather than an
/// incident_id -- the frontend already has the real `Sitrep` it wants
/// summarized (from `get_sitreps`), so this never re-derives or
/// re-generates a report of its own; it only ever narrates one that
/// already exists.
#[tauri::command]
pub fn generate_sitrep_narrative(db: State<Db>, sitrep_body: String) -> Result<String, String> {
    let host = {
        let conn = db.0.lock().expect("db mutex poisoned");
        db::station_profile(&conn).citadel_map_host
    };
    synthesize(&citadel_base(&host), &sitrep_body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_prompt_includes_the_real_sitrep_text_verbatim() {
        let body = "SITUATION REPORT\nIncident: Panhandle Weather\nStatus: OPEN";
        let prompt = build_prompt(body);
        assert!(prompt.contains(body), "prompt must contain the real SITREP text unmodified");
    }

    #[test]
    fn build_prompt_instructs_against_inventing_facts() {
        let prompt = build_prompt("SITUATION REPORT\nIncident: Test");
        assert!(prompt.to_lowercase().contains("invent"), "prompt must explicitly forbid fabricating facts not in the SITREP");
    }

    /// Live-only: exercises the real Citadel cockpit proxy -> real Ollama
    /// container, the same stack confirmed reachable and working by hand
    /// (2026-09-06, `curl` against http://127.0.0.1:8085/api/chat, ~23s
    /// cold model load) before this module was written.
    #[test]
    #[ignore]
    fn synthesize_against_the_real_running_citadel_ollama_produces_nonempty_text() {
        let result = synthesize("http://127.0.0.1:8085", "SITUATION REPORT\nIncident: Test Drill\nStatus: OPEN\nPERSONNEL (0)\n  None assigned");
        let text = result.expect("real Ollama call should succeed against the live stack");
        assert!(!text.is_empty(), "a real model response should not be empty");
    }

    #[test]
    fn synthesize_against_an_unreachable_host_fails_honestly_not_silently() {
        let result = synthesize("http://127.0.0.1:1", "SITUATION REPORT\nIncident: Test");
        assert!(result.is_err(), "an unreachable Citadel host must return a real error, not a fabricated response");
    }
}
