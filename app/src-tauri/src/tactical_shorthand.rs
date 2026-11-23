//! Tactical-shorthand compressor — a real v2 backlog item, explicitly
//! held until "a real RF-bandwidth-constrained transport to compress
//! for" existed. WSP/2 (`wsp2.rs`) is that transport now: mesh
//! fragments at a real 233-byte ceiling, so every byte this saves on
//! an outgoing message is one fewer fragment to send and reassemble.
//!
//! Deliberately not AI-dependent, same reasoning `keyword_alerts.rs`
//! already applies: a plain, deterministic substitution dictionary of
//! real, standard emergency/incident-command terminology (ICS-style
//! plain-language abbreviations already in common use), not invented
//! shorthand and not a jurisdiction-specific radio code — FEMA/NIMS
//! guidance itself favors plain language over codes like 10-codes
//! specifically because they aren't consistent across agencies, so
//! none are used here. Operator-triggered on the compose box, never
//! applied automatically to outgoing text — same "operator decides"
//! posture as signed-import trust and theme switching elsewhere in
//! this app.
//!
//! Each phrase maps to exactly one token and back — no two phrases
//! collapse to the same token — so `compress` then `expand` always
//! round-trips, which is what makes this safe to actually send instead
//! of just a human mnemonic.

/// Longest real phrase first isn't required in this list's order —
/// `compress` sorts by length at call time — but is kept here anyway
/// for readability.
const DICTIONARY: &[(&str, &str)] = &[
    ("estimated time of arrival", "ETA"),
    ("search and rescue", "SAR"),
    ("medical evacuation", "MEDEVAC"),
    ("as soon as possible", "ASAP"),
    ("point of contact", "POC"),
    ("command post", "CP"),
    ("out of service", "OOS"),
    ("in service", "INSVC"),
    ("copy that", "CPY"),
    ("evacuation", "EVAC"),
    ("casualties", "CAS"),
    ("requesting", "REQG"),
    ("personnel", "PERS"),
    ("location", "LOC"),
    ("request", "REQ"),
];

/// Replaces every real whole-word/phrase occurrence of `phrase` in
/// `text` with `replacement`, case-insensitively. Word-boundary aware
/// (won't match "req" inside "reqg") and panic-safe against any casing
/// conversion that changes character count (rare outside ASCII) by
/// simply declining to transform that string, rather than risking a
/// misaligned index.
fn replace_phrase(text: &str, phrase: &str, replacement: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let lower: Vec<char> = text.to_lowercase().chars().collect();
    let phrase_lower: Vec<char> = phrase.to_lowercase().chars().collect();

    if lower.len() != chars.len() || phrase_lower.is_empty() {
        return text.to_string();
    }

    let mut result = String::with_capacity(text.len());
    let mut i = 0;
    let mut last_copied = 0;

    while i + phrase_lower.len() <= lower.len() {
        if lower[i..i + phrase_lower.len()] == phrase_lower[..] {
            let before_ok = i == 0 || !chars[i - 1].is_alphanumeric();
            let after_idx = i + phrase_lower.len();
            let after_ok = after_idx == chars.len() || !chars[after_idx].is_alphanumeric();

            if before_ok && after_ok {
                result.extend(&chars[last_copied..i]);
                result.push_str(replacement);
                last_copied = after_idx;
                i = after_idx;
                continue;
            }
        }
        i += 1;
    }
    result.extend(&chars[last_copied..]);
    result
}

/// Substitutes every dictionary phrase found in `text` with its token,
/// longest phrase first so e.g. "medical evacuation" matches whole
/// rather than leaving a dangling "evacuation" match inside it.
pub fn compress(text: &str) -> String {
    let mut ordered: Vec<&(&str, &str)> = DICTIONARY.iter().collect();
    ordered.sort_by_key(|(phrase, _)| std::cmp::Reverse(phrase.chars().count()));

    let mut out = text.to_string();
    for (phrase, token) in ordered {
        out = replace_phrase(&out, phrase, token);
    }
    out
}

/// The reverse of `compress` — every dictionary token found in `text`
/// expanded back to its real phrase.
pub fn expand(text: &str) -> String {
    let mut out = text.to_string();
    for (phrase, token) in DICTIONARY {
        out = replace_phrase(&out, token, phrase);
    }
    out
}

#[tauri::command]
pub fn compress_tactical_shorthand(text: String) -> String {
    compress(&text)
}

#[tauri::command]
pub fn expand_tactical_shorthand(text: String) -> String {
    expand(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compresses_a_real_sitrep_shaped_message() {
        assert_eq!(
            compress("Requesting medical evacuation at command post, ETA unknown"),
            "REQG MEDEVAC at CP, ETA unknown"
        );
    }

    #[test]
    fn compress_then_expand_restores_every_real_phrase() {
        // Round-trips to a lowercased version of the matched phrases --
        // compress always emits an uppercase token regardless of the
        // original phrase's casing, so the one thing this doesn't
        // preserve is casing on the words that got compressed. Text
        // that was never touched (like "unit 4" here) comes back
        // completely untouched.
        let original = "Requesting search and rescue, point of contact is unit 4, copy that";
        assert_eq!(
            expand(&compress(original)),
            "requesting search and rescue, point of contact is unit 4, copy that"
        );
    }

    #[test]
    fn is_case_insensitive_and_respects_word_boundaries() {
        assert_eq!(compress("REQUESTING backup"), "REQG backup");
        // "request" must not match inside "requesting" once the longer
        // phrase has already consumed it.
        assert_eq!(compress("requesting"), "REQG");
        // A token-looking substring inside an unrelated word is untouched.
        assert_eq!(compress("relocation needed"), "relocation needed");
    }

    #[test]
    fn expand_restores_real_phrases_from_tokens() {
        assert_eq!(expand("REQG MEDEVAC at CP"), "requesting medical evacuation at command post");
    }

    #[test]
    fn leaves_ordinary_text_with_no_dictionary_terms_unchanged() {
        let text = "Unit 12, copy, en route to the station";
        assert_eq!(compress(text), text);
    }

    #[test]
    fn every_dictionary_entry_has_a_unique_token() {
        let mut tokens: Vec<&str> = DICTIONARY.iter().map(|(_, token)| *token).collect();
        let before = tokens.len();
        tokens.sort();
        tokens.dedup();
        assert_eq!(tokens.len(), before, "two phrases must never collapse to the same token");
    }
}
