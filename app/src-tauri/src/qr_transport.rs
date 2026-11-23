//! QR-code packet transport -- zero-radio, zero-network message exchange
//! via a sequence of QR codes one device displays and another
//! photographs. Closes the real gap `ROADMAP.md`'s "Interoperability &
//! reach" review named from a direct comparison against XTOC (MKME's
//! commercial tactical-ops suite): XTOC can turn a SITREP into a QR code
//! another device just photographs, no radio and no network needed at
//! all, and WayStation had nothing like it.
//!
//! Ports the real, tested 3-of-4 erasure-coded scheme Keith B. Phillips's
//! `qrcoder` (github.com/keithbphillips/qrcoder, MIT) already built and
//! verified working -- checked directly against that project's own
//! `codec.js` before writing anything here, not re-derived from the
//! README's prose description. Wire-format compatible with it on
//! purpose, not just functionally similar: a card this module produces
//! can be read by `qrcoder`'s own `qrreader` web app (useful when this
//! station has no camera of its own but a nearby phone does), and a card
//! made by `qrcoder`'s `qrbookmark` app can be read back in here. The
//! real mechanism, confirmed from `codec.js` directly:
//!
//! 1. The message text is compressed with raw DEFLATE (no zlib/gzip
//!    header -- `CompressionStream('deflate-raw')` on their side,
//!    `flate2`'s plain `DeflateEncoder`/`DeflateDecoder` here).
//! 2. The compressed bytes are split into 3 equal-length (zero-padded)
//!    shards, plus a 4th shard that's their byte-wise XOR -- any 3 of
//!    the 4 fully recovers the original (the missing one, if any, is
//!    just the XOR of the other 3).
//! 3. Each shard becomes one panel: `idx:4:per:total:card_id:shard`,
//!    `card_id` in base36 and the shard itself in base32 (RFC4648's
//!    alphabet) -- base32, not base64, because QR's own alphanumeric
//!    encoding mode (0-9, A-Z, space, `$%*+-./:`) covers base32's
//!    character set but not base64's, so a base32 shard packs into a QR
//!    code using fewer bits per character than base64 would.
//! 4. Each panel string becomes its own QR code image.
//!
//! What this version deliberately does NOT do, named honestly: no live
//! webcam capture. Decoding reads an already-saved image file (a photo
//! taken on another device, or a screenshot), picked via the same
//! `@tauri-apps/plugin-dialog` file picker every other import flow in
//! this app already uses. A real webcam-based live scan is a genuine,
//! separate follow-on -- not blocked on anything in particular, just not
//! built here. Also not built: wiring this into `transport.rs`'s
//! `Transport` trait so a dispatched message can choose "QR card" as a
//! delivery method automatically -- this is a standalone encode/decode
//! workspace (its own panel) for now, the same real, working, honestly-
//! scoped vertical slice this codebase ships for a new capability before
//! deeper pipeline integration (see e.g. the scanner subsystem's own
//! staged rollout).

use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use image::Luma;
use std::collections::HashMap;
use std::io::{Cursor, Read, Write};
use std::sync::Mutex;

const B32_ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE36_DIGITS: &[u8; 36] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

fn b32_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity((bytes.len() * 8).div_ceil(5));
    let mut bits = 0u32;
    let mut val = 0u32;
    for &b in bytes {
        val = (val << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(B32_ALPHABET[((val >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(B32_ALPHABET[((val << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// Matches `codec.js`'s own `b32d` exactly: any character outside the
/// alphabet (including lowercase, which the real encoder never produces)
/// is silently skipped rather than rejected -- not this module's own
/// choice, the real upstream behavior it has to match to stay
/// wire-compatible.
fn b32_decode(s: &str) -> Vec<u8> {
    let mut map = [-1i16; 128];
    for (i, &c) in B32_ALPHABET.iter().enumerate() {
        map[c as usize] = i as i16;
    }
    let mut bits = 0u32;
    let mut val = 0u32;
    let mut out = Vec::new();
    for c in s.chars() {
        if !c.is_ascii() {
            continue;
        }
        let v = map[c as usize];
        if v < 0 {
            continue;
        }
        val = (val << 5) | v as u32;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((val >> bits) & 255) as u8);
        }
    }
    out
}

fn base36_encode_upper(mut n: u32) -> String {
    if n == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(BASE36_DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("base36 digits are all valid ASCII")
}

fn base36_decode(s: &str) -> Option<u32> {
    if s.is_empty() {
        return None;
    }
    let mut n: u64 = 0;
    for c in s.chars() {
        let d = match c.to_ascii_uppercase() {
            '0'..='9' => c as u64 - '0' as u64,
            'A'..='Z' => c.to_ascii_uppercase() as u64 - 'A' as u64 + 10,
            _ => return None,
        };
        n = n.checked_mul(36)?.checked_add(d)?;
        if n > u32::MAX as u64 {
            return None;
        }
    }
    Some(n as u32)
}

fn deflate_raw(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data).map_err(|e| e.to_string())?;
    encoder.finish().map_err(|e| e.to_string())
}

fn inflate_raw(data: &[u8]) -> Result<String, String> {
    let mut decoder = DeflateDecoder::new(data);
    let mut out = String::new();
    decoder.read_to_string(&mut out).map_err(|e| format!("could not inflate/decode as UTF-8: {e}"))?;
    Ok(out)
}

/// Splits compressed bytes into the real 3-data-plus-1-parity shard set
/// `codec.js`'s own `shardify` produces: `per` is `ceil(len/3)`, the last
/// data shard zero-padded if `len` isn't a multiple of 3, and the 4th
/// shard is the byte-wise XOR of the first three.
fn shardify(data: &[u8]) -> (Vec<Vec<u8>>, usize) {
    let per = data.len().div_ceil(3).max(1);
    let mut shards: Vec<Vec<u8>> = (0..3)
        .map(|i| {
            let start = (i * per).min(data.len());
            let end = ((i + 1) * per).min(data.len());
            let mut s = vec![0u8; per];
            s[..end - start].copy_from_slice(&data[start..end]);
            s
        })
        .collect();
    let mut parity = vec![0u8; per];
    for j in 0..per {
        parity[j] = shards[0][j] ^ shards[1][j] ^ shards[2][j];
    }
    shards.push(parity);
    (shards, per)
}

/// Reverses `shardify`: given any 3 of the 4 shards (the 4th, if
/// missing, recovered by XORing the other 3 together -- the same
/// property that makes this scheme tolerant of losing any one panel to
/// a tear, smudge, or failed scan), concatenates the three data shards
/// and truncates to the real original length (undoing the zero-padding
/// `shardify` added). `None` only when more than one of the four is
/// missing -- unrecoverable, matching `codec.js`'s own `reassemble`.
fn reassemble(got: &[Option<Vec<u8>>; 4], per: usize, total: usize) -> Option<Vec<u8>> {
    let missing: Vec<usize> = (0..4).filter(|&i| got[i].is_none()).collect();
    if missing.len() > 1 {
        return None;
    }
    let mut resolved: Vec<Vec<u8>> = (0..4).map(|i| got[i].clone().unwrap_or_else(|| vec![0u8; per])).collect();
    if let Some(&m) = missing.first() {
        let mut recovered = vec![0u8; per];
        for (j, slot) in recovered.iter_mut().enumerate() {
            let mut v = 0u8;
            for (k, shard) in resolved.iter().enumerate() {
                if k != m {
                    v ^= shard[j];
                }
            }
            *slot = v;
        }
        resolved[m] = recovered;
    }
    let mut out = Vec::with_capacity(per * 3);
    out.extend_from_slice(&resolved[0]);
    out.extend_from_slice(&resolved[1]);
    out.extend_from_slice(&resolved[2]);
    out.truncate(total);
    Some(out)
}

/// One panel's decoded wire fields -- the real shape `codec.js`'s
/// `parseFragment` produces, just as a Rust struct instead of a plain
/// object.
#[derive(Debug, Clone, PartialEq)]
struct Fragment {
    idx: u8,
    per: usize,
    total: usize,
    card_id: u32,
    shard: Vec<u8>,
}

fn wrap_fragment(idx: u8, shard: &[u8], per: usize, total: usize, card_id: u32) -> String {
    format!("{idx}:4:{per}:{total}:{}:{}", base36_encode_upper(card_id), b32_encode(shard))
}

/// Parses one panel's raw text back into its fields. Matches
/// `codec.js`'s `parseFragment` field-for-field: `idx` in `[0,4)`, the
/// constant `4` (total panel count, always 4 for this 3-of-4 scheme),
/// `per`/`total` both positive, a valid base36 `card_id`, and a shard
/// that decodes to at least `per` bytes (sliced down to exactly `per` --
/// base32 decoding can produce a few extra trailing bits that don't form
/// a full byte, same as the real encoder's own slack).
fn parse_fragment(frag: &str) -> Option<Fragment> {
    let parts: Vec<&str> = frag.split(':').collect();
    if parts.len() < 6 {
        return None;
    }
    let idx: u8 = parts[0].parse().ok()?;
    let tot: u32 = parts[1].parse().ok()?;
    let per: usize = parts[2].parse().ok()?;
    let total: usize = parts[3].parse().ok()?;
    if idx >= 4 || tot != 4 || per == 0 || total == 0 {
        return None;
    }
    let card_id = base36_decode(parts[4])?;
    let shard = b32_decode(parts[5]);
    if shard.len() < per {
        return None;
    }
    Some(Fragment { idx, per, total, card_id, shard: shard[..per].to_vec() })
}

/// Accepts either a bare panel fragment or a full URL carrying one after
/// a `#` -- `codec.js`'s own `unwrap()` has to handle both, since
/// `qrbookmark`'s real panels are a tappable URL (so a stock phone
/// camera shows something useful even with no reader app installed),
/// while this module's own `generate_qr_card` emits the bare fragment
/// directly (no web app to open). Reading either form back is what
/// keeps the two actually interoperable, not just wire-format-compatible
/// in theory.
fn parse_wire_text(text: &str) -> Option<Fragment> {
    let frag = match text.find('#') {
        Some(i) => &text[i + 1..],
        None => text,
    };
    parse_fragment(frag)
}

/// Encodes `text` as a real 4-panel card: compress, shard, wrap each
/// shard as a panel string. `card_id` is the caller's to generate --
/// kept as a plain parameter (not generated in here) so the pure
/// encode/decode round trip is deterministic and testable without
/// involving any randomness.
fn encode_fragments(text: &str, card_id: u32) -> Result<Vec<String>, String> {
    let compressed = deflate_raw(text.as_bytes())?;
    let (shards, per) = shardify(&compressed);
    let total = compressed.len();
    Ok((0..4u8).map(|i| wrap_fragment(i, &shards[i as usize], per, total, card_id)).collect())
}

/// The reverse: given at least 3 of a card's 4 real panel strings (any
/// 3, any order), reconstructs the original text. Rejects panels that
/// don't actually belong to the same card -- a real, worth-catching
/// mistake (feeding in panels photographed from two different cards),
/// not something to silently mix together.
fn decode_fragments(fragments: &[String]) -> Result<String, String> {
    let mut got: [Option<Vec<u8>>; 4] = [None, None, None, None];
    let mut per = None;
    let mut total = None;
    let mut card_id: Option<u32> = None;
    for f in fragments {
        let frag = parse_wire_text(f).ok_or_else(|| format!("not a real QR-card panel: {f}"))?;
        match card_id {
            Some(existing) if existing != frag.card_id => {
                return Err("these panels belong to different cards and can't be combined".to_string());
            }
            _ => card_id = Some(frag.card_id),
        }
        per = Some(frag.per);
        total = Some(frag.total);
        got[frag.idx as usize] = Some(frag.shard);
    }
    let per = per.ok_or("no panels provided")?;
    let total = total.ok_or("no panels provided")?;
    let have = got.iter().filter(|g| g.is_some()).count();
    if have < 3 {
        return Err(format!("only {have} of 4 panels present -- need at least 3 of 4 to reconstruct this card"));
    }
    let compressed = reassemble(&got, per, total).ok_or("reassembly failed")?;
    inflate_raw(&compressed)
}

fn render_qr_png(text: &str) -> Result<Vec<u8>, String> {
    let code = qrcode::QrCode::new(text.as_bytes()).map_err(|e| e.to_string())?;
    let image = code.render::<Luma<u8>>().build();
    let mut out = Vec::new();
    {
        let mut cursor = Cursor::new(&mut out);
        image.write_to(&mut cursor, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// One rendered panel, ready for the frontend to show as `<img
/// src="data:image/png;base64,...">` -- no asset-protocol scope or temp
/// file needed, matching how small this payload actually is (a few
/// hundred bytes of QR image per panel).
#[derive(serde::Serialize)]
pub struct QrPanel {
    pub idx: u8,
    pub png_base64: String,
}

/// Generates a real 4-panel card for `text`: encodes, shards, and
/// renders each panel as a PNG. `card_id` is random (not derived from
/// the text or a counter) so two cards made from similar/identical text
/// still get genuinely distinct ids -- `decode_fragments`'s own
/// different-card rejection above is only useful if ids are actually
/// unlikely to collide.
#[tauri::command]
pub fn generate_qr_card(text: String) -> Result<Vec<QrPanel>, String> {
    if text.is_empty() {
        return Err("nothing to encode".to_string());
    }
    let card_id = u32::from_be_bytes(uuid::Uuid::new_v4().as_bytes()[0..4].try_into().expect("4 bytes"));
    let fragments = encode_fragments(&text, card_id)?;
    fragments
        .iter()
        .enumerate()
        .map(|(i, frag_text)| Ok(QrPanel { idx: i as u8, png_base64: base64_encode(&render_qr_png(frag_text)?) }))
        .collect()
}

/// One card's accumulated progress -- every real panel decoded for it so
/// far, the thing `import_qr_image` below both updates and reports back,
/// same shape `wsp2::Reassembler`'s own in-progress tracking takes for a
/// different real transport.
struct CardProgress {
    per: usize,
    total: usize,
    shards: [Option<Vec<u8>>; 4],
}

/// Tracks in-progress cards across however many separate photo imports
/// it takes to gather 3 of their 4 panels -- an operator realistically
/// imports one photo at a time, not all four in one call.
#[derive(Default)]
pub struct QrImportState {
    cards: Mutex<HashMap<u32, CardProgress>>,
}

impl QrImportState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// What the frontend sees after importing one image: which card(s) this
/// photo's panel(s) belong to (a single photo can hold more than one
/// panel if several were framed in the same shot -- `rqrr` detects every
/// QR code it finds, not just the first), how many of each card's 4
/// panels are now in hand, and the reconstructed text the moment any
/// card reaches 3.
#[derive(serde::Serialize)]
pub struct QrCardStatus {
    pub card_id: String,
    pub panels_present: usize,
    pub decoded_text: Option<String>,
}

/// Reads an image file (a photo of one or more panels, or a screenshot),
/// finds every QR code `rqrr` can detect in it, and folds each one's
/// decoded panel into this card's running progress. Deliberately file-
/// based, not a live camera feed -- see this module's own doc for why.
#[tauri::command]
pub fn import_qr_image(path: String, state: tauri::State<QrImportState>) -> Result<Vec<QrCardStatus>, String> {
    let img = image::open(&path).map_err(|e| format!("could not open {path}: {e}"))?.to_luma8();
    let mut prepared = rqrr::PreparedImage::prepare(img);
    let grids = prepared.detect_grids();
    if grids.is_empty() {
        return Err("no QR code shape found in this image".to_string());
    }

    let mut touched_cards = Vec::new();
    for grid in grids {
        let (_, content) = match grid.decode() {
            Ok(v) => v,
            Err(e) => {
                eprintln!("qr_transport: found a QR shape but could not decode its content: {e:?}");
                continue;
            }
        };
        let Some(frag) = parse_wire_text(&content) else {
            eprintln!("qr_transport: decoded a QR code, but it isn't a real QR-card panel: {content}");
            continue;
        };

        let mut cards = state.cards.lock().expect("qr import state mutex poisoned");
        let entry = cards.entry(frag.card_id).or_insert_with(|| CardProgress { per: frag.per, total: frag.total, shards: [None, None, None, None] });
        entry.shards[frag.idx as usize] = Some(frag.shard);
        if !touched_cards.contains(&frag.card_id) {
            touched_cards.push(frag.card_id);
        }
    }

    if touched_cards.is_empty() {
        return Err("every QR code in this image failed to decode as a real QR-card panel".to_string());
    }

    let cards = state.cards.lock().expect("qr import state mutex poisoned");
    Ok(touched_cards
        .into_iter()
        .map(|card_id| {
            let progress = &cards[&card_id];
            let panels_present = progress.shards.iter().filter(|s| s.is_some()).count();
            let decoded_text = if panels_present >= 3 {
                reassemble(&progress.shards, progress.per, progress.total).and_then(|bytes| inflate_raw(&bytes).ok())
            } else {
                None
            };
            QrCardStatus { card_id: base36_encode_upper(card_id), panels_present, decoded_text }
        })
        .collect())
}

/// Every card with at least one real panel imported so far -- lets the
/// frontend redraw progress on mount/refresh without re-importing an
/// image, same reason `get_pending_manifest_fragments` exists for
/// WSP/2's own in-progress tracking.
#[tauri::command]
pub fn get_qr_import_progress(state: tauri::State<QrImportState>) -> Vec<QrCardStatus> {
    let cards = state.cards.lock().expect("qr import state mutex poisoned");
    cards
        .iter()
        .map(|(&card_id, progress)| {
            let panels_present = progress.shards.iter().filter(|s| s.is_some()).count();
            let decoded_text = if panels_present >= 3 {
                reassemble(&progress.shards, progress.per, progress.total).and_then(|bytes| inflate_raw(&bytes).ok())
            } else {
                None
            };
            QrCardStatus { card_id: base36_encode_upper(card_id), panels_present, decoded_text }
        })
        .collect()
}

/// Discards one card's in-progress panels -- the operator's own call
/// when a partial import was a mistake (wrong photo, wrong card), not
/// something this module decides to do on its own.
#[tauri::command]
pub fn clear_qr_import(card_id: String, state: tauri::State<QrImportState>) -> Result<(), String> {
    let id = base36_decode(&card_id).ok_or_else(|| format!("{card_id} is not a real base36 card id"))?;
    state.cards.lock().expect("qr import state mutex poisoned").remove(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_round_trips_real_bytes() {
        let bytes = b"a realistic SITREP payload, compressed bytes stand in here";
        let encoded = b32_encode(bytes);
        assert_eq!(b32_decode(&encoded), bytes.to_vec());
    }

    #[test]
    fn base32_decode_skips_characters_outside_the_alphabet_same_as_the_real_js_decoder() {
        // Matches codec.js's own b32d: anything not in the uppercase
        // alphabet (lowercase included) is skipped, not rejected.
        assert_eq!(b32_decode("ab"), b32_decode(""));
    }

    #[test]
    fn base36_round_trips_including_zero_and_a_large_value() {
        for n in [0u32, 1, 35, 36, 1_000_000, u32::MAX] {
            assert_eq!(base36_decode(&base36_encode_upper(n)), Some(n), "failed for {n}");
        }
    }

    #[test]
    fn base36_decode_rejects_non_base36_text() {
        assert_eq!(base36_decode("!!!"), None);
        assert_eq!(base36_decode(""), None);
    }

    #[test]
    fn deflate_raw_round_trips_real_text() {
        let text = "SITREP: structure fire, 3rd and Main, requesting mutual aid -- KJ4ESQ";
        let compressed = deflate_raw(text.as_bytes()).expect("deflate");
        assert_eq!(inflate_raw(&compressed).expect("inflate"), text);
    }

    #[test]
    fn deflate_raw_actually_shrinks_a_realistically_repetitive_message() {
        // A short, mostly-unique string like a single SITREP line can
        // legitimately come out the same size or larger after DEFLATE's
        // own block overhead -- real, not a bug. A longer message with
        // real repeated structure (the kind an actual multi-line SITREP
        // or net roster has) is what the compression step is for, so
        // that's what this asserts shrinks.
        let text = "SITREP update: all units hold position. SITREP update: all units hold position. SITREP update: all units hold position.";
        let compressed = deflate_raw(text.as_bytes()).expect("deflate");
        assert!(compressed.len() < text.len(), "a genuinely repetitive message should compress smaller ({} vs {})", compressed.len(), text.len());
    }

    #[test]
    fn shardify_and_reassemble_round_trip_with_nothing_missing() {
        let data: Vec<u8> = (0..97u32).map(|i| (i % 256) as u8).collect();
        let (shards, per) = shardify(&data);
        assert_eq!(shards.len(), 4);
        let got: [Option<Vec<u8>>; 4] = [Some(shards[0].clone()), Some(shards[1].clone()), Some(shards[2].clone()), Some(shards[3].clone())];
        let out = reassemble(&got, per, data.len()).expect("reassemble");
        assert_eq!(out, data);
    }

    #[test]
    fn reassemble_recovers_from_losing_any_single_one_of_the_four_shards() {
        let data: Vec<u8> = (0..250u32).map(|i| (i % 256) as u8).collect();
        let (shards, per) = shardify(&data);
        for missing in 0..4 {
            let got: [Option<Vec<u8>>; 4] = std::array::from_fn(|i| if i == missing { None } else { Some(shards[i].clone()) });
            let out = reassemble(&got, per, data.len()).unwrap_or_else(|| panic!("should recover with only index {missing} missing"));
            assert_eq!(out, data, "failed recovering with index {missing} missing");
        }
    }

    #[test]
    fn reassemble_fails_when_two_shards_are_missing() {
        let data = vec![1u8, 2, 3, 4, 5, 6];
        let (shards, per) = shardify(&data);
        let got: [Option<Vec<u8>>; 4] = [Some(shards[0].clone()), None, None, Some(shards[3].clone())];
        assert_eq!(reassemble(&got, per, data.len()), None);
    }

    #[test]
    fn fragment_wire_format_round_trips() {
        let shard = vec![0xDEu8, 0xAD, 0xBE, 0xEF, 0x01];
        let wrapped = wrap_fragment(2, &shard, 5, 12, 123_456);
        let parsed = parse_fragment(&wrapped).expect("parse");
        assert_eq!(parsed, Fragment { idx: 2, per: 5, total: 12, card_id: 123_456, shard });
    }

    #[test]
    fn parse_wire_text_strips_a_url_prefix_before_the_hash_same_as_qrbookmarks_own_panels() {
        let shard = vec![1u8, 2, 3];
        let bare = wrap_fragment(0, &shard, 3, 7, 42);
        let as_url = format!("https://example.invalid/qrreader/#{bare}");
        assert_eq!(parse_wire_text(&as_url), parse_wire_text(&bare));
    }

    #[test]
    fn parse_fragment_rejects_real_malformed_input() {
        assert!(parse_fragment("not:enough:fields").is_none());
        assert!(parse_fragment("4:4:5:12:3A:AAAA").is_none(), "idx must be 0-3");
        assert!(parse_fragment("0:3:5:12:3A:AAAA").is_none(), "tot must be exactly 4 for this scheme");
        assert!(parse_fragment("0:4:0:12:3A:AAAA").is_none(), "per must be positive");
    }

    #[test]
    fn end_to_end_encode_then_decode_with_any_three_of_four_panels_recovers_the_real_text() {
        let text = "MEDEVAC requested, grid square EM13oh, 2 patients, LZ secured -- KJ4ESQ";
        let fragments = encode_fragments(text, 999).expect("encode");
        assert_eq!(fragments.len(), 4);

        // Drop one panel at a time -- every remaining trio must still
        // recover the exact original text, the whole point of this
        // scheme.
        for drop in 0..4 {
            let subset: Vec<String> = fragments.iter().enumerate().filter(|(i, _)| *i != drop).map(|(_, f)| f.clone()).collect();
            assert_eq!(decode_fragments(&subset).unwrap_or_else(|e| panic!("dropping panel {drop} should still decode: {e}")), text);
        }
    }

    #[test]
    fn decode_fragments_fails_honestly_with_only_two_of_four_panels() {
        let fragments = encode_fragments("short message", 1).expect("encode");
        let err = decode_fragments(&fragments[0..2]).unwrap_err();
        assert!(err.contains("only 2 of 4"));
    }

    #[test]
    fn decode_fragments_rejects_panels_from_two_different_cards() {
        let a = encode_fragments("message A", 1).expect("encode");
        let b = encode_fragments("message B", 2).expect("encode");
        let mixed = vec![a[0].clone(), a[1].clone(), b[2].clone()];
        let err = decode_fragments(&mixed).unwrap_err();
        assert!(err.contains("different cards"));
    }

    #[test]
    fn generate_qr_card_produces_four_real_decodable_png_panels() {
        let panels = generate_qr_card("a real test message for the QR transport".to_string()).expect("generate");
        assert_eq!(panels.len(), 4);
        for p in &panels {
            let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &p.png_base64).expect("valid base64");
            // A real PNG always starts with this 8-byte signature.
            assert_eq!(&bytes[0..8], &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        }
    }

    #[test]
    fn rendered_qr_panels_round_trip_through_a_real_rqrr_decode() {
        // Proves this module's own encoder and decoder actually agree,
        // using the real PNG bytes generate_qr_card produces and the
        // real rqrr scanner import_qr_image uses -- not just the pure
        // string-level wire format tests above.
        let text = "round trip through a real rendered QR image, not just the wire string";
        let card_id = 777u32;
        let fragments = encode_fragments(text, card_id).expect("encode");

        let mut decoded_panels = Vec::new();
        for frag_text in &fragments[0..3] {
            let png = render_qr_png(frag_text).expect("render");
            let img = image::load_from_memory(&png).expect("decode png").to_luma8();
            let mut prepared = rqrr::PreparedImage::prepare(img);
            let grids = prepared.detect_grids();
            assert_eq!(grids.len(), 1, "each rendered panel should contain exactly one QR code");
            let (_, content) = grids.into_iter().next().unwrap().decode().expect("rqrr decode");
            decoded_panels.push(content);
        }

        assert_eq!(decode_fragments(&decoded_panels).expect("decode"), text);
    }
}
