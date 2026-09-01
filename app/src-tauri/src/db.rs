//! Local SQLite store.
//!
//! Provenance convention (D-004): any table holding *ingested* data — data
//! that came from somewhere other than the operator typing it in — MUST
//! carry these columns:
//!
//!   source      TEXT NOT NULL            -- e.g. "noaa-swpc", "aredn-sysinfo"
//!   fetched_at  TEXT NOT NULL            -- RFC3339 UTC timestamp
//!   via         TEXT NOT NULL            -- 'internet' | 'mesh' | 'rf' | 'manual'
//!
//! This is what lets every panel show honest data age instead of a blank,
//! and what lets peer sync reconcile the same fact arriving by two paths.
//! Operator-entered configuration (station_profile) and metadata about the
//! sources themselves (source_health) are exempt — there's nothing to
//! attribute provenance to.
//!
//! Phase 1 domain tables (alerts, spots, messages, ...) must follow this
//! convention when they're added.

use crate::maidenhead::grid_square_to_lat_lon;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

pub struct Db(pub Mutex<Connection>);

#[derive(Debug, Clone, Serialize)]
pub struct StationProfile {
    pub callsign: Option<String>,
    pub grid_square: Option<String>,
    pub operator_name: Option<String>,
    pub repeaterbook_token: Option<String>,
    /// Where to reach a Meshtastic node's TCP API — `host` or `host:port`,
    /// port defaulting to 4403. None means the local default; see
    /// `mesh::mesh_target`.
    pub mesh_host: Option<String>,
    /// Where to reach `rigctld` for Hamlib rig control — `host` or
    /// `host:port`, port defaulting to 4532. See `rig::rig_target`.
    pub rigctld_host: Option<String>,
    /// Operator has manually taken Waystation off the internet. Persisted
    /// deliberately: an explicit instruction shouldn't be silently undone
    /// by a restart, which would put the app back on the network without
    /// the operator asking for it.
    pub manual_offline: bool,
    /// Whether to talk to rigctld at all. Off means Waystation opens no
    /// connection and does no polling — useful with no radio attached, in
    /// a go-kit where serial traffic costs battery, or when another
    /// program should have the rig to itself.
    pub rig_enabled: bool,
    /// Where to reach `rotctld` for Hamlib rotator control -- same
    /// `host`/`host:port` shape as rigctld_host, port defaulting to 4533.
    pub rotctld_host: Option<String>,
    /// Same reasoning as rig_enabled: off means no connection, no
    /// polling. Independent of rig_enabled -- a station can have a rig
    /// but no rotator, or vice versa.
    pub rotator_enabled: bool,
    /// Hides panels flagged `hobbyist` (panels/types.ts) from the sidebar
    /// when true -- contest calendar, DX cluster, that kind of thing.
    /// Not a Station-form field, same reasoning as manual_offline: it's a
    /// quick mode switch, not station configuration, so it's set through
    /// its own command (`set_tactical_mode`) and carried through unchanged
    /// whenever the Station form saves.
    pub tactical_mode: bool,
    /// Where to reach Citadel's map tile server (its own nginx serving
    /// `.pmtiles` files over plain HTTP) -- `host` or `host:port`, port
    /// defaulting to 8085. None means the local default. See the Tactical
    /// Map panel; this is the real primary tile source, not the online
    /// OpenFreeMap fallback used when it's unreachable.
    pub citadel_map_host: Option<String>,
    pub updated_at: Option<String>,
}

/// A brand-new install has no `station_profile` row yet -- `id = 1` isn't
/// inserted until the operator first saves the Station form -- so
/// `station_profile()`'s `unwrap_or_default()` runs before anyone has
/// configured anything. `#[derive(Default)]` doesn't know that migration
/// v21 sets `rig_enabled INTEGER NOT NULL DEFAULT 1`; it just gives every
/// bool `false`, silently starting rig control disabled for every first
/// launch until someone visits Settings once — caught by a test, not
/// observed in the wild, but a real bug for exactly the fresh installs
/// Frank's family is about to run. Kept in sync with the schema by hand
/// since Rust has no way to derive a struct's defaults from SQL DDL.
impl Default for StationProfile {
    fn default() -> Self {
        StationProfile {
            callsign: None,
            grid_square: None,
            operator_name: None,
            repeaterbook_token: None,
            mesh_host: None,
            rigctld_host: None,
            manual_offline: false,
            rig_enabled: true,
            rotctld_host: None,
            rotator_enabled: true,
            tactical_mode: true,
            citadel_map_host: None,
            updated_at: None,
        }
    }
}

pub fn station_profile(conn: &Connection) -> StationProfile {
    conn.query_row(
        "SELECT callsign, grid_square, operator_name, repeaterbook_token, mesh_host, rigctld_host, manual_offline, rig_enabled, rotctld_host, rotator_enabled, tactical_mode, citadel_map_host, updated_at FROM station_profile WHERE id = 1",
        [],
        |row| {
            Ok(StationProfile {
                callsign: row.get(0)?,
                grid_square: row.get(1)?,
                operator_name: row.get(2)?,
                repeaterbook_token: row.get(3)?,
                mesh_host: row.get(4)?,
                rigctld_host: row.get(5)?,
                manual_offline: row.get::<_, i64>(6)? != 0,
                rig_enabled: row.get::<_, i64>(7)? != 0,
                rotctld_host: row.get(8)?,
                rotator_enabled: row.get::<_, i64>(9)? != 0,
                tactical_mode: row.get::<_, i64>(10)? != 0,
                citadel_map_host: row.get(11)?,
                updated_at: row.get(12)?,
            })
        },
    )
    .optional()
    .expect("failed to query station_profile")
    .unwrap_or_default()
}

/// Flips Tactical/Hobbyist Mode. Own command rather than a Station-form
/// field, same reasoning as `set_manual_offline` -- a quick mode switch
/// shouldn't require opening Settings and hitting Save.
#[tauri::command]
pub fn set_tactical_mode(db: State<Db>, enabled: bool) -> StationProfile {
    let conn = db.0.lock().expect("db mutex poisoned");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE station_profile SET tactical_mode = ?1, updated_at = ?2 WHERE id = 1",
        params![enabled as i64, now],
    )
    .expect("failed to update tactical_mode");
    if conn
        .query_row("SELECT COUNT(*) FROM station_profile WHERE id = 1", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0)
        == 0
    {
        conn.execute(
            "INSERT INTO station_profile (id, tactical_mode, updated_at) VALUES (1, ?1, ?2)",
            params![enabled as i64, now],
        )
        .expect("failed to create station_profile for tactical_mode");
    }
    station_profile(&conn)
}

#[tauri::command]
pub fn get_station_profile(db: State<Db>) -> StationProfile {
    let conn = db.0.lock().expect("db mutex poisoned");
    station_profile(&conn)
}

#[tauri::command]
pub fn save_station_profile(
    db: State<Db>,
    callsign: Option<String>,
    grid_square: Option<String>,
    operator_name: Option<String>,
    repeaterbook_token: Option<String>,
    mesh_host: Option<String>,
    rigctld_host: Option<String>,
    rig_enabled: bool,
    rotctld_host: Option<String>,
    rotator_enabled: bool,
    citadel_map_host: Option<String>,
) -> StationProfile {
    let now = chrono::Utc::now().to_rfc3339();
    let conn = db.0.lock().expect("db mutex poisoned");
    // The Station form doesn't own the offline flag or tactical_mode --
    // the header toggle and the mode switch do, respectively. Carry both
    // existing values through rather than clobbering them.
    let existing = station_profile(&conn);
    let manual_offline = existing.manual_offline;
    let tactical_mode = existing.tactical_mode;
    conn.execute(
        "INSERT INTO station_profile (id, callsign, grid_square, operator_name, repeaterbook_token, mesh_host, rigctld_host, rig_enabled, rotctld_host, rotator_enabled, citadel_map_host, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
            callsign = excluded.callsign,
            grid_square = excluded.grid_square,
            operator_name = excluded.operator_name,
            repeaterbook_token = excluded.repeaterbook_token,
            mesh_host = excluded.mesh_host,
            rigctld_host = excluded.rigctld_host,
            rig_enabled = excluded.rig_enabled,
            rotctld_host = excluded.rotctld_host,
            rotator_enabled = excluded.rotator_enabled,
            citadel_map_host = excluded.citadel_map_host,
            updated_at = excluded.updated_at",
        params![callsign, grid_square, operator_name, repeaterbook_token, mesh_host, rigctld_host, rig_enabled as i64, rotctld_host, rotator_enabled as i64, citadel_map_host, now],
    )
    .expect("failed to save station_profile");

    StationProfile {
        callsign,
        grid_square,
        operator_name,
        repeaterbook_token,
        mesh_host,
        rigctld_host,
        manual_offline,
        rig_enabled,
        rotctld_host,
        rotator_enabled,
        tactical_mode,
        citadel_map_host,
        updated_at: Some(now),
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct IncidentInfo {
    pub incident_name: Option<String>,
    pub operational_period: Option<String>,
    pub net_frequency: Option<String>,
    pub net_status: Option<String>,
    pub updated_at: Option<String>,
}

#[tauri::command]
pub fn get_incident_info(db: State<Db>) -> IncidentInfo {
    let conn = db.0.lock().expect("db mutex poisoned");
    conn.query_row(
        "SELECT incident_name, operational_period, net_frequency, net_status, updated_at FROM incident_info WHERE id = 1",
        [],
        |row| {
            Ok(IncidentInfo {
                incident_name: row.get(0)?,
                operational_period: row.get(1)?,
                net_frequency: row.get(2)?,
                net_status: row.get(3)?,
                updated_at: row.get(4)?,
            })
        },
    )
    .optional()
    .expect("failed to query incident_info")
    .unwrap_or_default()
}

#[tauri::command]
pub fn save_incident_info(
    db: State<Db>,
    incident_name: Option<String>,
    operational_period: Option<String>,
    net_frequency: Option<String>,
    net_status: Option<String>,
) -> IncidentInfo {
    let now = chrono::Utc::now().to_rfc3339();
    let conn = db.0.lock().expect("db mutex poisoned");
    conn.execute(
        "INSERT INTO incident_info (id, incident_name, operational_period, net_frequency, net_status, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
            incident_name = excluded.incident_name,
            operational_period = excluded.operational_period,
            net_frequency = excluded.net_frequency,
            net_status = excluded.net_status,
            updated_at = excluded.updated_at",
        params![incident_name, operational_period, net_frequency, net_status, now],
    )
    .expect("failed to save incident_info");

    IncidentInfo {
        incident_name,
        operational_period,
        net_frequency,
        net_status,
        updated_at: Some(now),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Alert {
    pub id: String,
    pub fetched_at: String,
    pub event: String,
    pub severity: String,
    pub headline: Option<String>,
    pub description: Option<String>,
    pub area_desc: Option<String>,
    pub effective: Option<String>,
    pub expires: Option<String>,
}

#[tauri::command]
pub fn get_alerts(db: State<Db>) -> Vec<Alert> {
    let conn = db.0.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare(
            "SELECT id, fetched_at, event, severity, headline, description, area_desc, effective, expires
             FROM alerts ORDER BY effective DESC",
        )
        .expect("failed to prepare alerts query");
    stmt.query_map([], |row| {
        Ok(Alert {
            id: row.get(0)?,
            fetched_at: row.get(1)?,
            event: row.get(2)?,
            severity: row.get(3)?,
            headline: row.get(4)?,
            description: row.get(5)?,
            area_desc: row.get(6)?,
            effective: row.get(7)?,
            expires: row.get(8)?,
        })
    })
    .expect("failed to query alerts")
    .filter_map(Result::ok)
    .collect()
}

/// Replace the full alert set for `source` with `alerts`, in one transaction,
/// only ever called after a *successful* fetch. If NWS can't be reached, the
/// caller simply doesn't call this — whatever was last fetched stays exactly
/// as-is (aging honestly via `fetched_at`), which is the whole point: a
/// warning issued before an outage must stay on screen during it.
pub struct IncomingAlert {
    pub id: String,
    pub event: String,
    pub severity: String,
    pub headline: Option<String>,
    pub description: Option<String>,
    pub area_desc: Option<String>,
    pub effective: Option<String>,
    pub expires: Option<String>,
    pub raw_json: String,
}

pub fn replace_alerts(conn: &mut Connection, source: &str, fetched_at: &str, alerts: &[IncomingAlert]) {
    let tx = conn.transaction().expect("failed to start alerts transaction");
    {
        let ids: Vec<&str> = alerts.iter().map(|a| a.id.as_str()).collect();
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let mut delete_sql = "DELETE FROM alerts WHERE source = ?1".to_string();
        if !ids.is_empty() {
            delete_sql += &format!(" AND id NOT IN ({placeholders})");
        }
        let mut params: Vec<&dyn rusqlite::ToSql> = vec![&source];
        for id in &ids {
            params.push(id);
        }
        tx.execute(&delete_sql, params.as_slice())
            .expect("failed to prune stale alerts");

        for a in alerts {
            tx.execute(
                "INSERT INTO alerts (id, source, fetched_at, via, event, severity, headline, description, area_desc, effective, expires, raw_json)
                 VALUES (?1, ?2, ?3, 'internet', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(id) DO UPDATE SET
                    fetched_at = excluded.fetched_at,
                    event = excluded.event,
                    severity = excluded.severity,
                    headline = excluded.headline,
                    description = excluded.description,
                    area_desc = excluded.area_desc,
                    effective = excluded.effective,
                    expires = excluded.expires,
                    raw_json = excluded.raw_json",
                params![a.id, source, fetched_at, a.event, a.severity, a.headline, a.description, a.area_desc, a.effective, a.expires, a.raw_json],
            )
            .expect("failed to upsert alert");
        }
    }
    tx.commit().expect("failed to commit alerts transaction");
}

#[derive(Debug, Clone, Serialize)]
pub struct NetRosterEntry {
    pub id: i64,
    pub callsign: String,
    pub name: Option<String>,
    pub status: String,
    pub checked_in_at: String,
    pub last_heard_at: Option<String>,
    pub traffic_count: i64,
    pub notes: Option<String>,
    pub grid_square: Option<String>,
    /// Derived from grid_square on every read, never stored -- see
    /// migration v26's note on why lat/lon isn't persisted here.
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

fn net_roster_from_row(row: &rusqlite::Row) -> rusqlite::Result<NetRosterEntry> {
    let grid_square: Option<String> = row.get(8)?;
    let coords = grid_square.as_deref().and_then(grid_square_to_lat_lon);
    Ok(NetRosterEntry {
        id: row.get(0)?,
        callsign: row.get(1)?,
        name: row.get(2)?,
        status: row.get(3)?,
        checked_in_at: row.get(4)?,
        last_heard_at: row.get(5)?,
        traffic_count: row.get(6)?,
        notes: row.get(7)?,
        grid_square,
        latitude: coords.map(|(lat, _)| lat),
        longitude: coords.map(|(_, lon)| lon),
    })
}

#[tauri::command]
pub fn get_net_roster(db: State<Db>) -> Vec<NetRosterEntry> {
    let conn = db.0.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare(
            "SELECT id, callsign, name, status, checked_in_at, last_heard_at, traffic_count, notes, grid_square
             FROM net_roster ORDER BY checked_in_at ASC",
        )
        .expect("failed to prepare net_roster query");
    stmt.query_map([], net_roster_from_row)
        .expect("failed to query net_roster")
        .filter_map(Result::ok)
        .collect()
}

#[tauri::command]
pub fn check_in_station(
    db: State<Db>,
    callsign: String,
    name: Option<String>,
    notes: Option<String>,
    grid_square: Option<String>,
) -> NetRosterEntry {
    let now = chrono::Utc::now().to_rfc3339();
    let conn = db.0.lock().expect("db mutex poisoned");
    conn.execute(
        "INSERT INTO net_roster (callsign, name, status, checked_in_at, traffic_count, notes, grid_square)
         VALUES (?1, ?2, 'checked_in', ?3, 0, ?4, ?5)",
        params![callsign, name, now, notes, grid_square],
    )
    .expect("failed to check in station");
    let id = conn.last_insert_rowid();
    let coords = grid_square.as_deref().and_then(grid_square_to_lat_lon);
    NetRosterEntry {
        id,
        callsign,
        name,
        status: "checked_in".to_string(),
        checked_in_at: now,
        last_heard_at: None,
        traffic_count: 0,
        notes,
        grid_square,
        latitude: coords.map(|(lat, _)| lat),
        longitude: coords.map(|(_, lon)| lon),
    }
}

#[tauri::command]
pub fn check_out_station(db: State<Db>, id: i64) {
    let conn = db.0.lock().expect("db mutex poisoned");
    conn.execute(
        "UPDATE net_roster SET status = 'checked_out' WHERE id = ?1",
        params![id],
    )
    .expect("failed to check out station");
}

#[tauri::command]
pub fn mark_heard(db: State<Db>, id: i64) {
    let now = chrono::Utc::now().to_rfc3339();
    let conn = db.0.lock().expect("db mutex poisoned");
    conn.execute(
        "UPDATE net_roster SET last_heard_at = ?1, traffic_count = traffic_count + 1 WHERE id = ?2",
        params![now, id],
    )
    .expect("failed to mark station heard");
}

#[tauri::command]
pub fn clear_net_roster(db: State<Db>) {
    let conn = db.0.lock().expect("db mutex poisoned");
    conn.execute("DELETE FROM net_roster", [])
        .expect("failed to clear net_roster");
}

#[derive(Debug, Clone, Serialize)]
pub struct Message {
    pub id: i64,
    pub precedence: String,
    pub date_time: String,
    pub to_station: Option<String>,
    pub to_name: Option<String>,
    pub from_station: Option<String>,
    pub from_name: Option<String>,
    pub subject: Option<String>,
    pub message_text: String,
    pub content_hash: Option<String>,
    /// 'queued' (no transport has accepted this yet) or 'dispatched'.
    /// Separate from any individual transport's own delivery tracking
    /// (e.g. mesh_messages' sent/delivered/failed) -- this only answers
    /// "did the dispatcher hand it to something," not "did it arrive."
    pub dispatch_status: String,
    pub dispatched_via: Option<String>,
    // -- Canonical object header (v30) -- see the migration's comment for
    // the full rationale. Same six fields, same meaning, on every object
    // type; `map_markers` carries the identical set below.
    pub uuid: String,
    pub revision: i64,
    pub updated_at: Option<String>,
    pub incident_id: Option<String>,
    pub expires_at: Option<String>,
    pub trust_state: String,
}

const MESSAGE_COLUMNS: &str =
    "id, precedence, date_time, to_station, to_name, from_station, from_name, subject, message_text, content_hash, dispatch_status, dispatched_via, uuid, revision, updated_at, incident_id, expires_at, trust_state";

fn message_from_row(row: &rusqlite::Row) -> rusqlite::Result<Message> {
    Ok(Message {
        id: row.get(0)?,
        precedence: row.get(1)?,
        date_time: row.get(2)?,
        to_station: row.get(3)?,
        to_name: row.get(4)?,
        from_station: row.get(5)?,
        from_name: row.get(6)?,
        subject: row.get(7)?,
        message_text: row.get(8)?,
        content_hash: row.get(9)?,
        dispatch_status: row.get(10)?,
        dispatched_via: row.get(11)?,
        uuid: row.get(12)?,
        revision: row.get(13)?,
        updated_at: row.get(14)?,
        incident_id: row.get(15)?,
        expires_at: row.get(16)?,
        trust_state: row.get(17)?,
    })
}

#[tauri::command]
pub fn get_messages(db: State<Db>) -> Vec<Message> {
    let conn = db.0.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare(&format!("SELECT {MESSAGE_COLUMNS} FROM messages ORDER BY id ASC"))
        .expect("failed to prepare messages query");
    stmt.query_map([], message_from_row)
        .expect("failed to query messages")
        .filter_map(Result::ok)
        .collect()
}

/// Used by the dispatcher (not exposed as a command itself) to re-fetch a
/// single message after an update, without pulling the whole table.
pub fn get_message(conn: &Connection, id: i64) -> Option<Message> {
    conn.query_row(&format!("SELECT {MESSAGE_COLUMNS} FROM messages WHERE id = ?1"), params![id], message_from_row)
        .optional()
        .expect("failed to query message")
}

/// Every message still sitting in 'queued' with somewhere to send it --
/// what the dispatcher retries whenever a transport comes back up.
pub fn queued_messages(conn: &Connection) -> Vec<Message> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {MESSAGE_COLUMNS} FROM messages WHERE dispatch_status = 'queued' AND to_station IS NOT NULL AND trim(to_station) != ''"
        ))
        .expect("failed to prepare queued-messages query");
    stmt.query_map([], message_from_row)
        .expect("failed to query queued messages")
        .filter_map(Result::ok)
        .collect()
}

pub fn mark_message_dispatched(conn: &Connection, id: i64, via: &str) {
    conn.execute(
        "UPDATE messages SET dispatch_status = 'dispatched', dispatched_via = ?1 WHERE id = ?2",
        params![via, id],
    )
    .expect("failed to mark message dispatched");
}

/// A dedup key for message content, independent of *when* or *how many
/// times* it was logged. Deliberately excludes date_time -- the same
/// message content re-logged later should still hash the same, since the
/// point is recognizing "this is the message I already have," not "this
/// exact row." Not a security boundary, just a stable content-addressed
/// key, so a plain SHA-256 (no salt/HMAC) is the right amount of hashing.
fn content_hash(from: Option<&str>, to: Option<&str>, subject: Option<&str>, text: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for part in [from.unwrap_or("").trim(), to.unwrap_or("").trim(), subject.unwrap_or("").trim(), text.trim()] {
        hasher.update(part.as_bytes());
        hasher.update([0u8]); // separator, so "ab"+"c" can't collide with "a"+"bc"
    }
    format!("{:x}", hasher.finalize())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_message(
    db: State<Db>,
    precedence: String,
    to_station: Option<String>,
    to_name: Option<String>,
    from_station: Option<String>,
    from_name: Option<String>,
    subject: Option<String>,
    message_text: String,
) -> Message {
    let now = chrono::Utc::now().to_rfc3339();
    let hash = content_hash(from_station.as_deref(), to_station.as_deref(), subject.as_deref(), &message_text);
    let uuid = uuid::Uuid::new_v4().to_string();
    let conn = db.0.lock().expect("db mutex poisoned");
    conn.execute(
        "INSERT INTO messages (precedence, date_time, to_station, to_name, from_station, from_name, subject, message_text, content_hash, uuid, updated_at, trust_state)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'local')",
        params![precedence, now, to_station, to_name, from_station, from_name, subject, message_text, hash, uuid, now],
    )
    .expect("failed to create message");
    let id = conn.last_insert_rowid();
    Message {
        id,
        precedence,
        date_time: now.clone(),
        to_station,
        to_name,
        from_station,
        from_name,
        subject,
        message_text,
        content_hash: Some(hash),
        dispatch_status: "queued".to_string(),
        dispatched_via: None,
        uuid,
        revision: 1,
        updated_at: Some(now),
        incident_id: None,
        expires_at: None,
        trust_state: "local".to_string(),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MapMarker {
    pub id: i64,
    pub label: String,
    pub marker_type: String,
    pub latitude: f64,
    pub longitude: f64,
    pub origin_station: Option<String>,
    pub to_station: Option<String>,
    pub created_at: String,
    pub content_hash: String,
    /// 'queued' (locally created, not yet sent anywhere), 'dispatched'
    /// (locally created, a transport accepted it), or 'received' (this
    /// pin came in from another station -- there's nothing for us to
    /// dispatch, it's already here).
    pub dispatch_status: String,
    pub dispatched_via: Option<String>,
    pub received_via: Option<String>,
    // -- Canonical object header (v30) -- identical shape to Message's,
    // see that struct / the v30 migration comment for the rationale.
    pub uuid: String,
    pub revision: i64,
    pub updated_at: Option<String>,
    pub incident_id: Option<String>,
    pub expires_at: Option<String>,
    pub trust_state: String,
}

const MARKER_COLUMNS: &str =
    "id, label, marker_type, latitude, longitude, origin_station, to_station, created_at, content_hash, dispatch_status, dispatched_via, received_via, uuid, revision, updated_at, incident_id, expires_at, trust_state";

fn marker_from_row(row: &rusqlite::Row) -> rusqlite::Result<MapMarker> {
    Ok(MapMarker {
        id: row.get(0)?,
        label: row.get(1)?,
        marker_type: row.get(2)?,
        latitude: row.get(3)?,
        longitude: row.get(4)?,
        origin_station: row.get(5)?,
        to_station: row.get(6)?,
        created_at: row.get(7)?,
        content_hash: row.get(8)?,
        dispatch_status: row.get(9)?,
        dispatched_via: row.get(10)?,
        received_via: row.get(11)?,
        uuid: row.get(12)?,
        revision: row.get(13)?,
        updated_at: row.get(14)?,
        incident_id: row.get(15)?,
        expires_at: row.get(16)?,
        trust_state: row.get(17)?,
    })
}

#[tauri::command]
pub fn get_markers(db: State<Db>) -> Vec<MapMarker> {
    let conn = db.0.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare(&format!("SELECT {MARKER_COLUMNS} FROM map_markers ORDER BY created_at DESC"))
        .expect("failed to prepare markers query");
    stmt.query_map([], marker_from_row)
        .expect("failed to query markers")
        .filter_map(Result::ok)
        .collect()
}

/// Used by the dispatcher to re-fetch a single marker after an update.
pub fn get_marker(conn: &Connection, id: i64) -> Option<MapMarker> {
    conn.query_row(&format!("SELECT {MARKER_COLUMNS} FROM map_markers WHERE id = ?1"), params![id], marker_from_row)
        .optional()
        .expect("failed to query marker")
}

/// Every locally-created marker still sitting in 'queued' -- what the
/// dispatcher retries whenever a transport comes back up.
pub fn queued_markers(conn: &Connection) -> Vec<MapMarker> {
    let mut stmt = conn
        .prepare(&format!("SELECT {MARKER_COLUMNS} FROM map_markers WHERE dispatch_status = 'queued'"))
        .expect("failed to prepare queued-markers query");
    stmt.query_map([], marker_from_row)
        .expect("failed to query queued markers")
        .filter_map(Result::ok)
        .collect()
}

pub fn mark_marker_dispatched(conn: &Connection, id: i64, via: &str) {
    conn.execute(
        "UPDATE map_markers SET dispatch_status = 'dispatched', dispatched_via = ?1 WHERE id = ?2",
        params![via, id],
    )
    .expect("failed to mark marker dispatched");
}

/// Same dedup-key shape as the messages table's content_hash, rounded to
/// 6 decimal places (~11cm) so float formatting noise can't split one
/// real-world pin into two different hashes.
fn marker_content_hash(label: &str, marker_type: &str, latitude: f64, longitude: f64, origin: Option<&str>) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for part in [
        label.trim(),
        marker_type.trim(),
        &format!("{latitude:.6}"),
        &format!("{longitude:.6}"),
        origin.unwrap_or("").trim(),
    ] {
        hasher.update(part.as_bytes());
        hasher.update([0u8]);
    }
    format!("{:x}", hasher.finalize())
}

#[tauri::command]
pub fn create_marker(
    db: State<Db>,
    label: String,
    marker_type: String,
    latitude: f64,
    longitude: f64,
    to_station: Option<String>,
) -> Result<MapMarker, String> {
    let conn = db.0.lock().expect("db mutex poisoned");
    let origin = station_profile(&conn).callsign;
    let hash = marker_content_hash(&label, &marker_type, latitude, longitude, origin.as_deref());
    let now = chrono::Utc::now().to_rfc3339();
    let uuid = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO map_markers (label, marker_type, latitude, longitude, origin_station, to_station, created_at, content_hash, dispatch_status, uuid, updated_at, trust_state)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'queued', ?9, ?10, 'local')",
        params![label, marker_type, latitude, longitude, origin, to_station, now, hash, uuid, now],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    get_marker(&conn, id).ok_or_else(|| "marker vanished immediately after insert".to_string())
}

/// Inserts a marker that arrived from another station over some
/// transport. `ON CONFLICT(content_hash) DO NOTHING` is the real dedup:
/// a mesh hop rebroadcasting the same pin (including our own, echoed
/// back after a relay) must not plot a second copy.
pub fn insert_received_marker(
    conn: &Connection,
    label: &str,
    marker_type: &str,
    latitude: f64,
    longitude: f64,
    origin: Option<&str>,
    via: &str,
) {
    let hash = marker_content_hash(label, marker_type, latitude, longitude, origin);
    let now = chrono::Utc::now().to_rfc3339();
    let uuid = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO map_markers (label, marker_type, latitude, longitude, origin_station, created_at, content_hash, dispatch_status, received_via, uuid, updated_at, trust_state)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'received', ?8, ?9, ?10, 'received')
         ON CONFLICT(content_hash) DO NOTHING",
        params![label, marker_type, latitude, longitude, origin, now, hash, via, uuid, now],
    )
    .expect("failed to insert received marker");
}

#[derive(Debug, Clone, Serialize)]
pub struct Resource {
    pub id: i64,
    pub label: String,
    pub raw_tokens: String,
    pub updated_at: String,
    pub grid_square: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

#[tauri::command]
pub fn get_resources(db: State<Db>) -> Vec<Resource> {
    let conn = db.0.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare("SELECT id, label, raw_tokens, updated_at, grid_square FROM resources ORDER BY label ASC")
        .expect("failed to prepare resources query");
    stmt.query_map([], |row| {
        let grid_square: Option<String> = row.get(4)?;
        let coords = grid_square.as_deref().and_then(grid_square_to_lat_lon);
        Ok(Resource {
            id: row.get(0)?,
            label: row.get(1)?,
            raw_tokens: row.get(2)?,
            updated_at: row.get(3)?,
            grid_square,
            latitude: coords.map(|(lat, _)| lat),
            longitude: coords.map(|(_, lon)| lon),
        })
    })
    .expect("failed to query resources")
    .filter_map(Result::ok)
    .collect()
}

#[tauri::command]
pub fn upsert_resource(
    db: State<Db>,
    id: Option<i64>,
    label: String,
    raw_tokens: String,
    grid_square: Option<String>,
) -> Resource {
    let now = chrono::Utc::now().to_rfc3339();
    let conn = db.0.lock().expect("db mutex poisoned");
    let id = match id {
        Some(existing_id) => {
            conn.execute(
                "UPDATE resources SET label = ?1, raw_tokens = ?2, updated_at = ?3, grid_square = ?4 WHERE id = ?5",
                params![label, raw_tokens, now, grid_square, existing_id],
            )
            .expect("failed to update resource");
            existing_id
        }
        None => {
            conn.execute(
                "INSERT INTO resources (label, raw_tokens, updated_at, grid_square) VALUES (?1, ?2, ?3, ?4)",
                params![label, raw_tokens, now, grid_square],
            )
            .expect("failed to insert resource");
            conn.last_insert_rowid()
        }
    };
    let coords = grid_square.as_deref().and_then(grid_square_to_lat_lon);
    Resource {
        id,
        label,
        raw_tokens,
        updated_at: now,
        grid_square,
        latitude: coords.map(|(lat, _)| lat),
        longitude: coords.map(|(_, lon)| lon),
    }
}

#[tauri::command]
pub fn delete_resource(db: State<Db>, id: i64) {
    let conn = db.0.lock().expect("db mutex poisoned");
    conn.execute("DELETE FROM resources WHERE id = ?1", params![id])
        .expect("failed to delete resource");
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SpaceWeather {
    pub fetched_at: Option<String>,
    pub updated_label: Option<String>,
    pub solar_flux: Option<i64>,
    pub a_index: Option<i64>,
    pub k_index: Option<i64>,
    pub sunspots: Option<i64>,
    pub xray: Option<String>,
    pub proton_flux: Option<i64>,
    pub electron_flux: Option<i64>,
    pub aurora: Option<i64>,
    pub solar_wind: Option<f64>,
    pub magnetic_field: Option<f64>,
    pub geomag_field: Option<String>,
    pub signal_noise: Option<String>,
    /// JSON-serialized array of {name, time, condition} — N0NBH's
    /// per-band HF condition table (80m-40m/30m-20m/17m-15m/12m-10m,
    /// day/night). Stored as opaque JSON rather than its own table since
    /// it's a fixed-shape singleton, same reasoning as everything else in
    /// this row.
    pub band_conditions: Option<String>,
    pub r_scale: Option<i64>,
    pub r_text: Option<String>,
    pub s_scale: Option<i64>,
    pub s_text: Option<String>,
    pub g_scale: Option<i64>,
    pub g_text: Option<String>,
}

#[tauri::command]
pub fn get_space_weather(db: State<Db>) -> SpaceWeather {
    let conn = db.0.lock().expect("db mutex poisoned");
    conn.query_row(
        "SELECT fetched_at, updated_label, solar_flux, a_index, k_index, sunspots, xray,
                proton_flux, electron_flux, aurora, solar_wind, magnetic_field, geomag_field, signal_noise,
                band_conditions, r_scale, r_text, s_scale, s_text, g_scale, g_text
         FROM space_weather WHERE id = 1",
        [],
        |row| {
            Ok(SpaceWeather {
                fetched_at: row.get(0)?,
                updated_label: row.get(1)?,
                solar_flux: row.get(2)?,
                a_index: row.get(3)?,
                k_index: row.get(4)?,
                sunspots: row.get(5)?,
                xray: row.get(6)?,
                proton_flux: row.get(7)?,
                electron_flux: row.get(8)?,
                aurora: row.get(9)?,
                solar_wind: row.get(10)?,
                magnetic_field: row.get(11)?,
                geomag_field: row.get(12)?,
                signal_noise: row.get(13)?,
                band_conditions: row.get(14)?,
                r_scale: row.get(15)?,
                r_text: row.get(16)?,
                s_scale: row.get(17)?,
                s_text: row.get(18)?,
                g_scale: row.get(19)?,
                g_text: row.get(20)?,
            })
        },
    )
    .optional()
    .expect("failed to query space_weather")
    .unwrap_or_default()
}

#[allow(clippy::too_many_arguments)]
#[allow(clippy::too_many_arguments)]
pub fn save_space_weather(conn: &Connection, source: &str, fetched_at: &str, sw: &SpaceWeather) {
    conn.execute(
        "INSERT INTO space_weather (id, source, fetched_at, via, updated_label, solar_flux, a_index, k_index,
            sunspots, xray, proton_flux, electron_flux, aurora, solar_wind, magnetic_field, geomag_field, signal_noise,
            band_conditions, r_scale, r_text, s_scale, s_text, g_scale, g_text)
         VALUES (1, ?1, ?2, 'internet', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
         ON CONFLICT(id) DO UPDATE SET
            source = excluded.source, fetched_at = excluded.fetched_at, updated_label = excluded.updated_label,
            solar_flux = excluded.solar_flux, a_index = excluded.a_index, k_index = excluded.k_index,
            sunspots = excluded.sunspots, xray = excluded.xray, proton_flux = excluded.proton_flux,
            electron_flux = excluded.electron_flux, aurora = excluded.aurora, solar_wind = excluded.solar_wind,
            magnetic_field = excluded.magnetic_field, geomag_field = excluded.geomag_field, signal_noise = excluded.signal_noise,
            band_conditions = excluded.band_conditions, r_scale = excluded.r_scale, r_text = excluded.r_text,
            s_scale = excluded.s_scale, s_text = excluded.s_text, g_scale = excluded.g_scale, g_text = excluded.g_text",
        params![source, fetched_at, sw.updated_label, sw.solar_flux, sw.a_index, sw.k_index, sw.sunspots,
            sw.xray, sw.proton_flux, sw.electron_flux, sw.aurora, sw.solar_wind, sw.magnetic_field,
            sw.geomag_field, sw.signal_noise, sw.band_conditions, sw.r_scale, sw.r_text, sw.s_scale,
            sw.s_text, sw.g_scale, sw.g_text],
    )
    .expect("failed to save space_weather");
}

#[derive(Debug, Clone, Serialize)]
pub struct Channel {
    pub id: i64,
    pub label: String,
    pub frequency: String,
    pub tone_offset: Option<String>,
    pub notes: Option<String>,
    pub updated_at: String,
}

#[tauri::command]
pub fn get_channels(db: State<Db>) -> Vec<Channel> {
    let conn = db.0.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare("SELECT id, label, frequency, tone_offset, notes, updated_at FROM channels ORDER BY label ASC")
        .expect("failed to prepare channels query");
    stmt.query_map([], |row| {
        Ok(Channel {
            id: row.get(0)?,
            label: row.get(1)?,
            frequency: row.get(2)?,
            tone_offset: row.get(3)?,
            notes: row.get(4)?,
            updated_at: row.get(5)?,
        })
    })
    .expect("failed to query channels")
    .filter_map(Result::ok)
    .collect()
}

#[tauri::command]
pub fn upsert_channel(
    db: State<Db>,
    id: Option<i64>,
    label: String,
    frequency: String,
    tone_offset: Option<String>,
    notes: Option<String>,
) -> Channel {
    let now = chrono::Utc::now().to_rfc3339();
    let conn = db.0.lock().expect("db mutex poisoned");
    let id = match id {
        Some(existing_id) => {
            conn.execute(
                "UPDATE channels SET label = ?1, frequency = ?2, tone_offset = ?3, notes = ?4, updated_at = ?5 WHERE id = ?6",
                params![label, frequency, tone_offset, notes, now, existing_id],
            )
            .expect("failed to update channel");
            existing_id
        }
        None => {
            conn.execute(
                "INSERT INTO channels (label, frequency, tone_offset, notes, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![label, frequency, tone_offset, notes, now],
            )
            .expect("failed to insert channel");
            conn.last_insert_rowid()
        }
    };
    Channel { id, label, frequency, tone_offset, notes, updated_at: now }
}

#[tauri::command]
pub fn delete_channel(db: State<Db>, id: i64) {
    let conn = db.0.lock().expect("db mutex poisoned");
    conn.execute("DELETE FROM channels WHERE id = ?1", params![id])
        .expect("failed to delete channel");
}

#[derive(Debug, Clone, Serialize)]
pub struct Contest {
    pub id: String,
    pub fetched_at: String,
    pub label: String,
    pub starts_at: String,
    pub ends_at: Option<String>,
    pub detail_url: Option<String>,
}

#[tauri::command]
pub fn get_contests(db: State<Db>) -> Vec<Contest> {
    let conn = db.0.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare(
            "SELECT id, fetched_at, label, starts_at, ends_at, detail_url
             FROM contests ORDER BY starts_at ASC",
        )
        .expect("failed to prepare contests query");
    stmt.query_map([], |row| {
        Ok(Contest {
            id: row.get(0)?,
            fetched_at: row.get(1)?,
            label: row.get(2)?,
            starts_at: row.get(3)?,
            ends_at: row.get(4)?,
            detail_url: row.get(5)?,
        })
    })
    .expect("failed to query contests")
    .filter_map(Result::ok)
    .collect()
}

/// Same replace-on-successful-fetch pattern as `replace_alerts`: only ever
/// called after the ICS feed fetch succeeds, so a fetch failure just leaves
/// the last-known list in place (aging honestly via `fetched_at`).
pub struct IncomingContest {
    pub id: String,
    pub label: String,
    pub starts_at: String,
    pub ends_at: Option<String>,
    pub detail_url: Option<String>,
}

pub fn replace_contests(conn: &mut Connection, source: &str, fetched_at: &str, contests: &[IncomingContest]) {
    let tx = conn.transaction().expect("failed to start contests transaction");
    {
        let ids: Vec<&str> = contests.iter().map(|c| c.id.as_str()).collect();
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let mut delete_sql = "DELETE FROM contests WHERE source = ?1".to_string();
        if !ids.is_empty() {
            delete_sql += &format!(" AND id NOT IN ({placeholders})");
        }
        let mut params: Vec<&dyn rusqlite::ToSql> = vec![&source];
        for id in &ids {
            params.push(id);
        }
        tx.execute(&delete_sql, params.as_slice())
            .expect("failed to prune stale contests");

        for c in contests {
            tx.execute(
                "INSERT INTO contests (id, source, fetched_at, via, label, starts_at, ends_at, detail_url)
                 VALUES (?1, ?2, ?3, 'internet', ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                    fetched_at = excluded.fetched_at,
                    label = excluded.label,
                    starts_at = excluded.starts_at,
                    ends_at = excluded.ends_at,
                    detail_url = excluded.detail_url",
                params![c.id, source, fetched_at, c.label, c.starts_at, c.ends_at, c.detail_url],
            )
            .expect("failed to upsert contest");
        }
    }
    tx.commit().expect("failed to commit contests transaction");
}

#[derive(Debug, Clone, Serialize)]
pub struct PskSpot {
    pub id: i64,
    pub fetched_at: String,
    pub heard_by_call: String,
    pub heard_by_grid: Option<String>,
    pub freq_mhz: Option<f64>,
    pub mode: Option<String>,
    pub snr: Option<i64>,
    pub distance_km: Option<f64>,
    pub bearing_deg: Option<i64>,
    pub heard_at: String,
}

#[tauri::command]
pub fn get_psk_spots(db: State<Db>) -> Vec<PskSpot> {
    let conn = db.0.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare(
            "SELECT id, fetched_at, heard_by_call, heard_by_grid, freq_mhz, mode, snr, distance_km, bearing_deg, heard_at
             FROM psk_spots ORDER BY heard_at DESC",
        )
        .expect("failed to prepare psk_spots query");
    stmt.query_map([], |row| {
        Ok(PskSpot {
            id: row.get(0)?,
            fetched_at: row.get(1)?,
            heard_by_call: row.get(2)?,
            heard_by_grid: row.get(3)?,
            freq_mhz: row.get(4)?,
            mode: row.get(5)?,
            snr: row.get(6)?,
            distance_km: row.get(7)?,
            bearing_deg: row.get(8)?,
            heard_at: row.get(9)?,
        })
    })
    .expect("failed to query psk_spots")
    .filter_map(Result::ok)
    .collect()
}

/// Same replace-on-successful-fetch pattern as alerts/contests, scoped to
/// `my_callsign` since a fresh fetch each poll already covers the full
/// requested window (`days=1`) — no incremental accumulation needed.
pub struct IncomingPskSpot {
    pub heard_by_call: String,
    pub heard_by_grid: Option<String>,
    pub freq_mhz: Option<f64>,
    pub mode: Option<String>,
    pub snr: Option<i64>,
    pub distance_km: Option<f64>,
    pub bearing_deg: Option<i64>,
    pub heard_at: String,
}

pub fn replace_psk_spots(
    conn: &mut Connection,
    source: &str,
    fetched_at: &str,
    my_callsign: &str,
    spots: &[IncomingPskSpot],
) {
    let tx = conn.transaction().expect("failed to start psk_spots transaction");
    {
        tx.execute("DELETE FROM psk_spots WHERE my_callsign = ?1", params![my_callsign])
            .expect("failed to clear old psk_spots");
        for s in spots {
            tx.execute(
                "INSERT INTO psk_spots (source, fetched_at, via, my_callsign, heard_by_call, heard_by_grid,
                    freq_mhz, mode, snr, distance_km, bearing_deg, heard_at)
                 VALUES (?1, ?2, 'internet', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![source, fetched_at, my_callsign, s.heard_by_call, s.heard_by_grid, s.freq_mhz,
                    s.mode, s.snr, s.distance_km, s.bearing_deg, s.heard_at],
            )
            .expect("failed to insert psk_spot");
        }
    }
    tx.commit().expect("failed to commit psk_spots transaction");
}

#[derive(Debug, Clone, Serialize)]
pub struct PotaSpot {
    pub id: i64,
    pub fetched_at: String,
    pub activator: String,
    pub frequency_mhz: Option<f64>,
    pub mode: Option<String>,
    pub reference: String,
    pub park_name: Option<String>,
    pub location_desc: Option<String>,
    pub grid: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub spot_time: String,
    pub comments: Option<String>,
}

#[tauri::command]
pub fn get_pota_spots(db: State<Db>) -> Vec<PotaSpot> {
    let conn = db.0.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare(
            "SELECT id, fetched_at, activator, frequency_mhz, mode, reference, park_name,
                    location_desc, grid, latitude, longitude, spot_time, comments
             FROM pota_spots ORDER BY spot_time DESC",
        )
        .expect("failed to prepare pota_spots query");
    stmt.query_map([], |row| {
        Ok(PotaSpot {
            id: row.get(0)?,
            fetched_at: row.get(1)?,
            activator: row.get(2)?,
            frequency_mhz: row.get(3)?,
            mode: row.get(4)?,
            reference: row.get(5)?,
            park_name: row.get(6)?,
            location_desc: row.get(7)?,
            grid: row.get(8)?,
            latitude: row.get(9)?,
            longitude: row.get(10)?,
            spot_time: row.get(11)?,
            comments: row.get(12)?,
        })
    })
    .expect("failed to query pota_spots")
    .filter_map(Result::ok)
    .collect()
}

/// Same replace-on-successful-fetch pattern as contests/psk_spots — a
/// fresh fetch each poll already covers current activity, no incremental
/// accumulation needed.
#[allow(clippy::too_many_arguments)]
pub struct IncomingPotaSpot {
    pub spot_id: i64,
    pub activator: String,
    pub frequency_mhz: Option<f64>,
    pub mode: Option<String>,
    pub reference: String,
    pub park_name: Option<String>,
    pub location_desc: Option<String>,
    pub grid: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub spot_time: String,
    pub comments: Option<String>,
}

pub fn replace_pota_spots(conn: &mut Connection, source: &str, fetched_at: &str, spots: &[IncomingPotaSpot]) {
    let tx = conn.transaction().expect("failed to start pota_spots transaction");
    {
        tx.execute("DELETE FROM pota_spots WHERE source = ?1", params![source])
            .expect("failed to clear old pota_spots");
        for s in spots {
            tx.execute(
                "INSERT INTO pota_spots (source, fetched_at, via, spot_id, activator, frequency_mhz, mode,
                    reference, park_name, location_desc, grid, latitude, longitude, spot_time, comments)
                 VALUES (?1, ?2, 'internet', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![source, fetched_at, s.spot_id, s.activator, s.frequency_mhz, s.mode, s.reference,
                    s.park_name, s.location_desc, s.grid, s.latitude, s.longitude, s.spot_time, s.comments],
            )
            .expect("failed to insert pota_spot");
        }
    }
    tx.commit().expect("failed to commit pota_spots transaction");
}

#[derive(Debug, Clone, Serialize)]
pub struct DxSpot {
    pub id: i64,
    pub fetched_at: String,
    pub spotter: String,
    pub dx_call: String,
    pub freq_mhz: f64,
    pub comment: Option<String>,
    pub spot_time: String,
}

#[tauri::command]
pub fn get_dx_spots(db: State<Db>) -> Vec<DxSpot> {
    let conn = db.0.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare(
            "SELECT id, fetched_at, spotter, dx_call, freq_mhz, comment, spot_time
             FROM dx_spots ORDER BY id DESC LIMIT 200",
        )
        .expect("failed to prepare dx_spots query");
    stmt.query_map([], |row| {
        Ok(DxSpot {
            id: row.get(0)?,
            fetched_at: row.get(1)?,
            spotter: row.get(2)?,
            dx_call: row.get(3)?,
            freq_mhz: row.get(4)?,
            comment: row.get(5)?,
            spot_time: row.get(6)?,
        })
    })
    .expect("failed to query dx_spots")
    .filter_map(Result::ok)
    .collect()
}

/// Insert-only, unlike the other "replace whole set" ingest tables — this
/// is a live stream, not a fetch-and-snapshot. Prunes down to the newest
/// 500 rows on every insert rather than running on a timer, so it never
/// needs its own scheduling.
pub struct IncomingDxSpot {
    pub spotter: String,
    pub dx_call: String,
    pub freq_mhz: f64,
    pub comment: Option<String>,
    pub spot_time: String,
}

pub fn insert_dx_spot(conn: &Connection, source: &str, fetched_at: &str, spot: &IncomingDxSpot) {
    conn.execute(
        "INSERT INTO dx_spots (source, fetched_at, via, spotter, dx_call, freq_mhz, comment, spot_time)
         VALUES (?1, ?2, 'internet', ?3, ?4, ?5, ?6, ?7)",
        params![source, fetched_at, spot.spotter, spot.dx_call, spot.freq_mhz, spot.comment, spot.spot_time],
    )
    .expect("failed to insert dx_spot");
    conn.execute(
        "DELETE FROM dx_spots WHERE id NOT IN (SELECT id FROM dx_spots ORDER BY id DESC LIMIT 500)",
        [],
    )
    .expect("failed to prune dx_spots");
}

#[derive(Debug, Clone, Serialize)]
pub struct SatelliteTle {
    pub norad_id: i64,
    pub name: String,
    pub fetched_at: String,
    pub line1: String,
    pub line2: String,
}

#[tauri::command]
pub fn get_satellite_tles(db: State<Db>) -> Vec<SatelliteTle> {
    let conn = db.0.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare("SELECT norad_id, name, fetched_at, line1, line2 FROM satellite_tles ORDER BY name ASC")
        .expect("failed to prepare satellite_tles query");
    stmt.query_map([], |row| {
        Ok(SatelliteTle {
            norad_id: row.get(0)?,
            name: row.get(1)?,
            fetched_at: row.get(2)?,
            line1: row.get(3)?,
            line2: row.get(4)?,
        })
    })
    .expect("failed to query satellite_tles")
    .filter_map(Result::ok)
    .collect()
}

pub struct IncomingTle {
    pub norad_id: i64,
    pub name: String,
    pub line1: String,
    pub line2: String,
}

pub fn replace_satellite_tles(conn: &mut Connection, source: &str, fetched_at: &str, tles: &[IncomingTle]) {
    let tx = conn.transaction().expect("failed to start satellite_tles transaction");
    {
        tx.execute("DELETE FROM satellite_tles WHERE source = ?1", params![source])
            .expect("failed to clear old satellite_tles");
        for t in tles {
            tx.execute(
                "INSERT INTO satellite_tles (norad_id, source, fetched_at, via, name, line1, line2)
                 VALUES (?1, ?2, ?3, 'internet', ?4, ?5, ?6)
                 ON CONFLICT(norad_id) DO UPDATE SET
                    source = excluded.source, fetched_at = excluded.fetched_at,
                    name = excluded.name, line1 = excluded.line1, line2 = excluded.line2",
                params![t.norad_id, source, fetched_at, t.name, t.line1, t.line2],
            )
            .expect("failed to upsert satellite_tle");
        }
    }
    tx.commit().expect("failed to commit satellite_tles transaction");
}

#[derive(Debug, Clone, Serialize)]
pub struct QsoLogEntry {
    pub id: i64,
    pub call: String,
    pub qso_date: String,
    pub time_on: String,
    pub band: Option<String>,
    pub freq_mhz: Option<f64>,
    pub mode: String,
    pub rst_sent: Option<String>,
    pub rst_rcvd: Option<String>,
    pub name: Option<String>,
    pub gridsquare: Option<String>,
    pub comment: Option<String>,
    pub updated_at: String,
}

#[tauri::command]
pub fn get_qso_log(db: State<Db>) -> Vec<QsoLogEntry> {
    let conn = db.0.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare(
            "SELECT id, call, qso_date, time_on, band, freq_mhz, mode, rst_sent, rst_rcvd, name, gridsquare, comment, updated_at
             FROM qso_log ORDER BY qso_date DESC, time_on DESC",
        )
        .expect("failed to prepare qso_log query");
    stmt.query_map([], |row| {
        Ok(QsoLogEntry {
            id: row.get(0)?,
            call: row.get(1)?,
            qso_date: row.get(2)?,
            time_on: row.get(3)?,
            band: row.get(4)?,
            freq_mhz: row.get(5)?,
            mode: row.get(6)?,
            rst_sent: row.get(7)?,
            rst_rcvd: row.get(8)?,
            name: row.get(9)?,
            gridsquare: row.get(10)?,
            comment: row.get(11)?,
            updated_at: row.get(12)?,
        })
    })
    .expect("failed to query qso_log")
    .filter_map(Result::ok)
    .collect()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn upsert_qso_log_entry(
    db: State<Db>,
    id: Option<i64>,
    call: String,
    qso_date: String,
    time_on: String,
    band: Option<String>,
    freq_mhz: Option<f64>,
    mode: String,
    rst_sent: Option<String>,
    rst_rcvd: Option<String>,
    name: Option<String>,
    gridsquare: Option<String>,
    comment: Option<String>,
) -> QsoLogEntry {
    let now = chrono::Utc::now().to_rfc3339();
    let conn = db.0.lock().expect("db mutex poisoned");
    let id = match id {
        Some(existing_id) => {
            conn.execute(
                "UPDATE qso_log SET call = ?1, qso_date = ?2, time_on = ?3, band = ?4, freq_mhz = ?5, mode = ?6,
                    rst_sent = ?7, rst_rcvd = ?8, name = ?9, gridsquare = ?10, comment = ?11, updated_at = ?12
                 WHERE id = ?13",
                params![call, qso_date, time_on, band, freq_mhz, mode, rst_sent, rst_rcvd, name, gridsquare, comment, now, existing_id],
            )
            .expect("failed to update qso_log entry");
            existing_id
        }
        None => {
            conn.execute(
                "INSERT INTO qso_log (call, qso_date, time_on, band, freq_mhz, mode, rst_sent, rst_rcvd, name, gridsquare, comment, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![call, qso_date, time_on, band, freq_mhz, mode, rst_sent, rst_rcvd, name, gridsquare, comment, now],
            )
            .expect("failed to insert qso_log entry");
            conn.last_insert_rowid()
        }
    };
    QsoLogEntry { id, call, qso_date, time_on, band, freq_mhz, mode, rst_sent, rst_rcvd, name, gridsquare, comment, updated_at: now }
}

#[tauri::command]
pub fn delete_qso_log_entry(db: State<Db>, id: i64) {
    let conn = db.0.lock().expect("db mutex poisoned");
    conn.execute("DELETE FROM qso_log WHERE id = ?1", params![id])
        .expect("failed to delete qso_log entry");
}

fn adif_field(name: &str, value: &str) -> String {
    if value.is_empty() {
        String::new()
    } else {
        format!("<{name}:{}>{value}", value.len())
    }
}

#[tauri::command]
pub fn export_qso_log_adif(db: State<Db>) -> String {
    let entries = get_qso_log(db);
    let mut out = String::new();
    out.push_str("Exported from Waystation\n<PROGRAMID:10>Waystation<ADIF_VER:5>3.1.4<EOH>\n\n");
    for e in &entries {
        out.push_str(&adif_field("CALL", &e.call));
        out.push_str(&adif_field("QSO_DATE", &e.qso_date));
        out.push_str(&adif_field("TIME_ON", &e.time_on));
        if let Some(band) = &e.band {
            out.push_str(&adif_field("BAND", band));
        }
        if let Some(freq) = e.freq_mhz {
            out.push_str(&adif_field("FREQ", &format!("{freq}")));
        }
        out.push_str(&adif_field("MODE", &e.mode));
        if let Some(rst) = &e.rst_sent {
            out.push_str(&adif_field("RST_SENT", rst));
        }
        if let Some(rst) = &e.rst_rcvd {
            out.push_str(&adif_field("RST_RCVD", rst));
        }
        if let Some(name) = &e.name {
            out.push_str(&adif_field("NAME", name));
        }
        if let Some(grid) = &e.gridsquare {
            out.push_str(&adif_field("GRIDSQUARE", grid));
        }
        if let Some(comment) = &e.comment {
            out.push_str(&adif_field("COMMENT", comment));
        }
        out.push_str("<EOR>\n");
    }
    out
}

#[derive(Debug, Clone, Serialize)]
pub struct WebSdrStation {
    pub id: i64,
    pub label: String,
    pub url: String,
    pub location: Option<String>,
    pub notes: Option<String>,
    pub updated_at: String,
}

#[tauri::command]
pub fn get_websdr_stations(db: State<Db>) -> Vec<WebSdrStation> {
    let conn = db.0.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare("SELECT id, label, url, location, notes, updated_at FROM websdr_stations ORDER BY label ASC")
        .expect("failed to prepare websdr_stations query");
    stmt.query_map([], |row| {
        Ok(WebSdrStation {
            id: row.get(0)?,
            label: row.get(1)?,
            url: row.get(2)?,
            location: row.get(3)?,
            notes: row.get(4)?,
            updated_at: row.get(5)?,
        })
    })
    .expect("failed to query websdr_stations")
    .filter_map(Result::ok)
    .collect()
}

#[tauri::command]
pub fn upsert_websdr_station(
    db: State<Db>,
    id: Option<i64>,
    label: String,
    url: String,
    location: Option<String>,
    notes: Option<String>,
) -> WebSdrStation {
    let now = chrono::Utc::now().to_rfc3339();
    let conn = db.0.lock().expect("db mutex poisoned");
    let id = match id {
        Some(existing_id) => {
            conn.execute(
                "UPDATE websdr_stations SET label = ?1, url = ?2, location = ?3, notes = ?4, updated_at = ?5 WHERE id = ?6",
                params![label, url, location, notes, now, existing_id],
            )
            .expect("failed to update websdr_station");
            existing_id
        }
        None => {
            conn.execute(
                "INSERT INTO websdr_stations (label, url, location, notes, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![label, url, location, notes, now],
            )
            .expect("failed to insert websdr_station");
            conn.last_insert_rowid()
        }
    };
    WebSdrStation { id, label, url, location, notes, updated_at: now }
}

#[tauri::command]
pub fn delete_websdr_station(db: State<Db>, id: i64) {
    let conn = db.0.lock().expect("db mutex poisoned");
    conn.execute("DELETE FROM websdr_stations WHERE id = ?1", params![id])
        .expect("failed to delete websdr_station");
}

#[derive(Debug, Clone, Serialize)]
pub struct MeshNode {
    pub node_num: i64,
    pub user_id: Option<String>,
    pub long_name: Option<String>,
    pub short_name: Option<String>,
    pub hw_model: Option<String>,
    pub snr: Option<f64>,
    pub last_heard: Option<i64>,
    pub battery_pct: Option<i64>,
    pub is_favorite: bool,
    pub updated_at: String,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub position_updated_at: Option<i64>,
}

#[tauri::command]
pub fn get_mesh_nodes(db: State<Db>) -> Vec<MeshNode> {
    let conn = db.0.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare(
            "SELECT node_num, user_id, long_name, short_name, hw_model, snr, last_heard, battery_pct, is_favorite, updated_at,
                    latitude, longitude, position_updated_at
             FROM mesh_nodes ORDER BY last_heard DESC",
        )
        .expect("failed to prepare mesh_nodes query");
    stmt.query_map([], |row| {
        Ok(MeshNode {
            node_num: row.get(0)?,
            user_id: row.get(1)?,
            long_name: row.get(2)?,
            short_name: row.get(3)?,
            hw_model: row.get(4)?,
            snr: row.get(5)?,
            last_heard: row.get(6)?,
            battery_pct: row.get(7)?,
            is_favorite: row.get::<_, i64>(8)? != 0,
            updated_at: row.get(9)?,
            latitude: row.get(10)?,
            longitude: row.get(11)?,
            position_updated_at: row.get(12)?,
        })
    })
    .expect("failed to query mesh_nodes")
    .filter_map(Result::ok)
    .collect()
}

/// Updates only a node's position, independent of `upsert_mesh_node`'s
/// full NodeInfo replace -- a Position packet doesn't carry name/SNR/
/// battery, and running it through the full upsert would null those back
/// out. Inserts a bare row if the node's never been seen via NodeInfo
/// (a position packet arriving first is legal, if unusual).
pub fn update_mesh_node_position(conn: &Connection, node_num: i64, latitude: f64, longitude: f64, position_time: i64) {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO mesh_nodes (node_num, is_favorite, updated_at, latitude, longitude, position_updated_at)
         VALUES (?1, 0, ?2, ?3, ?4, ?5)
         ON CONFLICT(node_num) DO UPDATE SET
            latitude = excluded.latitude, longitude = excluded.longitude, position_updated_at = excluded.position_updated_at",
        params![node_num, now, latitude, longitude, position_time],
    )
    .expect("failed to update mesh_node position");
}

/// Replace-on-fetch per node — the mesh periodically re-announces
/// NodeInfo for every node it knows about, this just keeps the latest.
#[allow(clippy::too_many_arguments)]
pub fn upsert_mesh_node(
    conn: &Connection,
    node_num: i64,
    user_id: Option<&str>,
    long_name: Option<&str>,
    short_name: Option<&str>,
    hw_model: Option<&str>,
    snr: Option<f64>,
    last_heard: Option<i64>,
    battery_pct: Option<i64>,
    is_favorite: bool,
) {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO mesh_nodes (node_num, user_id, long_name, short_name, hw_model, snr, last_heard, battery_pct, is_favorite, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(node_num) DO UPDATE SET
            user_id = excluded.user_id, long_name = excluded.long_name, short_name = excluded.short_name,
            hw_model = excluded.hw_model, snr = excluded.snr, last_heard = excluded.last_heard,
            battery_pct = excluded.battery_pct, is_favorite = excluded.is_favorite, updated_at = excluded.updated_at",
        params![node_num, user_id, long_name, short_name, hw_model, snr, last_heard, battery_pct, is_favorite as i64, now],
    )
    .expect("failed to upsert mesh_node");
}

#[derive(Debug, Clone, Serialize)]
pub struct MeshMessage {
    pub id: i64,
    pub from_node: i64,
    pub to_node: i64,
    pub channel: i64,
    pub text: String,
    pub rx_time: i64,
    pub received_at: String,
    pub outbound: bool,
    /// "sent" (default, no response yet), "delivered" (routing response
    /// with no error), or "failed" (routing response with a real error —
    /// see fail_reason). Only ever changes for outbound messages; inbound
    /// messages stay "sent" and the frontend just doesn't show status for
    /// those.
    pub status: String,
    pub fail_reason: Option<String>,
}

#[tauri::command]
pub fn get_mesh_messages(db: State<Db>) -> Vec<MeshMessage> {
    let conn = db.0.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare(
            "SELECT id, from_node, to_node, channel, text, rx_time, received_at, outbound, status, fail_reason
             FROM mesh_messages ORDER BY id ASC",
        )
        .expect("failed to prepare mesh_messages query");
    stmt.query_map([], |row| {
        Ok(MeshMessage {
            id: row.get(0)?,
            from_node: row.get(1)?,
            to_node: row.get(2)?,
            channel: row.get(3)?,
            text: row.get(4)?,
            rx_time: row.get(5)?,
            received_at: row.get(6)?,
            outbound: row.get::<_, i64>(7)? != 0,
            status: row.get(8)?,
            fail_reason: row.get(9)?,
        })
    })
    .expect("failed to query mesh_messages")
    .filter_map(Result::ok)
    .collect()
}

#[tauri::command]
pub fn clear_mesh_messages(db: State<Db>) -> Result<(), String> {
    let conn = db.0.lock().expect("db mutex poisoned");
    conn.execute("DELETE FROM mesh_messages", [])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_mesh_message(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().expect("db mutex poisoned");
    conn.execute("DELETE FROM mesh_messages WHERE id = ?1", params![id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// `packet_id` is the outbound MeshPacket's own id (None for inbound
/// messages we didn't send) — how a later routing-error response gets
/// matched back to this row.
#[allow(clippy::too_many_arguments)]
pub fn insert_mesh_message(
    conn: &Connection,
    from_node: i64,
    to_node: i64,
    channel: i64,
    text: &str,
    rx_time: i64,
    outbound: bool,
    packet_id: Option<i64>,
) {
    let received_at = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO mesh_messages (from_node, to_node, channel, text, rx_time, received_at, outbound, packet_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![from_node, to_node, channel, text, rx_time, received_at, outbound as i64, packet_id],
    )
    .expect("failed to insert mesh_message");
}

/// Updates the outbound message matching `packet_id`, if any, when a
/// routing response arrives referencing it.
pub fn set_mesh_message_status(conn: &Connection, packet_id: i64, status: &str, fail_reason: Option<&str>) {
    conn.execute(
        "UPDATE mesh_messages SET status = ?1, fail_reason = ?2 WHERE packet_id = ?3",
        params![status, fail_reason, packet_id],
    )
    .expect("failed to update mesh_message status");
}

const MIGRATIONS: &[&str] = &[
    // v1: station identity + per-source connectivity health
    r#"
    CREATE TABLE station_profile (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        callsign      TEXT,
        grid_square   TEXT,
        operator_name TEXT,
        updated_at    TEXT NOT NULL
    );

    CREATE TABLE source_health (
        source_id       TEXT PRIMARY KEY,
        label           TEXT NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('healthy','degraded','down','unknown')),
        via             TEXT NOT NULL CHECK (via IN ('internet','mesh','rf','manual')),
        last_success_at TEXT,
        last_attempt_at TEXT,
        detail          TEXT
    );
    "#,
    // v2: NWS active alerts (Phase 1 EmComm core)
    r#"
    CREATE TABLE alerts (
        id          TEXT PRIMARY KEY,
        source      TEXT NOT NULL,
        fetched_at  TEXT NOT NULL,
        via         TEXT NOT NULL CHECK (via IN ('internet','mesh','rf','manual')),
        event       TEXT NOT NULL,
        severity    TEXT NOT NULL,
        headline    TEXT,
        description TEXT,
        area_desc   TEXT,
        effective   TEXT,
        expires     TEXT,
        raw_json    TEXT NOT NULL
    );
    "#,
    // v3: net control roster + ICS-213/309 message log (Phase 1 EmComm core).
    // Both are operator-entered, not ingested — no provenance columns, same
    // exemption as station_profile.
    r#"
    CREATE TABLE net_roster (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        callsign      TEXT NOT NULL,
        name          TEXT,
        status        TEXT NOT NULL CHECK (status IN ('checked_in','checked_out')),
        checked_in_at TEXT NOT NULL,
        last_heard_at TEXT,
        traffic_count INTEGER NOT NULL DEFAULT 0,
        notes         TEXT
    );

    CREATE TABLE messages (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        precedence   TEXT NOT NULL CHECK (precedence IN ('routine','priority','immediate','emergency')),
        date_time    TEXT NOT NULL,
        to_station   TEXT,
        to_name      TEXT,
        from_station TEXT,
        from_name    TEXT,
        subject      TEXT,
        message_text TEXT NOT NULL
    );
    "#,
    // v4: resource tracking (extends OpenHamClock's bracket-token concept:
    // "[Beds 30/100][Power OK][Water -50]"). Operator-entered, no provenance
    // columns needed. Manual entry for now — parsing an APRS beacon comment
    // into this table is Phase 3 material once a transport exists.
    r#"
    CREATE TABLE resources (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        label      TEXT NOT NULL,
        raw_tokens TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    "#,
    // v5: space weather (Phase 4, built ahead of schedule — needs no
    // hardware, same reasoning as NWS alerts in Phase 1). Singleton row,
    // always the latest reading; historical trending is a later addition.
    r#"
    CREATE TABLE space_weather (
        id             INTEGER PRIMARY KEY CHECK (id = 1),
        source         TEXT NOT NULL,
        fetched_at     TEXT NOT NULL,
        via            TEXT NOT NULL CHECK (via IN ('internet','mesh','rf','manual')),
        updated_label  TEXT,
        solar_flux     INTEGER,
        a_index        INTEGER,
        k_index        INTEGER,
        sunspots       INTEGER,
        xray           TEXT,
        proton_flux    INTEGER,
        electron_flux  INTEGER,
        aurora         INTEGER,
        solar_wind     REAL,
        magnetic_field REAL,
        geomag_field   TEXT,
        signal_noise   TEXT
    );
    "#,
    // v6: personal channel/frequency directory. Operator-entered, no
    // provenance columns needed — same exemption as station_profile.
    r#"
    CREATE TABLE channels (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        label       TEXT NOT NULL,
        frequency   TEXT NOT NULL,
        tone_offset TEXT,
        notes       TEXT,
        updated_at  TEXT NOT NULL
    );
    "#,
    // v7: RepeaterBook API token. This is an app-level API key the operator
    // generates specifically for WayStation (repeaterbook.com/api/
    // token_request.php), not a personal login password — appropriate for
    // WayStation to store and use directly, unlike the Winlink account
    // password (see pat.rs), which stays out of WayStation entirely.
    r#"
    ALTER TABLE station_profile ADD COLUMN repeaterbook_token TEXT;
    "#,
    // v8: WebSDR directory. Operator-curated bookmarks, not an aggregated
    // feed — websdr.org's list is explicitly gated ("this data may not be
    // re-used in another website or automated system without prior
    // permission"), so this stays a personal/shareable list the operator
    // builds by hand, same exemption as channels.
    r#"
    CREATE TABLE websdr_stations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        label      TEXT NOT NULL,
        url        TEXT NOT NULL,
        location   TEXT,
        notes      TEXT,
        updated_at TEXT NOT NULL
    );
    "#,
    // v9: contest calendar, ingested from WA7BNM's ICS feed. Their terms of
    // use forbid automated/bot access in general but explicitly carve out
    // "an ICS feed... to load a calendar of contests into a calendar
    // software application for personal use" — WayStation fits that
    // description directly, unlike the WebSDR/RepeaterBook situations
    // where no such carve-out exists. Same provenance columns as alerts.
    r#"
    CREATE TABLE contests (
        id         TEXT PRIMARY KEY,
        source     TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        via        TEXT NOT NULL CHECK (via IN ('internet','mesh','rf','manual')),
        label      TEXT NOT NULL,
        starts_at  TEXT NOT NULL,
        ends_at    TEXT,
        detail_url TEXT
    );
    "#,
    // v10: band-condition table (already in the N0NBH feed, just wasn't
    // parsed) and NOAA R/S/G space-weather scales, from SWPC's own JSON
    // API (services.swpc.noaa.gov) — a different, official US government
    // source, not the N0NBH feed, since the R/S/G scales aren't actually
    // present there despite an earlier roadmap note assuming they were.
    r#"
    ALTER TABLE space_weather ADD COLUMN band_conditions TEXT;
    ALTER TABLE space_weather ADD COLUMN r_scale INTEGER;
    ALTER TABLE space_weather ADD COLUMN r_text TEXT;
    ALTER TABLE space_weather ADD COLUMN s_scale INTEGER;
    ALTER TABLE space_weather ADD COLUMN s_text TEXT;
    ALTER TABLE space_weather ADD COLUMN g_scale INTEGER;
    ALTER TABLE space_weather ADD COLUMN g_text TEXT;
    "#,
    // v11: PSKReporter reception reports — "who's hearing my station."
    // Built against pskreporter.info's own ADIF "Download" link
    // (cgi-bin/pskdata.pl), the same endpoint their map UI links to for
    // end users, rather than reverse-engineering their internal JSONP
    // query API. RBN and WSPRnet stay unbuilt — RBN's protocol still
    // needs verifying, WSPRnet wasn't reached this session.
    r#"
    CREATE TABLE psk_spots (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        source        TEXT NOT NULL,
        fetched_at    TEXT NOT NULL,
        via           TEXT NOT NULL CHECK (via IN ('internet','mesh','rf','manual')),
        my_callsign   TEXT NOT NULL,
        heard_by_call TEXT NOT NULL,
        heard_by_grid TEXT,
        freq_mhz      REAL,
        mode          TEXT,
        snr           INTEGER,
        distance_km   REAL,
        bearing_deg   INTEGER,
        heard_at      TEXT NOT NULL
    );
    "#,
    // v12: POTA activator spots. api.pota.app is a dedicated public JSON
    // API with no ToS block encountered — unlike SOTA, whose terms
    // explicitly forbid AI-written clients ("no AI or 'vibe-coding'...
    // no AI-generated software may connect to the SOTA API without prior
    // approval"), so SOTA is not built here at all, not just deferred.
    // WWFF's public interface (spots.wwff.co) turned out to be a
    // server-rendered HTML page with no JSON API, not the machine
    // endpoint PLANNING.md's note assumed — also not built.
    r#"
    CREATE TABLE pota_spots (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        source         TEXT NOT NULL,
        fetched_at     TEXT NOT NULL,
        via            TEXT NOT NULL CHECK (via IN ('internet','mesh','rf','manual')),
        spot_id        INTEGER NOT NULL,
        activator      TEXT NOT NULL,
        frequency_mhz  REAL,
        mode           TEXT,
        reference      TEXT NOT NULL,
        park_name      TEXT,
        location_desc  TEXT,
        grid           TEXT,
        latitude       REAL,
        longitude      REAL,
        spot_time      TEXT NOT NULL,
        comments       TEXT
    );
    "#,
    // v13: DX cluster spots. First persistent-connection ingest (telnet,
    // not HTTP poll) — verified live against dxc.nc7j.com:7373 (real
    // AR-Cluster v6 server) before writing anything: plain-text login
    // with a callsign, then a streaming feed of "DX de <spotter>:
    // <freq> <dxcall> <comment> <HHMM>Z" lines. Insert-only (a live
    // stream, not a fetch-and-replace snapshot); old rows get pruned
    // rather than accumulating forever.
    r#"
    CREATE TABLE dx_spots (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        source     TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        via        TEXT NOT NULL CHECK (via IN ('internet','mesh','rf','manual')),
        spotter    TEXT NOT NULL,
        dx_call    TEXT NOT NULL,
        freq_mhz   REAL NOT NULL,
        comment    TEXT,
        spot_time  TEXT NOT NULL
    );
    "#,
    // v14: amateur satellite TLEs (Two-Line Elements — the standard orbit
    // description format), from CelesTrak's public GP data feed. Pass
    // predictions themselves aren't stored — computed on demand from the
    // cached TLE via the `sgp4` crate (a real, widely-used implementation;
    // orbital propagation has too many well-known correctness pitfalls to
    // hand-roll, same "orchestrate, don't reimplement" reasoning this
    // project already applies to Pat/JS8Call/Hamlib). Replace-on-fetch,
    // same pattern as alerts/contests. CelesTrak's own guidance: don't
    // poll more than once every 2 hours — this polls every 6.
    r#"
    CREATE TABLE satellite_tles (
        norad_id   INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        source     TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        via        TEXT NOT NULL CHECK (via IN ('internet','mesh','rf','manual')),
        line1      TEXT NOT NULL,
        line2      TEXT NOT NULL
    );
    "#,
    // v15: QSO log. Operator-entered, no provenance columns needed, same
    // exemption as channels/resources. First basic version — dupe
    // checking and cached callsign databases (both named in this
    // project's own roadmap) are real follow-ups, not done here.
    r#"
    CREATE TABLE qso_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        call       TEXT NOT NULL,
        qso_date   TEXT NOT NULL,
        time_on    TEXT NOT NULL,
        band       TEXT,
        freq_mhz   REAL,
        mode       TEXT NOT NULL,
        rst_sent   TEXT,
        rst_rcvd   TEXT,
        name       TEXT,
        gridsquare TEXT,
        comment    TEXT,
        updated_at TEXT NOT NULL
    );
    "#,
    // v16: Meshtastic node database + text messages. First real Phase 2
    // (mesh) work — verified against a real running meshtasticd instance
    // (the official native/Portduino build) over its TCP protobuf API
    // before writing anything, same discipline as every other transport.
    // Nodes are replace-on-fetch per node_num (the mesh periodically
    // re-announces NodeInfo, this just tracks the latest); messages are
    // insert-only, since they're a real conversation history, not a
    // snapshot.
    r#"
    CREATE TABLE mesh_nodes (
        node_num    INTEGER PRIMARY KEY,
        user_id     TEXT,
        long_name   TEXT,
        short_name  TEXT,
        hw_model    TEXT,
        snr         REAL,
        last_heard  INTEGER,
        battery_pct INTEGER,
        is_favorite INTEGER NOT NULL DEFAULT 0,
        updated_at  TEXT NOT NULL
    );

    CREATE TABLE mesh_messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        from_node   INTEGER NOT NULL,
        to_node     INTEGER NOT NULL,
        channel     INTEGER NOT NULL,
        text        TEXT NOT NULL,
        rx_time     INTEGER NOT NULL,
        received_at TEXT NOT NULL,
        outbound    INTEGER NOT NULL DEFAULT 0
    );
    "#,
    // v17: real delivery status for outbound mesh messages. Verified this
    // was a real gap live: a test send to a disabled channel was silently
    // shown as "sent" even though meshtasticd's own log showed it NAK'd
    // the packet (routing::Error::NoChannel). Meshtastic reports delivery
    // failure as a separate MeshPacket (PortNum::RoutingApp, a decoded
    // Routing message) referencing the original packet's id via
    // Data.request_id — packet_id is stored per outbound message so that
    // response can be matched back to the right row.
    r#"
    ALTER TABLE mesh_messages ADD COLUMN packet_id INTEGER;
    ALTER TABLE mesh_messages ADD COLUMN status TEXT NOT NULL DEFAULT 'sent';
    ALTER TABLE mesh_messages ADD COLUMN fail_reason TEXT;
    "#,
    // v18: configurable Meshtastic host. v16/v17 hardcoded 127.0.0.1:4403,
    // which only ever reaches a node (or meshtasticd) on this machine —
    // real hardware usually sits elsewhere on the LAN. NULL keeps the
    // local default, so existing installs don't change behavior.
    r#"
    ALTER TABLE station_profile ADD COLUMN mesh_host TEXT;
    "#,
    // v19: rigctld address for Hamlib rig control. Same shape as
    // mesh_host -- NULL means the local default (127.0.0.1:4532).
    // Waystation connects to an existing rigctld rather than starting
    // one, because a radio's serial port is exclusive and many operators
    // already run rigctld or FLRig to share one rig between WSJT-X,
    // JS8Call and a logger.
    r#"
    ALTER TABLE station_profile ADD COLUMN rigctld_host TEXT;
    "#,
    // v20: manual offline switch. Lets the operator take Waystation off
    // the internet without taking the whole machine off it -- useful in
    // the field (battery, metered or satellite links) and, just as
    // importantly, the only practical way to exercise this app's central
    // claim that it degrades honestly when the internet goes away.
    r#"
    ALTER TABLE station_profile ADD COLUMN manual_offline INTEGER NOT NULL DEFAULT 0;
    "#,
    // v21: rig control on/off. Defaults to on so existing setups keep
    // working. Turning it off stops Waystation connecting to rigctld at
    // all -- it does NOT stop rigctld itself listening, which only the
    // operator's own rigctld flags or firewall can do.
    r#"
    ALTER TABLE station_profile ADD COLUMN rig_enabled INTEGER NOT NULL DEFAULT 1;
    "#,
    // v22: rotctld address + enable switch for Hamlib rotator control.
    // Same shape as rigctld_host/rig_enabled -- verified against a real
    // rotctld (Hamlib's Dummy rotator, model 1) before writing any code,
    // same discipline as rig control.
    r#"
    ALTER TABLE station_profile ADD COLUMN rotctld_host TEXT;
    ALTER TABLE station_profile ADD COLUMN rotator_enabled INTEGER NOT NULL DEFAULT 1;
    "#,
    // v23: incoming mesh position storage. Closes the gap flagged when
    // send/request-position landed -- PortNum::PositionApp packets were
    // decoded nowhere, so a reply to a position request (or a GPS-equipped
    // node's own periodic broadcast) had nothing to update. Separate
    // columns rather than reusing mesh_messages: a position is a current
    // fact about a node, not a chat line in its history.
    r#"
    ALTER TABLE mesh_nodes ADD COLUMN latitude REAL;
    ALTER TABLE mesh_nodes ADD COLUMN longitude REAL;
    ALTER TABLE mesh_nodes ADD COLUMN position_updated_at INTEGER;
    "#,
    // v24: incident/net info -- a singleton, operator-entered card for the
    // EmComm tab (incident name, operational period, active net frequency
    // and status). Same shape as station_profile: id=1 singleton, no
    // provenance columns, since this is typed in by the operator, not
    // ingested. Free-text fields throughout -- real ICS-201/213 forms are
    // filled in as text ("1400Z-1800Z Aug 29"), not structured data, and
    // there's no safe way to validate/interpret an operational period or a
    // net frequency without real domain rules this app doesn't have.
    r#"
    CREATE TABLE incident_info (
        id                  INTEGER PRIMARY KEY CHECK (id = 1),
        incident_name       TEXT,
        operational_period  TEXT,
        net_frequency       TEXT,
        net_status          TEXT,
        updated_at          TEXT NOT NULL
    );
    "#,
    // v25: message dispatcher. ICS-213 messages previously only ever got
    // logged locally -- this is the schema half of actually sending them.
    // dispatch_status starts 'queued' (no route found/tried yet) and
    // flips to 'dispatched' once some transport actually accepted it;
    // dispatched_via records which one. content_hash is computed at
    // insert time and stored now even though nothing dedupes against it
    // yet -- cheap to add today, and it means a future ingestion path
    // (an incoming message getting logged back into this table) won't
    // need its own migration+backfill just to gain a hash to compare.
    r#"
    ALTER TABLE messages ADD COLUMN content_hash TEXT;
    ALTER TABLE messages ADD COLUMN dispatch_status TEXT NOT NULL DEFAULT 'queued';
    ALTER TABLE messages ADD COLUMN dispatched_via TEXT;
    "#,
    // v26: locations for the EmComm situational map -- first real step
    // toward the shared/synced map, scoped 2026-08-29. Grid square is the
    // stored source of truth (same as station_profile), not raw lat/lon --
    // it's what an operator actually types in, matches the app's location
    // convention everywhere else, and lat/lon is cheap to derive on every
    // read via the existing maidenhead decoder rather than persisting a
    // second copy that could drift if the grid square is later edited.
    r#"
    ALTER TABLE net_roster ADD COLUMN grid_square TEXT;
    ALTER TABLE resources ADD COLUMN grid_square TEXT;
    "#,
    // v27: Tactical Mode / Hobbyist Mode. Decided 2026-08-29 from a
    // hybrid-architecture review -- hobbyist-facing panels (contest
    // calendar, DX cluster) are real estate nobody in Frank's family group
    // or Citadel deployment would use, applying "build for us first"
    // directly. Landed as a visibility toggle rather than deleting working
    // code: panels stay built and carry their own `hobbyist` flag
    // (panels/types.ts), this just says which mode the operator is in.
    // Defaults ON (tactical-first out of the box) -- same reasoning as
    // rig_enabled/rotator_enabled defaulting on: the family's fresh
    // installs should get the intended experience without a first-visit
    // trip to Settings.
    r#"
    ALTER TABLE station_profile ADD COLUMN tactical_mode INTEGER NOT NULL DEFAULT 1;
    "#,
    // v28: Citadel map tile server host. Decided 2026-08-31 -- the
    // Tactical Map's real primary path is Citadel's own already-running
    // nginx serving `comms_base.pmtiles`/`tactical_terrain.pmtiles` over
    // plain HTTP range requests (confirmed reachable at
    // `citadel/nginx.conf`'s default `location /` block, port 8085 by
    // default), not the OpenFreeMap online fallback that shipped first.
    // Same `host`/`host:port` shape as mesh_host/rigctld_host; NULL means
    // the local default (127.0.0.1:8085).
    r#"
    ALTER TABLE station_profile ADD COLUMN citadel_map_host TEXT;
    "#,
    // v29: map markers (pin sync). Generalizes the mesh-only
    // send_mesh_position pattern into a shared situational marker that
    // travels over the same dispatcher used for ICS-213 messages
    // (mesh/Winlink/JS8Call) so another station's WayStation can plot it
    // too -- not a new protocol, per the design note this follows.
    // content_hash is UNIQUE so the same pin arriving twice (relayed over
    // two paths, or echoed back by a mesh hop rebroadcasting it) dedupes
    // via ON CONFLICT DO NOTHING instead of creating a second pin.
    r#"
    CREATE TABLE map_markers (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        label           TEXT NOT NULL,
        marker_type     TEXT NOT NULL DEFAULT 'info',
        latitude        REAL NOT NULL,
        longitude       REAL NOT NULL,
        origin_station  TEXT,
        to_station      TEXT,
        created_at      TEXT NOT NULL,
        content_hash    TEXT NOT NULL UNIQUE,
        dispatch_status TEXT NOT NULL DEFAULT 'queued',
        dispatched_via  TEXT,
        received_via    TEXT
    );
    "#,
    // v30: canonical operational-object header, decided 2026-09-01 -- the
    // shared shape every object type (starting with messages and map
    // markers, per the roadmap's own ordering) needs before cross-station
    // sync or routing can exist. `id` stays the fast local primary key;
    // `uuid` is the stable identity that has to survive across different
    // stations' databases -- two different homes' WayStation instances
    // will each have a local `id = 47` the moment more than one exists,
    // so autoincrement can never be the identity that leaves this
    // machine. Nullable at the schema level only because SQLite can't
    // backfill a per-row-unique value in a single ALTER TABLE statement;
    // every existing row gets a real UUID immediately after this
    // migration runs (see `backfill_object_uuids`), and every future
    // insert provides one at create time -- by the time the app finishes
    // opening the database, this column is never actually null in
    // practice. `revision`/`updated_at` support the "explicit conflict
    // and revision rules before peer synchronization" the roadmap calls
    // for. `incident_id` is nullable because most day-to-day traffic
    // isn't part of a declared incident. `trust_state` defaults 'local'
    // for anything created on this station; `insert_received_marker`
    // (the one real inbound-object path that exists today) sets it to
    // 'received' explicitly -- same honesty principle as everywhere else
    // in this app: data that arrived from somewhere else must never look
    // indistinguishable from data this station actually originated.
    r#"
    ALTER TABLE messages ADD COLUMN uuid TEXT;
    ALTER TABLE messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE messages ADD COLUMN updated_at TEXT;
    ALTER TABLE messages ADD COLUMN incident_id TEXT;
    ALTER TABLE messages ADD COLUMN expires_at TEXT;
    ALTER TABLE messages ADD COLUMN trust_state TEXT NOT NULL DEFAULT 'local';

    ALTER TABLE map_markers ADD COLUMN uuid TEXT;
    ALTER TABLE map_markers ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE map_markers ADD COLUMN updated_at TEXT;
    ALTER TABLE map_markers ADD COLUMN incident_id TEXT;
    ALTER TABLE map_markers ADD COLUMN expires_at TEXT;
    ALTER TABLE map_markers ADD COLUMN trust_state TEXT NOT NULL DEFAULT 'local';
    "#,
];

pub fn data_dir() -> PathBuf {
    let dir = dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("waystation");
    std::fs::create_dir_all(&dir).expect("failed to create app data directory");
    dir
}

pub fn open() -> Connection {
    let path = data_dir().join("waystation.db");
    let mut conn = Connection::open(path).expect("failed to open database");
    migrate(&mut conn);
    backfill_object_uuids(&conn);
    conn
}

/// Runs after every `migrate()` call, not just once after v30 -- cheap
/// (a no-op `UPDATE ... WHERE uuid IS NULL` on every launch once real
/// rows exist) and it means a database restored from a backup taken
/// between v30 landing and this function existing, or any other path
/// that leaves a row with a null uuid, self-heals on next launch rather
/// than staying broken. `Uuid::new_v4()` per row, not a single shared
/// value -- the whole point is a globally unique identity per object.
fn backfill_object_uuids(conn: &Connection) {
    for table in ["messages", "map_markers"] {
        let ids: Vec<i64> = conn
            .prepare(&format!("SELECT id FROM {table} WHERE uuid IS NULL"))
            .and_then(|mut stmt| stmt.query_map([], |row| row.get(0))?.collect())
            .unwrap_or_else(|e| panic!("failed to find rows needing a uuid backfill in {table}: {e}"));
        for id in ids {
            conn.execute(
                &format!("UPDATE {table} SET uuid = ?1 WHERE id = ?2"),
                params![uuid::Uuid::new_v4().to_string(), id],
            )
            .unwrap_or_else(|e| panic!("failed to backfill uuid for {table} id {id}: {e}"));
        }
    }
}

/// Each migration applies atomically -- all its statements commit
/// together, or none do, and `user_version` only advances on success.
///
/// Found necessary the hard way, not in theory: a real machine hit exact
/// memory pressure mid-launch (2026-08-30) and the process was killed
/// partway through migration v25's `execute_batch`. `execute_batch` has
/// no implicit transaction, and SQLite auto-commits each DDL statement as
/// it runs -- so the interrupted process left a real database with
/// `content_hash` added, `dispatch_status`/`dispatched_via` missing, and
/// `user_version` still at 24, since the crash landed between the first
/// `ALTER TABLE` and the version bump. Every future launch then re-ran
/// v25 from the top and panicked on "duplicate column name: content_hash"
/// -- a real, permanently-stuck install, not a one-time hiccup. Wrapping
/// each migration in its own transaction makes that interruption point
/// impossible: a kill mid-migration now leaves `user_version` unchanged
/// and the schema untouched, so the next launch just retries cleanly.
fn migrate(conn: &mut Connection) {
    apply_migrations(conn, MIGRATIONS);
}

/// Takes an explicit migration list (rather than reading the `MIGRATIONS`
/// const directly) so the atomicity property below can be tested against
/// a deliberately-broken migration without touching production schema
/// history.
fn apply_migrations(conn: &mut Connection, migrations: &[&str]) {
    let current: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("failed to read schema version");

    for (i, migration) in migrations.iter().enumerate() {
        let version = (i + 1) as i64;
        if version <= current {
            continue;
        }
        let tx = conn
            .transaction()
            .unwrap_or_else(|e| panic!("failed to start transaction for migration v{version}: {e}"));
        tx.execute_batch(migration)
            .unwrap_or_else(|e| panic!("migration v{version} failed: {e}"));
        tx.pragma_update(None, "user_version", version)
            .expect("failed to bump schema version");
        tx.commit()
            .unwrap_or_else(|e| panic!("failed to commit migration v{version}: {e}"));
    }
}

#[cfg(test)]
mod tests {
    //! Real risk this protects against: 27 migrations now, applied in
    //! sequence, each in its own transaction (see `apply_migrations`).
    //! That wrapping isn't precautionary -- a real machine hit real memory
    //! pressure mid-launch on 2026-08-30 and the process was killed
    //! partway through migration v25's `execute_batch`, which at the time
    //! had no implicit transaction; the result was a real, permanently-
    //! stuck install (schema half-applied, `user_version` stale, every
    //! later launch panicking on "duplicate column name") that had to be
    //! repaired by hand. `migrate()` already took a plain `&Connection`
    //! with no Tauri dependency, so this needed no new test infrastructure
    //! to write -- and for Frank's family, this is now several real
    //! households' worth of installs, not one.

    use super::*;

    fn fresh_db() -> Connection {
        let mut conn = Connection::open_in_memory().expect("failed to open in-memory db");
        migrate(&mut conn);
        conn
    }

    #[test]
    fn full_migration_chain_applies_cleanly_from_nothing() {
        // The core promise: a brand-new install runs every migration in
        // order with no error. This alone would have caught any SQL
        // mistake in any of the migrations directly.
        let conn = fresh_db();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
    }

    #[test]
    fn migrations_are_idempotent() {
        // open() calls migrate() on every launch, not just the first --
        // re-running against an already-current database must be a silent
        // no-op, not an attempt to re-create a table that already exists.
        let mut conn = fresh_db();
        migrate(&mut conn); // must not panic
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
    }

    #[test]
    fn a_migration_that_fails_partway_through_leaves_no_trace() {
        // Real bug, caught live 2026-08-30: a process was killed by actual
        // system memory pressure mid-migration. `execute_batch` has no
        // implicit transaction, and SQLite auto-commits each DDL statement
        // as it runs, so the interrupted process left a real database with
        // the first statement of v25 applied (`content_hash` added) but
        // not the rest, and `user_version` never bumped -- every later
        // launch then re-ran v25 from its first statement and panicked on
        // "duplicate column name". This reproduces that exact shape
        // directly: a migration whose second statement is invalid. Before
        // the transaction wrapping, this would have left `first_column`
        // sitting in the table with `user_version` unchanged -- the same
        // half-applied trap. With it, the panic must unwind through the
        // transaction guard's `Drop` and roll back, so NEITHER statement
        // takes effect and a retry starts clean.
        let mut conn = Connection::open_in_memory().expect("failed to open in-memory db");
        let migrations: &[&str] = &[
            "CREATE TABLE probe (id INTEGER PRIMARY KEY);",
            "ALTER TABLE probe ADD COLUMN first_column TEXT; ALTER TABLE table_that_does_not_exist ADD COLUMN x TEXT;",
        ];

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            apply_migrations(&mut conn, migrations);
        }));
        assert!(result.is_err(), "the deliberately-broken second migration should have panicked");

        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 1, "the failed migration must not have bumped the version");

        let has_column: i64 = conn
            .query_row("SELECT COUNT(*) FROM pragma_table_info('probe') WHERE name = 'first_column'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(has_column, 0, "first_column must have been rolled back, not left half-applied");
    }

    #[test]
    fn station_profile_read_on_fresh_db_returns_sane_defaults() {
        let conn = fresh_db();
        let profile = station_profile(&conn);
        assert_eq!(profile.callsign, None);
        assert!(!profile.manual_offline);
        assert!(profile.rig_enabled); // migration v21's own stated default
        assert!(profile.rotator_enabled); // migration v22's own stated default
    }

    // The following round-trip tests target exactly the tables
    // backup.rs exists to protect -- the operator's own logged data. Each
    // uses the real column list and constraints from the migration that
    // created it, so a future migration silently dropping or renaming one
    // of these columns fails here, in a test, instead of on someone's real
    // QSO log after an update.

    #[test]
    fn qso_log_round_trip() {
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO qso_log (call, qso_date, time_on, band, freq_mhz, mode, rst_sent, rst_rcvd, name, gridsquare, comment, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params!["KJ4ESQ", "20260828", "120000", "20m", 14.074, "SSB", "59", "59", "Test", "DM94nx", "test qso", "2026-08-28T12:00:00Z"],
        )
        .expect("qso_log insert should succeed against the migrated schema");
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM qso_log", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn mesh_messages_round_trip_including_v17_columns() {
        // mesh_messages started in v16 with no packet_id/status/fail_reason
        // -- those were added by a *separate* migration (v17). This proves
        // both migrations agree on the final shape.
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO mesh_messages (from_node, to_node, channel, text, rx_time, received_at, outbound, packet_id, status, fail_reason)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![100i64, 200i64, 0i64, "test", 1_700_000_000i64, "2026-08-28T12:00:00Z", 1i64, 42i64, "delivered", Option::<String>::None],
        )
        .expect("mesh_messages insert should succeed, including columns added by migration v17");
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM mesh_messages", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn resources_channels_and_net_roster_round_trip() {
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO resources (label, raw_tokens, updated_at) VALUES (?1, ?2, ?3)",
            params!["Shelter A", "[Beds 30/100]", "2026-08-28T12:00:00Z"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO channels (label, frequency, tone_offset, notes, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params!["Donley Co ARES", "146.940-", "100.0", "", "2026-08-28T12:00:00Z"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO net_roster (callsign, name, status, checked_in_at, last_heard_at, traffic_count, notes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params!["KJ4ESQ", "Frank", "checked_in", "2026-08-28T12:00:00Z", Option::<String>::None, 0i64, Option::<String>::None],
        )
        .unwrap();

        let resources: i64 = conn.query_row("SELECT COUNT(*) FROM resources", [], |r| r.get(0)).unwrap();
        let channels: i64 = conn.query_row("SELECT COUNT(*) FROM channels", [], |r| r.get(0)).unwrap();
        let roster: i64 = conn.query_row("SELECT COUNT(*) FROM net_roster", [], |r| r.get(0)).unwrap();
        assert_eq!((resources, channels, roster), (1, 1, 1));
    }

    #[test]
    fn backup_via_vacuum_into_produces_a_valid_independent_copy() {
        // The exact mechanism backup.rs uses in production, tested here
        // rather than only verified once by hand -- if a future
        // SQLite/rusqlite upgrade ever changes VACUUM INTO's behavior,
        // this is what catches it before a real backup silently breaks.
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO qso_log (call, qso_date, time_on, mode, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params!["KJ4ESQ", "20260828", "120000", "SSB", "2026-08-28T12:00:00Z"],
        )
        .unwrap();

        let tmp = std::env::temp_dir().join(format!("waystation-test-backup-{}.db", std::process::id()));
        conn.execute("VACUUM INTO ?1", [tmp.to_string_lossy().to_string()])
            .expect("VACUUM INTO should succeed");

        let backup = Connection::open(&tmp).expect("backup file should be a valid, independently-openable sqlite database");
        let count: i64 = backup.query_row("SELECT COUNT(*) FROM qso_log", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
        let _ = std::fs::remove_file(&tmp);
    }
}
