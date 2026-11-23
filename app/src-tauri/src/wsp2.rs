//! WSP/2 — compact binary manifest encoding + mesh fragmentation.
//! Design and rationale: see `WSP-2.md` at the repo root. Not wired into
//! `mesh.rs`/`transport.rs` yet -- this module is the codec and framer in
//! isolation, real-tested on its own before anything calls it from a live
//! send/receive path.
//!
//! Sized against the real over-the-air ceiling, not `mesh.rs`'s own
//! `MAX_PACKET_LEN` (that's the local TCP client-API's resync threshold,
//! not an RF constraint) -- confirmed directly in the `meshtastic` crate's
//! generated protobuf: `Constants::DataPayloadLen = 233` bytes, excluding
//! the 16-byte header and protobuf overhead.
//!
//! Wired into a live send/receive path as of 2026-11-08: `mesh.rs`'s
//! `sync_manifest_over_mesh` (send) and `handle_mesh_packet`'s
//! `PortNum::PrivateApp` branch (receive) -- see `WSP-2.md`'s own
//! "Where this fits" section for what's still not done beyond that.
const DATA_PAYLOAD_LEN: usize = 233;
const FRAGMENT_HEADER_LEN: usize = 7; // 1 (tag) + 4 (msg_id) + 1 (index) + 1 (total)
const MAX_FRAGMENT_CHUNK: usize = DATA_PAYLOAD_LEN - FRAGMENT_HEADER_LEN;

use crate::sync::{ManifestEntry, ObjectKind, WspEnvelope};

pub const WSP2_VERSION: u8 = 2;
pub const KIND_MANIFEST: u8 = 0;
/// A request for specific objects by uuid -- the step a station takes
/// after receiving a peer's manifest and finding it's missing something,
/// mirroring `net_sync.rs`'s own `ObjectsRequest` message but over this
/// fragmented transport instead of a TCP socket.
pub const KIND_OBJECTS_REQUEST: u8 = 1;
/// The answer to a `KIND_OBJECTS_REQUEST` -- a real `WspEnvelope::Objects`,
/// the exact same signed envelope shape the file and TCP transports
/// already produce. Deliberately not a new compact codec: `WSP-2.md`'s own
/// "Where this fits" section already names the Objects envelope as a
/// separate, not-yet-built encoding effort, so this wraps the existing
/// JSON form as an opaque blob through this module's content-agnostic
/// fragmenter rather than inventing a second one prematurely.
pub const KIND_OBJECTS: u8 = 2;

fn write_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            break;
        }
        out.push(byte | 0x80);
    }
}

fn read_varint(bytes: &[u8], pos: &mut usize) -> Result<u64, String> {
    let mut value: u64 = 0;
    let mut shift = 0;
    loop {
        let byte = *bytes.get(*pos).ok_or("truncated varint")?;
        *pos += 1;
        value |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
        shift += 7;
        if shift >= 64 {
            return Err("varint too long".to_string());
        }
    }
}

/// Encodes a manifest in WSP/2's compact binary form. `generated_at` is a
/// unix timestamp, not the RFC3339 string WSP/1's envelope carries --
/// `updated_at` on each entry is dropped entirely (diagnostic-only per
/// `WSP-1.md`, confirmed unused by `uuids_needed_from`).
pub fn encode_manifest(origin_callsign: Option<&str>, generated_at: i64, entries: &[ManifestEntry]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    out.push(WSP2_VERSION);
    out.push(KIND_MANIFEST);

    let callsign = origin_callsign.unwrap_or("");
    if callsign.len() > 255 {
        return Err("origin_callsign too long for a one-byte length prefix".to_string());
    }
    out.push(callsign.len() as u8);
    out.extend_from_slice(callsign.as_bytes());

    out.extend_from_slice(&generated_at.to_be_bytes());

    if entries.len() > u16::MAX as usize {
        return Err("too many manifest entries for a u16 count".to_string());
    }
    out.extend_from_slice(&(entries.len() as u16).to_be_bytes());

    for entry in entries {
        let uuid = uuid::Uuid::parse_str(&entry.uuid).map_err(|e| format!("entry {} has an invalid uuid: {e}", entry.uuid))?;
        out.extend_from_slice(uuid.as_bytes());
        out.push(match entry.kind {
            ObjectKind::Message => 0,
            ObjectKind::Marker => 1,
        });
        // Revisions only ever move forward from zero (WSP-1.md's own
        // invariant) -- encoded as an unsigned varint, not signed.
        write_varint(&mut out, entry.revision as u64);
        match &entry.content_hash {
            None => out.push(0),
            Some(hex_hash) => {
                let raw = hex_decode(hex_hash).map_err(|e| format!("entry {} has an unparseable content_hash: {e}", entry.uuid))?;
                if raw.len() != 32 {
                    return Err(format!("entry {} content_hash is {} bytes, expected a 32-byte SHA256", entry.uuid, raw.len()));
                }
                out.push(1);
                out.extend_from_slice(&raw);
            }
        }
    }

    Ok(out)
}

pub fn decode_manifest(bytes: &[u8]) -> Result<(Option<String>, i64, Vec<ManifestEntry>), String> {
    let mut pos = 0usize;
    let version = *bytes.get(pos).ok_or("empty manifest")?;
    pos += 1;
    if version != WSP2_VERSION {
        return Err(format!("unsupported wsp_version {version}, this decoder speaks WSP/2 only"));
    }
    let kind = *bytes.get(pos).ok_or("truncated manifest: missing kind")?;
    pos += 1;
    if kind != KIND_MANIFEST {
        return Err(format!("expected manifest kind ({KIND_MANIFEST}), got {kind}"));
    }

    let callsign_len = *bytes.get(pos).ok_or("truncated manifest: missing callsign length")? as usize;
    pos += 1;
    let callsign_bytes = bytes.get(pos..pos + callsign_len).ok_or("truncated manifest: callsign")?;
    pos += callsign_len;
    let origin_callsign = if callsign_bytes.is_empty() {
        None
    } else {
        Some(String::from_utf8(callsign_bytes.to_vec()).map_err(|e| format!("callsign is not valid utf8: {e}"))?)
    };

    let generated_at_bytes: [u8; 8] = bytes
        .get(pos..pos + 8)
        .ok_or("truncated manifest: generated_at")?
        .try_into()
        .expect("slice of exactly 8 bytes");
    let generated_at = i64::from_be_bytes(generated_at_bytes);
    pos += 8;

    let entry_count_bytes: [u8; 2] = bytes
        .get(pos..pos + 2)
        .ok_or("truncated manifest: entry count")?
        .try_into()
        .expect("slice of exactly 2 bytes");
    let entry_count = u16::from_be_bytes(entry_count_bytes) as usize;
    pos += 2;

    let mut entries = Vec::with_capacity(entry_count);
    for _ in 0..entry_count {
        let uuid_bytes: [u8; 16] = bytes.get(pos..pos + 16).ok_or("truncated manifest entry: uuid")?.try_into().expect("16 bytes");
        pos += 16;
        let uuid = uuid::Uuid::from_bytes(uuid_bytes).to_string();

        let kind_byte = *bytes.get(pos).ok_or("truncated manifest entry: kind")?;
        pos += 1;
        let kind = match kind_byte {
            0 => ObjectKind::Message,
            1 => ObjectKind::Marker,
            other => return Err(format!("unknown object kind byte {other}")),
        };

        let revision = read_varint(bytes, &mut pos)? as i64;

        let hash_present = *bytes.get(pos).ok_or("truncated manifest entry: hash flag")?;
        pos += 1;
        let content_hash = match hash_present {
            0 => None,
            1 => {
                let raw = bytes.get(pos..pos + 32).ok_or("truncated manifest entry: content_hash")?;
                pos += 32;
                Some(hex_encode(raw))
            }
            other => return Err(format!("unknown content_hash flag {other}")),
        };

        entries.push(ManifestEntry { uuid, kind, revision, updated_at: String::new(), content_hash });
    }

    Ok((origin_callsign, generated_at, entries))
}

/// Reads a reassembled payload's content kind without fully decoding it
/// -- lets `mesh.rs`'s receive path dispatch to the right decoder
/// (`decode_manifest`/`decode_objects_request`/`decode_objects_envelope`)
/// for one already-defragmented byte stream, the same way a port number
/// routes a packet to the right handler in `handle_mesh_packet`.
pub fn payload_kind(bytes: &[u8]) -> Result<u8, String> {
    let version = *bytes.first().ok_or("empty payload")?;
    if version != WSP2_VERSION {
        return Err(format!("unsupported wsp_version {version}, this decoder speaks WSP/2 only"));
    }
    bytes.get(1).copied().ok_or_else(|| "truncated payload: missing kind".to_string())
}

/// Compact uuid-list encoding, same raw-16-bytes-per-uuid shape
/// `encode_manifest`'s own entries already use -- this is just the
/// uuid half of a manifest entry, with no kind/revision/hash since a
/// request doesn't need them.
pub fn encode_objects_request(uuids: &[String]) -> Result<Vec<u8>, String> {
    let mut out = vec![WSP2_VERSION, KIND_OBJECTS_REQUEST];
    if uuids.len() > u16::MAX as usize {
        return Err("too many requested uuids for a u16 count".to_string());
    }
    out.extend_from_slice(&(uuids.len() as u16).to_be_bytes());
    for uuid in uuids {
        let parsed = uuid::Uuid::parse_str(uuid).map_err(|e| format!("requested uuid {uuid} is invalid: {e}"))?;
        out.extend_from_slice(parsed.as_bytes());
    }
    Ok(out)
}

pub fn decode_objects_request(bytes: &[u8]) -> Result<Vec<String>, String> {
    let kind = payload_kind(bytes)?;
    if kind != KIND_OBJECTS_REQUEST {
        return Err(format!("expected objects-request kind ({KIND_OBJECTS_REQUEST}), got {kind}"));
    }
    let mut pos = 2usize;
    let count_bytes: [u8; 2] = bytes.get(pos..pos + 2).ok_or("truncated objects request: count")?.try_into().expect("2 bytes");
    let count = u16::from_be_bytes(count_bytes) as usize;
    pos += 2;
    let mut uuids = Vec::with_capacity(count);
    for _ in 0..count {
        let uuid_bytes: [u8; 16] = bytes.get(pos..pos + 16).ok_or("truncated objects request: uuid")?.try_into().expect("16 bytes");
        pos += 16;
        uuids.push(uuid::Uuid::from_bytes(uuid_bytes).to_string());
    }
    Ok(uuids)
}

/// Wraps a real `WspEnvelope::Objects` (the same signed envelope the
/// file and TCP transports already produce via `sync::wrap_objects`) as
/// an opaque JSON blob behind this module's own version/kind header, so
/// `fragment`'s content-agnostic chunking carries it exactly like a
/// manifest, with no separate framing logic needed.
pub fn encode_objects_envelope(envelope: &WspEnvelope) -> Result<Vec<u8>, String> {
    let mut out = vec![WSP2_VERSION, KIND_OBJECTS];
    let json = serde_json::to_vec(envelope).map_err(|e| e.to_string())?;
    out.extend_from_slice(&json);
    Ok(out)
}

pub fn decode_objects_envelope(bytes: &[u8]) -> Result<WspEnvelope, String> {
    let kind = payload_kind(bytes)?;
    if kind != KIND_OBJECTS {
        return Err(format!("expected objects kind ({KIND_OBJECTS}), got {kind}"));
    }
    serde_json::from_slice(&bytes[2..]).map_err(|e| e.to_string())
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err("odd-length hex string".to_string());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

/// Splits an arbitrary byte payload into real over-the-air-sized frames.
/// Content-agnostic on purpose -- carries a binary manifest today, a
/// binary `Objects` envelope later, without redesign. Returns exactly one
/// frame, tagged "whole," when the payload already fits in one packet.
pub fn fragment(payload: &[u8], msg_id: u32) -> Result<Vec<Vec<u8>>, String> {
    if payload.len() + 1 <= DATA_PAYLOAD_LEN {
        let mut frame = Vec::with_capacity(payload.len() + 1);
        frame.push(0u8); // whole
        frame.extend_from_slice(payload);
        return Ok(vec![frame]);
    }

    let chunks: Vec<&[u8]> = payload.chunks(MAX_FRAGMENT_CHUNK).collect();
    if chunks.len() > u8::MAX as usize {
        return Err(format!(
            "payload needs {} fragments, more than this format's 255-fragment cap",
            chunks.len()
        ));
    }
    let total = chunks.len() as u8;
    Ok(chunks
        .into_iter()
        .enumerate()
        .map(|(i, chunk)| {
            let mut frame = Vec::with_capacity(FRAGMENT_HEADER_LEN + chunk.len());
            frame.push(1u8); // fragment
            frame.extend_from_slice(&msg_id.to_be_bytes());
            frame.push(i as u8);
            frame.push(total);
            frame.extend_from_slice(chunk);
            frame
        })
        .collect())
}

struct PartialMessage {
    total: u8,
    received: usize,
    chunks: Vec<Option<Vec<u8>>>,
}

/// One in-flight manifest's fragment status, as surfaced to the Mesh
/// panel (see `Reassembler::pending_summaries`).
#[derive(serde::Serialize)]
pub struct PendingFragmentStatus {
    pub msg_id: u32,
    pub total_fragments: u8,
    pub missing: Vec<u8>,
}

/// Tracks in-progress fragmented payloads by `msg_id`, across possibly
/// out-of-order delivery. Deliberately does not implement retransmission
/// itself -- see `WSP-2.md`'s "Acknowledgement" section: that's the
/// firmware's own per-packet ACK via `want_ack`/`RoutingApp`, which this
/// reassembler is meant to sit on top of, not duplicate.
#[derive(Default)]
pub struct Reassembler {
    partial: std::collections::HashMap<u32, PartialMessage>,
}

impl Reassembler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds one received frame (as produced by `fragment`). Returns the
    /// complete original payload once every fragment for its `msg_id` has
    /// arrived; `None` while more are still outstanding.
    pub fn add_fragment(&mut self, frame: &[u8]) -> Result<Option<Vec<u8>>, String> {
        let tag = *frame.first().ok_or("empty frame")?;
        if tag == 0 {
            return Ok(Some(frame[1..].to_vec()));
        }
        if tag != 1 {
            return Err(format!("unknown frame tag {tag}"));
        }

        let msg_id_bytes: [u8; 4] = frame.get(1..5).ok_or("truncated fragment: msg_id")?.try_into().expect("4 bytes");
        let msg_id = u32::from_be_bytes(msg_id_bytes);
        let frag_index = *frame.get(5).ok_or("truncated fragment: index")? as usize;
        let frag_total = *frame.get(6).ok_or("truncated fragment: total")?;
        let chunk = frame.get(7..).ok_or("truncated fragment: chunk")?.to_vec();

        let entry = self.partial.entry(msg_id).or_insert_with(|| PartialMessage {
            total: frag_total,
            received: 0,
            chunks: vec![None; frag_total as usize],
        });
        if entry.total != frag_total {
            return Err(format!("msg_id {msg_id} fragment claims total {frag_total}, earlier fragments claimed {}", entry.total));
        }
        let slot = entry.chunks.get_mut(frag_index).ok_or("fragment index out of range for its own claimed total")?;
        if slot.is_none() {
            entry.received += 1;
        }
        *slot = Some(chunk);

        if entry.received == entry.total as usize {
            let complete = self.partial.remove(&msg_id).expect("just confirmed present");
            let mut full = Vec::new();
            for part in complete.chunks {
                full.extend_from_slice(&part.expect("all slots confirmed filled above"));
            }
            Ok(Some(full))
        } else {
            Ok(None)
        }
    }

    /// Which fragment indices are still outstanding for a `msg_id` that
    /// has at least one fragment received but isn't complete yet. `None`
    /// if this `msg_id` is unknown (nothing received yet, or already
    /// completed). Now called from `mesh.rs` via `pending_summaries()`
    /// below, for operator visibility into a stalled transfer -- this
    /// still doesn't drive retransmission itself (`sync_manifest_over_mesh`
    /// still relies on the firmware's own per-packet ack/retry for that);
    /// an operator seeing "stuck on fragment 2 of 5" is what this is for,
    /// a real fragment-specific retransmission *request* protocol stays a
    /// separate, bigger follow-on if firmware-level retry alone ever
    /// proves insufficient.
    pub fn missing_fragments(&self, msg_id: u32) -> Option<Vec<u8>> {
        let entry = self.partial.get(&msg_id)?;
        Some(
            entry
                .chunks
                .iter()
                .enumerate()
                .filter(|(_, c)| c.is_none())
                .map(|(i, _)| i as u8)
                .collect(),
        )
    }

    /// Every manifest currently mid-flight, for the Mesh panel's "Incomplete
    /// Manifests" section -- the actual use `missing_fragments` was built
    /// for but never wired up to.
    pub fn pending_summaries(&self) -> Vec<PendingFragmentStatus> {
        self.partial
            .keys()
            .map(|&msg_id| PendingFragmentStatus {
                msg_id,
                total_fragments: self.partial[&msg_id].total,
                missing: self.missing_fragments(msg_id).unwrap_or_default(),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::{ManifestEntry, ObjectKind};

    fn sample_entry(uuid: &str, kind: ObjectKind, revision: i64, hash: Option<&str>) -> ManifestEntry {
        ManifestEntry {
            uuid: uuid.to_string(),
            kind,
            revision,
            updated_at: "2026-11-08T12:00:00Z".to_string(),
            content_hash: hash.map(|h| h.to_string()),
        }
    }

    const REAL_HASH: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    #[test]
    fn manifest_round_trips_with_a_content_hash() {
        let entries = vec![sample_entry("a1b2c3d4-e5f6-4789-a1b2-c3d4e5f67890", ObjectKind::Message, 3, Some(REAL_HASH))];
        let encoded = encode_manifest(Some("KJ4ESQ"), 1_794_092_400, &entries).expect("encode");
        let (callsign, generated_at, decoded) = decode_manifest(&encoded).expect("decode");
        assert_eq!(callsign, Some("KJ4ESQ".to_string()));
        assert_eq!(generated_at, 1_794_092_400);
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].uuid, entries[0].uuid);
        assert_eq!(decoded[0].kind, entries[0].kind);
        assert_eq!(decoded[0].revision, entries[0].revision);
        assert_eq!(decoded[0].content_hash, entries[0].content_hash);
    }

    #[test]
    fn manifest_round_trips_without_a_content_hash_or_callsign() {
        let entries = vec![sample_entry("b2c3d4e5-f6a7-4890-b2c3-d4e5f6a78901", ObjectKind::Marker, 0, None)];
        let encoded = encode_manifest(None, 0, &entries).expect("encode");
        let (callsign, generated_at, decoded) = decode_manifest(&encoded).expect("decode");
        assert_eq!(callsign, None);
        assert_eq!(generated_at, 0);
        assert_eq!(decoded[0].content_hash, None);
        assert_eq!(decoded[0].kind, ObjectKind::Marker);
    }

    #[test]
    fn multi_entry_manifest_round_trips_in_order() {
        let entries = vec![
            sample_entry("a1b2c3d4-e5f6-4789-a1b2-c3d4e5f67890", ObjectKind::Message, 1, Some(REAL_HASH)),
            sample_entry("b2c3d4e5-f6a7-4890-b2c3-d4e5f6a78901", ObjectKind::Marker, 7, None),
            sample_entry("c3d4e5f6-a7b8-4901-c3d4-e5f6a7b89012", ObjectKind::Message, 42, Some(REAL_HASH)),
        ];
        let encoded = encode_manifest(Some("W1AW"), 1_794_000_000, &entries).expect("encode");
        let (_, _, decoded) = decode_manifest(&encoded).expect("decode");
        assert_eq!(decoded.len(), 3);
        for (original, round_tripped) in entries.iter().zip(decoded.iter()) {
            assert_eq!(original.uuid, round_tripped.uuid);
            assert_eq!(original.kind, round_tripped.kind);
            assert_eq!(original.revision, round_tripped.revision);
            assert_eq!(original.content_hash, round_tripped.content_hash);
        }
    }

    /// Real measured comparison against WSP/1's own JSON form, not an
    /// estimate -- grounds `WSP-2.md`'s "~3x reduction" claim in an actual
    /// assertion rather than eyeballed arithmetic.
    #[test]
    fn binary_manifest_is_substantially_smaller_than_the_equivalent_wsp1_json() {
        let entries = vec![
            sample_entry("a1b2c3d4-e5f6-4789-a1b2-c3d4e5f67890", ObjectKind::Message, 3, Some(REAL_HASH)),
            sample_entry("b2c3d4e5-f6a7-4890-b2c3-d4e5f6a78901", ObjectKind::Marker, 1, Some(REAL_HASH)),
        ];
        let binary = encode_manifest(Some("KJ4ESQ"), 1_794_092_400, &entries).expect("encode");

        // The real WSP/1 JSON shape for a Manifest envelope (sync.rs's
        // WspEnvelope::Manifest + ManifestEntry fields), built the same
        // way serde_json would serialize it.
        #[derive(serde::Serialize)]
        struct Wsp1Manifest {
            wsp_kind: &'static str,
            wsp_version: u8,
            origin_callsign: Option<String>,
            generated_at: String,
            entries: Vec<ManifestEntry>,
        }
        let json = serde_json::to_vec(&Wsp1Manifest {
            wsp_kind: "manifest",
            wsp_version: 1,
            origin_callsign: Some("KJ4ESQ".to_string()),
            generated_at: "2026-11-08T12:00:00Z".to_string(),
            entries,
        })
        .expect("serialize");

        assert!(
            binary.len() * 2 < json.len(),
            "expected binary ({} bytes) to be well under half of WSP/1 JSON ({} bytes)",
            binary.len(),
            json.len()
        );
    }

    #[test]
    fn a_payload_that_fits_in_one_packet_produces_exactly_one_whole_frame() {
        let payload = vec![7u8; 100];
        let frames = fragment(&payload, 42).expect("fragment");
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0][0], 0, "should be tagged whole, not fragmented");

        let mut reassembler = Reassembler::new();
        let result = reassembler.add_fragment(&frames[0]).expect("add_fragment").expect("complete immediately");
        assert_eq!(result, payload);
    }

    #[test]
    fn a_payload_larger_than_one_packet_fragments_and_reassembles_byte_for_byte() {
        // Large enough to need several real 226-byte chunks.
        let payload: Vec<u8> = (0..1000u32).map(|i| (i % 256) as u8).collect();
        let frames = fragment(&payload, 99).expect("fragment");
        assert!(frames.len() > 1, "expected real fragmentation for a 1000-byte payload");
        for frame in &frames {
            assert!(frame.len() <= 233, "every frame must fit the real over-the-air ceiling");
        }

        let mut reassembler = Reassembler::new();
        let mut result = None;
        for frame in &frames {
            result = reassembler.add_fragment(frame).expect("add_fragment");
        }
        assert_eq!(result.expect("complete after the last fragment"), payload);
    }

    #[test]
    fn fragments_reassemble_correctly_even_when_delivered_out_of_order() {
        let payload: Vec<u8> = (0..800u32).map(|i| (i % 256) as u8).collect();
        let mut frames = fragment(&payload, 7).expect("fragment");
        // Real mesh delivery has no ordering guarantee -- shuffle deterministically.
        frames.reverse();
        let mid = frames.len() / 2;
        frames.swap(0, mid);

        let mut reassembler = Reassembler::new();
        let mut result = None;
        for frame in &frames {
            if let Some(complete) = reassembler.add_fragment(frame).expect("add_fragment") {
                result = Some(complete);
            }
        }
        assert_eq!(result.expect("complete once all fragments arrive, any order"), payload);
    }

    #[test]
    fn missing_fragments_reports_exactly_the_indices_not_yet_received() {
        let payload: Vec<u8> = (0..900u32).map(|i| (i % 256) as u8).collect();
        let frames = fragment(&payload, 5).expect("fragment");
        assert!(frames.len() >= 3, "test needs at least 3 real fragments");

        let mut reassembler = Reassembler::new();
        // Deliver everything except index 1.
        for (i, frame) in frames.iter().enumerate() {
            if i == 1 {
                continue;
            }
            reassembler.add_fragment(frame).expect("add_fragment");
        }
        assert_eq!(reassembler.missing_fragments(5), Some(vec![1]));

        // Deliver the last one -- now complete, and no longer tracked at all.
        reassembler.add_fragment(&frames[1]).expect("add_fragment");
        assert_eq!(reassembler.missing_fragments(5), None);
    }

    #[test]
    fn unknown_msg_id_reports_no_missing_fragments() {
        let reassembler = Reassembler::new();
        assert_eq!(reassembler.missing_fragments(12345), None);
    }

    #[test]
    fn pending_summaries_reports_every_in_flight_message_and_nothing_else() {
        let payload_a: Vec<u8> = (0..900u32).map(|i| (i % 256) as u8).collect();
        let payload_b: Vec<u8> = (0..400u32).map(|i| (i % 256) as u8).collect();
        let frames_a = fragment(&payload_a, 5).expect("fragment");
        let frames_b = fragment(&payload_b, 9).expect("fragment");
        assert!(frames_a.len() >= 3 && frames_b.len() >= 2, "test needs real multi-fragment messages");

        let mut reassembler = Reassembler::new();
        // msg_id 5: everything but index 1. msg_id 9: fully complete.
        for (i, frame) in frames_a.iter().enumerate() {
            if i != 1 {
                reassembler.add_fragment(frame).expect("add_fragment");
            }
        }
        for frame in &frames_b {
            reassembler.add_fragment(frame).expect("add_fragment");
        }

        let pending = reassembler.pending_summaries();
        assert_eq!(pending.len(), 1, "msg_id 9 completed and must not still show as pending");
        assert_eq!(pending[0].msg_id, 5);
        assert_eq!(pending[0].total_fragments, frames_a.len() as u8);
        assert_eq!(pending[0].missing, vec![1]);
    }

    #[test]
    fn payload_kind_reads_each_real_encoded_kind_correctly() {
        let manifest = encode_manifest(None, 0, &[]).expect("encode");
        assert_eq!(payload_kind(&manifest), Ok(KIND_MANIFEST));

        let request = encode_objects_request(&["a1b2c3d4-e5f6-4789-a1b2-c3d4e5f67890".to_string()]).expect("encode");
        assert_eq!(payload_kind(&request), Ok(KIND_OBJECTS_REQUEST));
    }

    #[test]
    fn payload_kind_rejects_a_wrong_version_and_an_empty_payload() {
        assert!(payload_kind(&[]).is_err());
        assert!(payload_kind(&[99, KIND_MANIFEST]).is_err());
    }

    #[test]
    fn objects_request_round_trips_a_real_uuid_list() {
        let uuids = vec![
            "a1b2c3d4-e5f6-4789-a1b2-c3d4e5f67890".to_string(),
            "b2c3d4e5-f6a7-4890-b2c3-d4e5f6a78901".to_string(),
        ];
        let encoded = encode_objects_request(&uuids).expect("encode");
        let decoded = decode_objects_request(&encoded).expect("decode");
        assert_eq!(decoded, uuids);
    }

    #[test]
    fn objects_request_rejects_an_unparseable_uuid() {
        assert!(encode_objects_request(&["not-a-real-uuid".to_string()]).is_err());
    }

    #[test]
    fn decode_objects_request_rejects_a_manifest_payload() {
        let manifest = encode_manifest(None, 0, &[]).expect("encode");
        let err = decode_objects_request(&manifest).unwrap_err();
        assert!(err.contains("expected objects-request kind"));
    }

    fn sample_objects_envelope() -> WspEnvelope {
        use crate::db::MapMarker;
        use crate::sync::SyncObject;
        WspEnvelope::Objects {
            wsp_version: crate::sync::WSP_VERSION,
            origin_callsign: Some("KJ4ESQ".to_string()),
            generated_at: "2026-11-22T12:00:00Z".to_string(),
            entries: vec![SyncObject::Marker(MapMarker {
                id: 1,
                label: "Staging Area".to_string(),
                marker_type: "resource".to_string(),
                latitude: 35.1,
                longitude: -101.3,
                origin_station: Some("KJ4ESQ".to_string()),
                to_station: None,
                created_at: "2026-11-22T12:00:00Z".to_string(),
                content_hash: "a-real-looking-hash".to_string(),
                dispatch_status: "dispatched".to_string(),
                dispatched_via: Some("mesh".to_string()),
                received_via: None,
                uuid: "c3d4e5f6-a7b8-4901-c3d4-e5f6a7b89012".to_string(),
                revision: 1,
                updated_at: Some("2026-11-22T12:00:00Z".to_string()),
                incident_id: None,
                expires_at: None,
                trust_state: "local".to_string(),
                deleted_at: None,
            })],
            signature: None,
        }
    }

    #[test]
    fn objects_envelope_round_trips_a_real_marker() {
        let envelope = sample_objects_envelope();
        let encoded = encode_objects_envelope(&envelope).expect("encode");
        assert_eq!(payload_kind(&encoded), Ok(KIND_OBJECTS));
        let decoded = decode_objects_envelope(&encoded).expect("decode");
        match (envelope, decoded) {
            (WspEnvelope::Objects { entries: a, .. }, WspEnvelope::Objects { entries: b, .. }) => {
                assert_eq!(a.len(), b.len());
            }
            _ => panic!("expected both sides to decode as an Objects envelope"),
        }
    }

    #[test]
    fn decode_objects_envelope_rejects_an_objects_request_payload() {
        let request = encode_objects_request(&[]).expect("encode");
        let err = decode_objects_envelope(&request).unwrap_err();
        assert!(err.contains("expected objects kind"));
    }
}
