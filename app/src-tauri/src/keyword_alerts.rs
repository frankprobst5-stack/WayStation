//! Keyword-triggered alert banners, a real v2 backlog item.
//!
//! Deliberately NOT AI-dependent: simple, deterministic keyword matching
//! against transcript text, running entirely locally in this process --
//! no network call, no Citadel, no Ollama. A "structure fire"/"entrapment"
//! trigger still fires even if Citadel's whole AI stack is down, because
//! life-safety alerting shouldn't have an AI dependency anywhere in its
//! chain (the exact reasoning this item was logged under).
//!
//! Real, deliberately small starter list, not an exhaustive CAD-code
//! dictionary -- the two examples this backlog item itself named
//! ("structure fire," "entrapment") plus a handful of other terms that
//! show up in real fire/EMS/law-enforcement radio traffic and mean
//! something has gone seriously wrong, not routine. Matching is a plain
//! case-insensitive substring check, not a word-boundary regex, so a
//! phrase like "possible entrapment" still matches -- real scanner/
//! transcribed speech is rarely a clean exact phrase.

/// Real, named starting point -- edit this list directly for now; a
/// Settings-panel editor is real, separate, un-scoped future work, not
/// invented here just to make this list configurable on day one.
pub const ALERT_KEYWORDS: &[&str] = &[
    "structure fire",
    "entrapment",
    "mayday",
    "officer down",
    "shots fired",
    "explosion",
    "evacuate",
    "evacuation",
];

/// Returns every keyword from `ALERT_KEYWORDS` found in `text`, in list
/// order, deduplicated. Empty means no match -- never guesses or flags
/// "just in case."
pub fn matching_keywords(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    ALERT_KEYWORDS
        .iter()
        .filter(|kw| lower.contains(*kw))
        .map(|kw| kw.to_string())
        .collect()
}

#[tauri::command]
pub fn check_transcript_for_alerts(text: String) -> Vec<String> {
    matching_keywords(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_real_named_example_keyword() {
        assert_eq!(
            matching_keywords("Engine 4, we have a structure fire at 220 Main"),
            vec!["structure fire".to_string()]
        );
    }

    #[test]
    fn matches_case_insensitively() {
        assert_eq!(
            matching_keywords("MAYDAY MAYDAY MAYDAY"),
            vec!["mayday".to_string()]
        );
    }

    #[test]
    fn matches_a_keyword_inside_a_longer_phrase() {
        assert_eq!(
            matching_keywords("possible entrapment reported, requesting extrication"),
            vec!["entrapment".to_string()]
        );
    }

    #[test]
    fn finds_multiple_real_keywords_in_order() {
        let matches = matching_keywords("structure fire reported, mayday called, evacuate the block");
        assert_eq!(matches, vec!["structure fire", "mayday", "evacuate"]);
    }

    #[test]
    fn returns_nothing_for_routine_traffic() {
        assert!(matching_keywords("Unit 12, copy, en route to the station").is_empty());
    }

    #[test]
    fn empty_text_matches_nothing() {
        assert!(matching_keywords("").is_empty());
    }
}
