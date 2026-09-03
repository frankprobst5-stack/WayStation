//! Two-instance peer synchronization, phase one: prove reconciliation
//! between two local WayStation databases before this protocol ever
//! touches real mesh/AREDN hardware -- per the roadmap's own ordering.
//!
//! The reconciliation logic here (manifest diff, selective fetch,
//! merge-with-conflict-detection) is deliberately transport-agnostic:
//! it operates on `&Connection` and plain data, with no assumption
//! about how the bytes actually moved between two stations. Files are
//! the first real transport (`export_*_to_file`/`import_*_from_file`
//! below) because they're the simplest way to prove this for real
//! today; a local TCP listener or, later, an actual mesh/AREDN link can
//! wrap the exact same `diff`/`merge_incoming` functions without either
//! needing to change. Same separation of concerns as `transport.rs`
//! keeping wire formatting out of the `Transport` trait itself.
//!
//! Scoped to messages and map markers only, matching Phase B's own
//! scope decision (they were the first two objects converted to the
//! canonical header) -- alert/incident/resource/etc. sync is real
//! future work, not something this pass tries to cover.

use crate::db::{self, MapMarker, Message};
use hmac::{Hmac, Mac};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// WSP/1 -- the WayStation Interchange Protocol, version 1. "Version 1"
/// specifically because every file this module writes was, until now, a
/// bare JSON array: no way to tell it apart from any other JSON array
/// before trying to parse it, no way to detect a future format change
/// and fail with a clear message instead of a confusing deserialize
/// error, and no record of which station actually produced it. This is
/// the real, working wire format -- not the compact/fragmentable/
/// compressed encoding the original planning notes describe for
/// constrained RF links. That's deliberately not built yet: there's no
/// real bandwidth-constrained transport exercising this protocol today
/// (file exchange has no such limit), and building a compact binary
/// encoding speculatively, before anything actually needs it, is the
/// exact premature-abstraction mistake this codebase already learned
/// not to repeat once (see transport.rs's own history). When a
/// constrained-link transport is real, WSP/2 is where that encoding
/// belongs -- this module's version check is what makes that a clean,
/// detectable upgrade instead of a silent incompatibility.
pub const WSP_VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ObjectKind {
    Message,
    Marker,
}

/// Every file this protocol produces is one of these, not a bare array.
/// `origin_callsign` and `generated_at` exist for the same reason
/// provenance exists everywhere else in this app: an operator looking
/// at an old sync file on disk, or troubleshooting a failed import,
/// should be able to tell who made it and when without guessing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "wsp_kind", rename_all = "snake_case")]
pub enum WspEnvelope {
    Manifest { wsp_version: u8, origin_callsign: Option<String>, generated_at: String, entries: Vec<ManifestEntry> },
    /// `signature` is new as of 2026-09-03 and deliberately additive,
    /// not a version bump: `#[serde(default)]` means a WSP/1 file
    /// written before signing existed still parses cleanly, just with
    /// `signature: None` -- read as "unsigned," not rejected. A
    /// manifest carries no content worth forging, so only Objects
    /// (what actually gets merged into the local database) gets one.
    Objects { wsp_version: u8, origin_callsign: Option<String>, generated_at: String, entries: Vec<SyncObject>, #[serde(default)] signature: Option<String> },
}

/// HMAC-SHA256 over everything in an Objects envelope except the
/// signature field itself -- both `wrap_objects` (signing) and
/// `verify_objects_signature` (checking) build this exact same byte
/// string, so any change to `entries`, `origin_callsign`, or
/// `generated_at` after signing invalidates the signature. `SignablePayload`
/// exists only to get a fixed, deterministic field order out of serde_json
/// independent of `WspEnvelope`'s own shape (which does carry a
/// signature field once populated).
#[derive(Serialize)]
struct SignablePayload<'a> {
    wsp_version: u8,
    origin_callsign: &'a Option<String>,
    generated_at: &'a str,
    entries: &'a [SyncObject],
}

fn compute_signature(secret: &str, wsp_version: u8, origin_callsign: &Option<String>, generated_at: &str, entries: &[SyncObject]) -> String {
    let payload = SignablePayload { wsp_version, origin_callsign, generated_at, entries };
    let bytes = serde_json::to_vec(&payload).expect("signable payload must serialize");
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(&bytes);
    format!("{:x}", mac.finalize().into_bytes())
}

fn wrap_manifest(conn: &Connection, entries: Vec<ManifestEntry>) -> WspEnvelope {
    WspEnvelope::Manifest {
        wsp_version: WSP_VERSION,
        origin_callsign: db::station_profile(conn).callsign,
        generated_at: chrono::Utc::now().to_rfc3339(),
        entries,
    }
}

/// Signs with this station's own secret if one has been generated
/// (`get_or_create_signing_secret`) -- if not, the export still
/// produces a valid WSP/1 file, just an honestly unsigned one, same as
/// every file this app produced before signing existed.
pub(crate) fn wrap_objects(conn: &Connection, entries: Vec<SyncObject>) -> WspEnvelope {
    let origin_callsign = db::station_profile(conn).callsign;
    let generated_at = chrono::Utc::now().to_rfc3339();
    let signature = db::station_profile(conn)
        .signing_secret
        .map(|secret| compute_signature(&secret, WSP_VERSION, &origin_callsign, &generated_at, &entries));
    WspEnvelope::Objects { wsp_version: WSP_VERSION, origin_callsign, generated_at, entries, signature }
}

/// What an operator actually needs to know about an imported file's
/// authenticity -- surfaced, never silently acted on. Matches this
/// codebase's standing rule (see `MergeReport::conflicts`): flag, don't
/// guess. Whether to proceed with a merge despite `UnknownSigner` or
/// `Invalid` is the operator's call, not something this function
/// decides for them.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SignatureStatus {
    /// No `origin_callsign`, or that callsign has no registered secret
    /// in `trusted_peers` -- this station has never exchanged keys with
    /// whoever (claims to have) sent this.
    UnknownSigner,
    /// The file carries no signature at all -- either the sender never
    /// generated a signing secret, or (deliberately) this is a WSP/1
    /// file from before signing existed. Default for `MergeReport`s
    /// produced without going through envelope-level verification at
    /// all (`merge_incoming` called directly, as the test suite does).
    #[default]
    Unsigned,
    /// A signature is present, the signer is known, but recomputing it
    /// with their registered secret doesn't match -- the content was
    /// altered after signing, or the signer used a different secret
    /// than the one registered. Treated the same regardless of which:
    /// either way, this station cannot vouch for this file.
    Invalid,
    /// Recomputing the signature with the claimed signer's registered
    /// secret matches exactly.
    Verified,
}

/// Verifies an Objects envelope's signature against this station's
/// `trusted_peers` registry. Takes the envelope's own fields rather
/// than the whole `WspEnvelope` so it can't accidentally be called on a
/// Manifest.
fn verify_objects_signature(conn: &Connection, wsp_version: u8, origin_callsign: &Option<String>, generated_at: &str, entries: &[SyncObject], signature: &Option<String>) -> SignatureStatus {
    let Some(signature) = signature else { return SignatureStatus::Unsigned };
    let Some(callsign) = origin_callsign else { return SignatureStatus::UnknownSigner };
    let Some(secret) = db::trusted_peer_secret(conn, callsign) else { return SignatureStatus::UnknownSigner };
    let expected = compute_signature(&secret, wsp_version, origin_callsign, generated_at, entries);
    if &expected == signature {
        SignatureStatus::Verified
    } else {
        SignatureStatus::Invalid
    }
}

/// Rejects a future, not-yet-understood WSP version explicitly rather
/// than trying to parse it and failing confusingly partway through --
/// and rejects the wrong envelope kind (a manifest file handed to
/// something expecting an objects file, or vice versa) the same way.
fn unwrap_manifest(envelope: WspEnvelope) -> Result<Vec<ManifestEntry>, String> {
    match envelope {
        WspEnvelope::Manifest { wsp_version, entries, .. } if wsp_version <= WSP_VERSION => Ok(entries),
        WspEnvelope::Manifest { wsp_version, .. } => {
            Err(format!("this file uses WSP/{wsp_version}, newer than this WayStation understands (WSP/{WSP_VERSION}) -- update WayStation before importing it"))
        }
        WspEnvelope::Objects { .. } => Err("expected a WSP manifest file, got an objects file".to_string()),
    }
}

/// Version/kind validation plus signature verification in one pass --
/// takes `conn` to look the claimed signer up in `trusted_peers`.
/// Returns the entries alongside a `SignatureStatus` rather than
/// rejecting anything itself on an unverified/invalid signature: what
/// to do about an untrusted import is the operator's call (surfaced in
/// `MergeReport`), not something silently decided in the parsing layer.
pub(crate) fn unwrap_objects(conn: &Connection, envelope: WspEnvelope) -> Result<(Vec<SyncObject>, SignatureStatus), String> {
    match envelope {
        WspEnvelope::Objects { wsp_version, origin_callsign, generated_at, entries, signature } if wsp_version <= WSP_VERSION => {
            let status = verify_objects_signature(conn, wsp_version, &origin_callsign, &generated_at, &entries, &signature);
            Ok((entries, status))
        }
        WspEnvelope::Objects { wsp_version, .. } => {
            Err(format!("this file uses WSP/{wsp_version}, newer than this WayStation understands (WSP/{WSP_VERSION}) -- update WayStation before importing it"))
        }
        WspEnvelope::Manifest { .. } => Err("expected a WSP objects file, got a manifest file".to_string()),
    }
}

/// The lightweight side of the protocol -- enough to decide what's
/// missing or stale without moving full object content. `revision` is
/// what actually drives the diff; `updated_at` rides along for
/// human-readable diagnostics, not as the comparison key (clock skew
/// between two stations is a real, expected condition this protocol
/// has to survive -- revision numbers, which only ever move forward on
/// the station that owns the edit, don't have that problem).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub uuid: String,
    pub kind: ObjectKind,
    pub revision: i64,
    pub updated_at: String,
    /// Carried in the manifest itself, not just the full object, for a
    /// specific reason: without it, two sides sitting at the same
    /// revision but with genuinely different content (two operators
    /// editing offline, unaware of each other) would look identical at
    /// the manifest level and `uuids_needed_from` would never flag
    /// anything to fetch -- meaning `merge_incoming`'s conflict
    /// detection could never actually fire during a real sync, only in
    /// a test that bypasses the diff step. Including the hash here is
    /// what lets a same-revision-different-hash pair get flagged for a
    /// closer look instead of silently never being compared.
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SyncObject {
    Message(Message),
    Marker(MapMarker),
}

/// Everything this station currently has, reduced to its lightweight
/// manifest form. What a peer receives first, before requesting any
/// full content.
pub fn export_manifest(conn: &Connection) -> Vec<ManifestEntry> {
    let messages = db::get_messages_conn(conn).into_iter().map(|m| ManifestEntry {
        uuid: m.uuid,
        kind: ObjectKind::Message,
        revision: m.revision,
        updated_at: m.updated_at.unwrap_or(m.date_time),
        content_hash: m.content_hash,
    });
    let markers = db::get_markers_conn(conn).into_iter().map(|m| ManifestEntry {
        uuid: m.uuid,
        kind: ObjectKind::Marker,
        revision: m.revision,
        updated_at: m.updated_at.unwrap_or(m.created_at),
        content_hash: Some(m.content_hash),
    });
    messages.chain(markers).collect()
}

/// Which uuids the LOCAL side should request from a REMOTE peer, given
/// both sides' manifests: anything remote has that local is missing
/// entirely, remote's revision is strictly ahead of local's, or both
/// sides claim the same revision but disagree on content (a potential
/// conflict, worth fetching to actually compare rather than assuming
/// either side is right). Never the reverse direction -- a real sync
/// exchange calls this twice, once from each side's perspective, rather
/// than trying to make one call bidirectional and harder to reason
/// about.
pub fn uuids_needed_from(local: &[ManifestEntry], remote: &[ManifestEntry]) -> Vec<String> {
    use std::collections::HashMap;
    let local_by_uuid: HashMap<&str, &ManifestEntry> = local.iter().map(|e| (e.uuid.as_str(), e)).collect();
    remote
        .iter()
        .filter(|r| match local_by_uuid.get(r.uuid.as_str()) {
            None => true,
            Some(l) => r.revision > l.revision || (r.revision == l.revision && r.content_hash != l.content_hash),
        })
        .map(|r| r.uuid.clone())
        .collect()
}

/// Full content for a requested set of uuids -- what a peer sends back
/// after receiving a `uuids_needed_from` request. Looks each uuid up by
/// its own manifest-declared kind rather than probing both tables, both
/// because it's cheaper and because a uuid existing in the wrong table
/// would itself be a real, worth-surfacing data problem rather than
/// something to silently paper over.
pub fn export_objects(conn: &Connection, requested: &[ManifestEntry]) -> Vec<SyncObject> {
    requested
        .iter()
        .filter_map(|entry| match entry.kind {
            ObjectKind::Message => db::get_message_by_uuid(conn, &entry.uuid).map(SyncObject::Message),
            ObjectKind::Marker => db::get_marker_by_uuid(conn, &entry.uuid).map(SyncObject::Marker),
        })
        .collect()
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct MergeReport {
    pub inserted: Vec<String>,
    pub updated: Vec<String>,
    pub ignored_stale: Vec<String>,
    /// uuids where the incoming object claimed the same revision this
    /// station already has, but with different content -- a genuine
    /// conflict, not something this function silently resolves one way
    /// or the other. Matches the project's standing rule: never invent
    /// certainty the data doesn't support. Surfacing these to an
    /// operator (a real UI for that is future work) beats guessing.
    pub conflicts: Vec<String>,
    /// Set for a real import (`import_objects_from_file`); stays
    /// `Unsigned` for the in-process `merge_incoming` calls the test
    /// suite and `sync_one_direction` use directly, which never go
    /// through envelope-level verification at all. A merge always
    /// proceeds regardless of this value -- the operator decides what
    /// to do with an unverified/invalid import, this struct just makes
    /// sure they can't miss it.
    pub signature_status: SignatureStatus,
}

fn message_content_matches(a: &Message, b: &Message) -> bool {
    a.content_hash == b.content_hash
}

fn marker_content_matches(a: &MapMarker, b: &MapMarker) -> bool {
    a.content_hash == b.content_hash
}

/// Applies a batch of objects received from a peer. For each one:
/// unknown locally -> insert; incoming revision strictly ahead -> adopt
/// it; same revision and same content -> no-op (already converged);
/// same revision but different content -> flag as a conflict, change
/// nothing; incoming revision behind local's -> ignore, local is
/// already ahead and this station is not going to regress its own
/// data because a peer's manifest was stale.
pub fn merge_incoming(conn: &Connection, objects: Vec<SyncObject>) -> MergeReport {
    let mut report = MergeReport::default();
    for obj in objects {
        match &obj {
            SyncObject::Message(incoming) => match db::get_message_by_uuid(conn, &incoming.uuid) {
                None => {
                    db::insert_synced_message(conn, incoming);
                    report.inserted.push(incoming.uuid.clone());
                }
                Some(existing) if incoming.revision > existing.revision => {
                    db::update_synced_message(conn, incoming);
                    report.updated.push(incoming.uuid.clone());
                }
                Some(existing) if incoming.revision == existing.revision => {
                    if !message_content_matches(incoming, &existing) {
                        report.conflicts.push(incoming.uuid.clone());
                    }
                }
                Some(_) => report.ignored_stale.push(incoming.uuid.clone()),
            },
            SyncObject::Marker(incoming) => match db::get_marker_by_uuid(conn, &incoming.uuid) {
                None => {
                    db::insert_synced_marker(conn, incoming);
                    report.inserted.push(incoming.uuid.clone());
                }
                Some(existing) if incoming.revision > existing.revision => {
                    db::update_synced_marker(conn, incoming);
                    report.updated.push(incoming.uuid.clone());
                }
                Some(existing) if incoming.revision == existing.revision => {
                    if !marker_content_matches(incoming, &existing) {
                        report.conflicts.push(incoming.uuid.clone());
                    }
                }
                Some(_) => report.ignored_stale.push(incoming.uuid.clone()),
            },
        }
    }
    report
}

// -- File-based exchange -----------------------------------------------
//
// The simplest real transport for this protocol, and one the roadmap
// explicitly names ("local TCP or files"). A local TCP listener is real
// future work; this proves the reconciliation logic end-to-end today
// without needing WayStation to become a network server yet.

#[tauri::command]
pub fn export_manifest_to_file(db: tauri::State<db::Db>, path: String) -> Result<(), String> {
    let conn = db.0.lock().expect("db mutex poisoned");
    let manifest = export_manifest(&conn);
    let envelope = wrap_manifest(&conn, manifest);
    let json = serde_json::to_string_pretty(&envelope).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn manifest_diff_from_file(db: tauri::State<db::Db>, remote_manifest_path: String) -> Result<Vec<String>, String> {
    let remote_json = std::fs::read_to_string(remote_manifest_path).map_err(|e| e.to_string())?;
    let envelope: WspEnvelope = serde_json::from_str(&remote_json).map_err(|e| e.to_string())?;
    let remote = unwrap_manifest(envelope)?;
    let conn = db.0.lock().expect("db mutex poisoned");
    let local = export_manifest(&conn);
    Ok(uuids_needed_from(&local, &remote))
}

#[tauri::command]
pub fn export_objects_to_file(db: tauri::State<db::Db>, remote_manifest_path: String, requested_uuids: Vec<String>, out_path: String) -> Result<(), String> {
    let remote_json = std::fs::read_to_string(remote_manifest_path).map_err(|e| e.to_string())?;
    let envelope: WspEnvelope = serde_json::from_str(&remote_json).map_err(|e| e.to_string())?;
    let remote = unwrap_manifest(envelope)?;
    let requested: Vec<ManifestEntry> = remote.into_iter().filter(|e| requested_uuids.contains(&e.uuid)).collect();
    let conn = db.0.lock().expect("db mutex poisoned");
    let objects = export_objects(&conn, &requested);
    let out_envelope = wrap_objects(&conn, objects);
    let json = serde_json::to_string_pretty(&out_envelope).map_err(|e| e.to_string())?;
    std::fs::write(out_path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_objects_from_file(db: tauri::State<db::Db>, path: String) -> Result<MergeReport, String> {
    let json = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let envelope: WspEnvelope = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let conn = db.0.lock().expect("db mutex poisoned");
    let (objects, signature_status) = unwrap_objects(&conn, envelope)?;
    let mut report = merge_incoming(&conn, objects);
    report.signature_status = signature_status;
    Ok(report)
}

// -- Combined single-file exchange --------------------------------------
//
// The four granular commands above are the real protocol (manifest ->
// diff -> selective fetch -> merge), and matter for a bandwidth-
// constrained transport where sending objects the peer already has is
// real, meaningful waste. Over a file exchange there's no such
// constraint, and `merge_incoming` already safely no-ops on anything
// the receiving side doesn't actually need (see its own doc comment) --
// so skipping straight to "export everything, let merge sort out what's
// actually new" is not a shortcut around correctness, just a UI that
// doesn't force an operator through a multi-file round trip to prove
// the same thing the granular path already proves in the test suite.
// Import re-uses `import_objects_from_file` above unchanged -- a full
// bundle is just a `Vec<SyncObject>` like any other, no separate import
// path needed.
#[tauri::command]
pub fn export_full_bundle_to_file(db: tauri::State<db::Db>, path: String) -> Result<usize, String> {
    let conn = db.0.lock().expect("db mutex poisoned");
    let manifest = export_manifest(&conn);
    let objects = export_objects(&conn, &manifest);
    let count = objects.len();
    let envelope = wrap_objects(&conn, objects);
    let json = serde_json::to_string_pretty(&envelope).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    //! Real risk this protects against: it's easy to write reconciliation
    //! logic that looks right and quietly does the wrong thing the
    //! moment two real, independent databases disagree. Every test here
    //! runs the *actual* exchange sequence (export manifest -> diff ->
    //! export requested objects -> merge) between two genuinely separate
    //! SQLite databases -- not a simplified stand-in -- because that
    //! sequence, not any single function in isolation, is what "two
    //! instances converge" actually means.
    use super::*;
    use rusqlite::Connection;

    fn fresh_db() -> Connection {
        let mut conn = Connection::open_in_memory().expect("failed to open in-memory db");
        db::migrate(&mut conn);
        conn
    }

    fn make_message(uuid: &str, revision: i64, text: &str, hash: &str) -> Message {
        Message {
            id: 0, // ignored by insert_synced_message/update_synced_message
            precedence: "routine".to_string(),
            date_time: "2026-09-01T12:00:00Z".to_string(),
            to_station: Some("KJ4ESQ".to_string()),
            to_name: None,
            from_station: Some("K7WSP".to_string()),
            from_name: None,
            subject: Some("Test".to_string()),
            message_text: text.to_string(),
            content_hash: Some(hash.to_string()),
            dispatch_status: "dispatched".to_string(),
            dispatched_via: Some("mesh".to_string()),
            uuid: uuid.to_string(),
            revision,
            updated_at: Some("2026-09-01T12:00:00Z".to_string()),
            incident_id: None,
            expires_at: None,
            trust_state: "local".to_string(),
        }
    }

    fn make_marker(uuid: &str) -> MapMarker {
        MapMarker {
            id: 0,
            label: "Shelter B".to_string(),
            marker_type: "shelter".to_string(),
            latitude: 35.22,
            longitude: -100.76,
            origin_station: Some("K7WSP".to_string()),
            to_station: None,
            created_at: "2026-09-01T12:00:00Z".to_string(),
            content_hash: "marker-hash-1".to_string(),
            dispatch_status: "dispatched".to_string(),
            dispatched_via: Some("mesh".to_string()),
            received_via: None,
            uuid: uuid.to_string(),
            revision: 1,
            updated_at: Some("2026-09-01T12:00:00Z".to_string()),
            incident_id: None,
            expires_at: None,
            trust_state: "local".to_string(),
        }
    }

    /// One full one-directional exchange: `to` requests from `from`
    /// whatever its manifest shows it's missing or behind on, `from`
    /// answers, `to` merges the result. Mirrors exactly what two real
    /// WayStation instances do via the file-based commands above, just
    /// without the JSON file round-trip.
    fn sync_one_direction(to: &Connection, from: &Connection) -> MergeReport {
        let to_manifest = export_manifest(to);
        let from_manifest = export_manifest(from);
        let needed = uuids_needed_from(&to_manifest, &from_manifest);
        let requested: Vec<ManifestEntry> = from_manifest.into_iter().filter(|e| needed.contains(&e.uuid)).collect();
        let objects = export_objects(from, &requested);
        merge_incoming(to, objects)
    }

    #[test]
    fn two_instances_converge_new_objects_in_both_directions() {
        let station_a = fresh_db();
        let station_b = fresh_db();

        db::insert_synced_message(&station_a, &make_message("uuid-only-a", 1, "only on A", "hash-a"));
        db::insert_synced_marker(&station_b, &make_marker("uuid-only-b"));

        let report_to_a = sync_one_direction(&station_a, &station_b);
        assert_eq!(report_to_a.inserted, vec!["uuid-only-b".to_string()]);

        let report_to_b = sync_one_direction(&station_b, &station_a);
        assert_eq!(report_to_b.inserted, vec!["uuid-only-a".to_string()]);

        assert!(db::get_marker_by_uuid(&station_a, "uuid-only-b").is_some());
        assert!(db::get_message_by_uuid(&station_b, "uuid-only-a").is_some());

        // Received objects are marked as such, not indistinguishable
        // from something this station actually originated.
        assert_eq!(db::get_message_by_uuid(&station_b, "uuid-only-a").unwrap().trust_state, "received");

        // Interrupt-resume: running the same exchange again is a clean
        // no-op, not a duplicate insert -- both sides are now converged.
        let report_again = sync_one_direction(&station_a, &station_b);
        assert!(report_again.inserted.is_empty() && report_again.updated.is_empty());
    }

    #[test]
    fn ahead_instance_wins_and_stale_instance_adopts_the_newer_revision() {
        let station_a = fresh_db();
        let station_b = fresh_db();

        let shared = make_message("uuid-shared", 1, "original text", "hash-original");
        db::insert_synced_message(&station_a, &shared);
        db::insert_synced_message(&station_b, &shared);

        // A edits it -- bumps revision, changes content. B doesn't know yet.
        let mut edited = shared.clone();
        edited.revision = 2;
        edited.message_text = "updated text".to_string();
        edited.content_hash = Some("hash-updated".to_string());
        db::update_synced_message(&station_a, &edited);

        let report = sync_one_direction(&station_b, &station_a);
        assert_eq!(report.updated, vec!["uuid-shared".to_string()]);
        assert!(report.conflicts.is_empty());

        let converged = db::get_message_by_uuid(&station_b, "uuid-shared").unwrap();
        assert_eq!(converged.revision, 2);
        assert_eq!(converged.message_text, "updated text");

        // Re-syncing again is a no-op -- B is no longer behind, nothing
        // gets re-applied.
        let report_again = sync_one_direction(&station_b, &station_a);
        assert!(report_again.updated.is_empty());
    }

    #[test]
    fn genuine_conflict_is_flagged_not_silently_resolved() {
        let station_a = fresh_db();
        let station_b = fresh_db();

        let shared = make_message("uuid-conflict", 1, "original", "hash-original");
        db::insert_synced_message(&station_a, &shared);
        db::insert_synced_message(&station_b, &shared);

        // Both stations independently edit it without bumping revision
        // -- two operators editing offline, unaware of each other. Same
        // claimed revision, different real content.
        let mut a_edit = shared.clone();
        a_edit.message_text = "A's version".to_string();
        a_edit.content_hash = Some("hash-a-version".to_string());
        db::update_synced_message(&station_a, &a_edit);

        let mut b_edit = shared.clone();
        b_edit.message_text = "B's version".to_string();
        b_edit.content_hash = Some("hash-b-version".to_string());
        db::update_synced_message(&station_b, &b_edit);

        // The manifest-level hash mismatch at equal revision is exactly
        // what makes uuids_needed_from flag this for a closer look --
        // proving that connection, not just merge_incoming in isolation.
        let report = sync_one_direction(&station_b, &station_a);

        assert_eq!(report.conflicts, vec!["uuid-conflict".to_string()]);
        assert!(report.updated.is_empty(), "a detected conflict must not silently overwrite");

        // B's own data is untouched -- a conflict changes nothing until
        // an operator resolves it, it doesn't guess a winner.
        assert_eq!(db::get_message_by_uuid(&station_b, "uuid-conflict").unwrap().message_text, "B's version");
    }

    #[test]
    fn envelope_round_trips_through_real_json_serialization() {
        let conn = fresh_db();
        db::insert_synced_message(&conn, &make_message("uuid-1", 1, "hello", "hash-1"));

        let manifest = export_manifest(&conn);
        let wrapped = wrap_manifest(&conn, manifest.clone());
        let json = serde_json::to_string(&wrapped).expect("envelope must serialize");
        let parsed: WspEnvelope = serde_json::from_str(&json).expect("envelope must deserialize");
        let unwrapped = unwrap_manifest(parsed).expect("a valid WSP/1 manifest envelope must unwrap cleanly");

        assert_eq!(unwrapped.len(), manifest.len());
        assert_eq!(unwrapped[0].uuid, "uuid-1");
    }

    #[test]
    fn envelope_records_the_real_station_callsign() {
        let conn = fresh_db();
        // A fresh migrated database has no station_profile row at all --
        // one is only created the first time an operator saves the
        // Station form (db::save_station_profile). Insert one directly
        // rather than UPDATE, which would silently match zero rows here.
        conn.execute(
            "INSERT INTO station_profile (id, callsign, updated_at) VALUES (1, 'KJ4ESQ', '2026-09-02T00:00:00Z')",
            [],
        )
        .expect("station_profile insert should succeed against the migrated schema");
        let wrapped = wrap_manifest(&conn, vec![]);
        match wrapped {
            WspEnvelope::Manifest { origin_callsign, .. } => assert_eq!(origin_callsign.as_deref(), Some("KJ4ESQ")),
            WspEnvelope::Objects { .. } => panic!("wrap_manifest must produce a Manifest envelope"),
        }
    }

    #[test]
    fn a_future_wsp_version_is_rejected_with_a_clear_error_not_a_silent_misparse() {
        let future = WspEnvelope::Manifest {
            wsp_version: WSP_VERSION + 1,
            origin_callsign: None,
            generated_at: "2026-09-02T00:00:00Z".to_string(),
            entries: vec![],
        };
        let err = unwrap_manifest(future).expect_err("a newer WSP version must not be silently accepted");
        assert!(err.contains("WSP/2"), "error should name the actual version encountered: {err}");
    }

    #[test]
    fn handing_a_manifest_file_to_the_objects_importer_fails_clearly() {
        // The real mistake an operator could actually make: picking the
        // wrong file in the Import dialog. This must fail with a message
        // that explains what happened, not a raw deserialize panic.
        let conn = fresh_db();
        let envelope = WspEnvelope::Manifest { wsp_version: WSP_VERSION, origin_callsign: None, generated_at: "now".to_string(), entries: vec![] };
        let err = unwrap_objects(&conn, envelope).expect_err("a manifest envelope must not be accepted where objects are expected");
        assert!(err.contains("manifest"), "error should say what kind of file was actually given: {err}");
    }

    // -- WSP/1 object signing -------------------------------------------

    fn set_station_identity(conn: &Connection, callsign: &str, signing_secret: Option<&str>) {
        conn.execute(
            "INSERT INTO station_profile (id, callsign, signing_secret, updated_at) VALUES (1, ?1, ?2, '2026-09-03T00:00:00Z')
             ON CONFLICT(id) DO UPDATE SET callsign = excluded.callsign, signing_secret = excluded.signing_secret",
            rusqlite::params![callsign, signing_secret],
        )
        .expect("station_profile insert/update should succeed against the migrated schema");
    }

    #[test]
    fn an_export_with_no_signing_secret_configured_is_honestly_unsigned() {
        let conn = fresh_db();
        set_station_identity(&conn, "K7WSP", None);
        db::insert_synced_message(&conn, &make_message("uuid-1", 1, "hello", "hash-1"));

        let envelope = wrap_objects(&conn, export_objects(&conn, &export_manifest(&conn)));
        match envelope {
            WspEnvelope::Objects { signature, .. } => assert_eq!(signature, None),
            WspEnvelope::Manifest { .. } => panic!("wrap_objects must produce an Objects envelope"),
        }
    }

    #[test]
    fn a_correctly_signed_export_verifies_against_the_registered_secret() {
        let sender = fresh_db();
        set_station_identity(&sender, "K7WSP", Some("sender-secret-12345"));
        db::insert_synced_message(&sender, &make_message("uuid-1", 1, "hello", "hash-1"));
        let envelope = wrap_objects(&sender, export_objects(&sender, &export_manifest(&sender)));

        let receiver = fresh_db();
        db::add_trusted_peer_conn(&receiver, "K7WSP".to_string(), "sender-secret-12345".to_string(), None).unwrap();

        let (_, status) = unwrap_objects(&receiver, envelope).unwrap();
        assert_eq!(status, SignatureStatus::Verified);
    }

    #[test]
    fn tampering_the_content_after_signing_invalidates_the_signature() {
        let sender = fresh_db();
        set_station_identity(&sender, "K7WSP", Some("sender-secret-12345"));
        db::insert_synced_message(&sender, &make_message("uuid-1", 1, "hello", "hash-1"));
        let envelope = wrap_objects(&sender, export_objects(&sender, &export_manifest(&sender)));

        // Simulates a file altered in transit (or a forgery attempt): the
        // signature travels unchanged, but the content it was computed
        // over does not.
        let tampered = match envelope {
            WspEnvelope::Objects { wsp_version, origin_callsign, generated_at, signature, .. } => WspEnvelope::Objects {
                wsp_version,
                origin_callsign,
                generated_at,
                entries: vec![SyncObject::Message(make_message("uuid-1", 1, "TAMPERED TEXT", "hash-1"))],
                signature,
            },
            WspEnvelope::Manifest { .. } => panic!("wrap_objects must produce an Objects envelope"),
        };

        let receiver = fresh_db();
        db::add_trusted_peer_conn(&receiver, "K7WSP".to_string(), "sender-secret-12345".to_string(), None).unwrap();
        let (_, status) = unwrap_objects(&receiver, tampered).unwrap();
        assert_eq!(status, SignatureStatus::Invalid);
    }

    #[test]
    fn a_signed_export_from_an_unregistered_station_is_flagged_not_silently_trusted() {
        let sender = fresh_db();
        set_station_identity(&sender, "K7WSP", Some("sender-secret-12345"));
        db::insert_synced_message(&sender, &make_message("uuid-1", 1, "hello", "hash-1"));
        let envelope = wrap_objects(&sender, export_objects(&sender, &export_manifest(&sender)));

        // Receiver has never exchanged keys with K7WSP -- trusted_peers
        // is empty.
        let receiver = fresh_db();
        let (_, status) = unwrap_objects(&receiver, envelope).unwrap();
        assert_eq!(status, SignatureStatus::UnknownSigner);
    }

    #[test]
    fn a_legacy_unsigned_wsp1_file_still_imports_flagged_unsigned_not_rejected() {
        // A real WSP/1 file written before signing existed has no
        // `signature` field at all -- `#[serde(default)]` must let it
        // deserialize cleanly rather than fail to parse.
        let json = r#"{"wsp_kind":"objects","wsp_version":1,"origin_callsign":"K7WSP","generated_at":"2026-09-01T00:00:00Z","entries":[]}"#;
        let envelope: WspEnvelope = serde_json::from_str(json).expect("a pre-signing WSP/1 file must still deserialize");
        let conn = fresh_db();
        let (objects, status) = unwrap_objects(&conn, envelope).expect("an unsigned envelope must still be accepted, just flagged");
        assert!(objects.is_empty());
        assert_eq!(status, SignatureStatus::Unsigned);
    }
}
