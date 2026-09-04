//! Authenticated TCP transport for WSP/1 sync, decided 2026-09-03 --
//! the last open piece of "peer synchronization" (`ROADMAP.md`'s "The
//! missing shared operational core" section named this explicitly:
//! "a local TCP transport, files work, proven; TCP doesn't exist
//! yet"). `sync.rs`'s own module doc comment anticipated this exact
//! module: its reconciliation logic (`export_manifest`,
//! `uuids_needed_from`, `export_objects`, `merge_incoming`) is
//! transport-agnostic on purpose, so this file's whole job is wrapping
//! those same functions in a real network exchange -- nothing about
//! the reconciliation logic itself changes.
//!
//! **This is on-demand, not automatic.** An operator has to click
//! "Sync via Network" for one specific station. Nothing here polls,
//! schedules, or syncs with anyone in the background -- that's the
//! separately-tracked "Automated background sync loop" backlog item,
//! deliberately not built here.
//!
//! ## Access control -- the part that actually matters
//!
//! Discovery (`discovery.rs`) tells an operator who's on the network.
//! It is explicitly not permission to exchange data with them --
//! that's this document's own second non-negotiable principle. So a
//! connection to this listener gets nothing at all until it proves it
//! belongs to a callsign already in this station's own `trusted_peers`
//! table (the same registry WSP/1 object *signing* already uses,
//! reused here for a second purpose: authenticating a live connection,
//! not just verifying a file after the fact). Proof is an HMAC of a
//! client-generated nonce, computed with the secret the connecting
//! station is expected to know -- the exact same shared-secret trust
//! model documented in `WSP-1.md`'s "Signing" section, same limits:
//! adequate for a small, mutually-known circle, not a public network.
//! A connection that fails this check gets `Rejected` and nothing
//! else -- no manifest, no objects, no error detail beyond "not
//! authorized."

use crate::db::{self, Db};
use crate::sync::{self, ManifestEntry, MergeReport, SyncObject, WspEnvelope};
use hmac::{Hmac, Mac};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use tauri::{AppHandle, Manager};

type HmacSha256 = Hmac<Sha256>;

/// Fixed for now, matching `discovery.rs`'s advertisement -- real
/// per-station port configuration is future work if this ever needs
/// to coexist with something else on the same machine.
pub const NET_SYNC_PORT: u16 = 51820;

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind")]
enum NetSyncMessage {
    Hello { callsign: Option<String>, nonce: String, signature: Option<String> },
    Accepted,
    Rejected { reason: String },
    Manifest { entries: Vec<ManifestEntry> },
    ObjectsRequest { uuids: Vec<String> },
    Objects { envelope: WspEnvelope },
    Done,
}

fn write_message(stream: &mut TcpStream, msg: &NetSyncMessage) -> Result<(), String> {
    let bytes = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
    let len = (bytes.len() as u32).to_be_bytes();
    stream.write_all(&len).map_err(|e| e.to_string())?;
    stream.write_all(&bytes).map_err(|e| e.to_string())
}

fn read_message(stream: &mut TcpStream) -> Result<NetSyncMessage, String> {
    let mut len_bytes = [0u8; 4];
    stream.read_exact(&mut len_bytes).map_err(|e| e.to_string())?;
    let len = u32::from_be_bytes(len_bytes) as usize;
    // A real message never approaches this -- this is a corruption/
    // hostile-input guard, not a real operational limit.
    if len > 64 * 1024 * 1024 {
        return Err(format!("declared message length {len} bytes is not plausible"));
    }
    let mut buf = vec![0u8; len];
    stream.read_exact(&mut buf).map_err(|e| e.to_string())?;
    serde_json::from_slice(&buf).map_err(|e| e.to_string())
}

fn sign_nonce(secret: &str, nonce: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(nonce.as_bytes());
    format!("{:x}", mac.finalize().into_bytes())
}

/// The listener side of the handshake: does this connection actually
/// belong to a callsign this station has agreed to trust? Pulled out
/// as its own function specifically so the test suite can exercise the
/// accept/reject decision directly, without needing two real sockets
/// for every case.
fn authenticate_hello(conn: &Connection, callsign: &Option<String>, nonce: &str, signature: &Option<String>) -> Result<(), String> {
    let callsign = callsign.as_deref().ok_or("no callsign presented")?;
    let secret = db::trusted_peer_secret(conn, callsign).ok_or("not a trusted peer")?;
    let signature = signature.as_deref().ok_or("no signature presented")?;
    if sign_nonce(&secret, nonce) == signature {
        Ok(())
    } else {
        Err("signature does not match the registered secret".to_string())
    }
}

/// One full bidirectional exchange, run from whichever side initiates
/// the TCP connection (the operator's own station, via
/// `sync_with_peer`) after `Accepted`. Pulls first (adopts whatever the
/// peer has that this station doesn't), then serves the peer's own
/// pull request the same way -- one connection, both directions
/// converge, same guarantee the file-based "export everything" flow
/// already gives.
/// Both sides of the connection run this exact same function, so every
/// step below has to be something *both* sides do at the same logical
/// time -- both writing, then both reading what the other just wrote.
/// The first draft of this got that wrong (read the peer's answer to
/// *our own* request immediately after sending it, rather than first
/// reading and serving the peer's request) -- caught by
/// `two_real_stations_converge_over_a_real_tcp_socket` actually running
/// two independent sockets instead of assuming the sequencing was
/// correct.
fn run_exchange(stream: &mut TcpStream, conn: &Connection) -> Result<MergeReport, String> {
    // Step 1 (both write, both read): exchange manifests.
    write_message(stream, &NetSyncMessage::Manifest { entries: sync::export_manifest(conn) })?;
    let peer_manifest = match read_message(stream)? {
        NetSyncMessage::Manifest { entries } => entries,
        other => return Err(format!("expected Manifest, got {other:?}")),
    };
    let local_manifest = sync::export_manifest(conn);
    let needed = sync::uuids_needed_from(&local_manifest, &peer_manifest);

    // Step 2 (both write, both read): exchange requests for what each
    // side is missing.
    write_message(stream, &NetSyncMessage::ObjectsRequest { uuids: needed })?;
    let peer_requested = match read_message(stream)? {
        NetSyncMessage::ObjectsRequest { uuids } => uuids,
        other => return Err(format!("expected ObjectsRequest, got {other:?}")),
    };

    // Step 3 (both write, both read): each side answers the other's
    // request, then reads the answer to its own.
    let entries: Vec<ManifestEntry> = local_manifest.into_iter().filter(|e| peer_requested.contains(&e.uuid)).collect();
    let objects: Vec<SyncObject> = sync::export_objects(conn, &entries);
    write_message(stream, &NetSyncMessage::Objects { envelope: sync::wrap_objects(conn, objects) })?;
    let report = match read_message(stream)? {
        NetSyncMessage::Objects { envelope } => {
            let (objects, signature_status) = sync::unwrap_objects(conn, envelope)?;
            let mut r = sync::merge_incoming(conn, objects);
            r.signature_status = signature_status;
            r
        }
        other => return Err(format!("expected Objects, got {other:?}")),
    };

    Ok(report)
}

fn handle_connection(mut stream: TcpStream, conn: &Connection) {
    let hello = match read_message(&mut stream) {
        Ok(msg) => msg,
        Err(_) => return, // malformed first message -- not worth logging, could be a port scan
    };
    let (callsign, nonce, signature) = match hello {
        NetSyncMessage::Hello { callsign, nonce, signature } => (callsign, nonce, signature),
        _ => return,
    };
    if let Err(reason) = authenticate_hello(conn, &callsign, &nonce, &signature) {
        let _ = write_message(&mut stream, &NetSyncMessage::Rejected { reason });
        return;
    }
    if write_message(&mut stream, &NetSyncMessage::Accepted).is_err() {
        return;
    }
    // The connecting side drives the exchange (it sent Hello); this
    // side answers using the same `run_exchange` function, just
    // starting from the listener's own Manifest send -- the protocol
    // is symmetric from here, so no separate server-side function
    // is needed.
    let _ = run_exchange(&mut stream, conn);
}

/// Listens for incoming sync connections for the app's lifetime.
/// Always-on, same as every other transport in this app (mesh, rig,
/// rotator) -- the authentication gate in `handle_connection`, not a
/// separate on/off switch, is what keeps this safe to leave running.
pub fn spawn_listener(app: AppHandle) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind(("0.0.0.0", NET_SYNC_PORT)) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("net_sync: could not bind port {NET_SYNC_PORT}: {e}");
                return;
            }
        };
        for stream in listener.incoming().flatten() {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            handle_connection(stream, &conn);
        }
    });
}

/// Connect to one specific address, prove identity with this station's
/// own signing secret, and run the same bidirectional exchange.
/// Returns `MergeReport` -- the same shape `import_objects_from_file`
/// already returns, so callers can reuse its existing result-rendering.
/// Takes a plain `&Connection` (the established `_conn` split) so both
/// the operator-triggered command below and `auto_sync.rs`'s
/// background poller can drive the exact same connect-and-exchange
/// logic without either needing a live `State<Db>`.
pub(crate) fn sync_with_peer_conn(conn: &Connection, host: &str, port: u16) -> Result<MergeReport, String> {
    let profile = db::station_profile(conn);
    let secret = profile
        .signing_secret
        .ok_or("generate this station's own signing secret first (Settings \u{2192} Peer Sync)")?;
    let nonce = uuid::Uuid::new_v4().to_string();
    let signature = Some(sign_nonce(&secret, &nonce));

    let mut stream = TcpStream::connect((host, port)).map_err(|e| format!("could not connect to {host}:{port}: {e}"))?;
    write_message(&mut stream, &NetSyncMessage::Hello { callsign: profile.callsign, nonce, signature })?;
    match read_message(&mut stream)? {
        NetSyncMessage::Accepted => {}
        NetSyncMessage::Rejected { reason } => return Err(format!("{host}:{port} rejected this connection: {reason}")),
        other => return Err(format!("expected Accepted or Rejected, got {other:?}")),
    }

    let report = run_exchange(&mut stream, conn)?;
    let _ = write_message(&mut stream, &NetSyncMessage::Done);
    Ok(report)
}

/// The operator-triggered client side -- the thin command wrapper
/// around `sync_with_peer_conn`.
#[tauri::command]
pub fn sync_with_peer(db: tauri::State<Db>, host: String, port: u16) -> Result<MergeReport, String> {
    let conn = db.0.lock().expect("db mutex poisoned");
    sync_with_peer_conn(&conn, &host, port)
}

#[cfg(test)]
mod tests {
    //! Real end-to-end tests over an actual TCP socket on loopback --
    //! not a simplified stand-in, same discipline `sync.rs`'s own test
    //! suite already applies to the in-process reconciliation logic.
    use super::*;
    use std::thread;

    fn fresh_db() -> Connection {
        let mut conn = Connection::open_in_memory().expect("failed to open in-memory db");
        db::migrate(&mut conn);
        conn
    }

    fn set_station_identity(conn: &Connection, callsign: &str, signing_secret: &str) {
        conn.execute(
            "INSERT INTO station_profile (id, callsign, signing_secret, updated_at) VALUES (1, ?1, ?2, '2026-09-03T00:00:00Z')
             ON CONFLICT(id) DO UPDATE SET callsign = excluded.callsign, signing_secret = excluded.signing_secret",
            rusqlite::params![callsign, signing_secret],
        )
        .unwrap();
    }

    fn make_message(uuid: &str) -> crate::db::Message {
        crate::db::Message {
            id: 0,
            precedence: "routine".to_string(),
            date_time: "2026-09-03T12:00:00Z".to_string(),
            to_station: Some("KJ4ESQ".to_string()),
            to_name: None,
            from_station: Some("K7WSP".to_string()),
            from_name: None,
            subject: Some("Test".to_string()),
            message_text: "over the wire".to_string(),
            content_hash: Some("hash-1".to_string()),
            dispatch_status: "dispatched".to_string(),
            dispatched_via: Some("mesh".to_string()),
            uuid: uuid.to_string(),
            revision: 1,
            updated_at: Some("2026-09-03T12:00:00Z".to_string()),
            incident_id: None,
            expires_at: None,
            trust_state: "local".to_string(),
        }
    }

    #[test]
    fn authenticate_hello_accepts_a_correctly_signed_nonce_from_a_trusted_peer() {
        let conn = fresh_db();
        db::add_trusted_peer_conn(&conn, "K7WSP".to_string(), "their-secret".to_string(), None).unwrap();
        let signature = Some(sign_nonce("their-secret", "nonce-1"));
        assert!(authenticate_hello(&conn, &Some("K7WSP".to_string()), "nonce-1", &signature).is_ok());
    }

    #[test]
    fn authenticate_hello_rejects_an_unregistered_callsign() {
        let conn = fresh_db();
        let signature = Some(sign_nonce("whatever-they-used", "nonce-1"));
        let err = authenticate_hello(&conn, &Some("UNKNOWN".to_string()), "nonce-1", &signature).unwrap_err();
        assert!(err.contains("not a trusted peer"));
    }

    #[test]
    fn authenticate_hello_rejects_a_wrong_signature_from_a_known_callsign() {
        let conn = fresh_db();
        db::add_trusted_peer_conn(&conn, "K7WSP".to_string(), "their-real-secret".to_string(), None).unwrap();
        let signature = Some(sign_nonce("a-guessed-wrong-secret", "nonce-1"));
        let err = authenticate_hello(&conn, &Some("K7WSP".to_string()), "nonce-1", &signature).unwrap_err();
        assert!(err.contains("does not match"));
    }

    #[test]
    fn authenticate_hello_rejects_no_callsign_presented() {
        let conn = fresh_db();
        assert!(authenticate_hello(&conn, &None, "nonce-1", &Some("anything".to_string())).is_err());
    }

    #[test]
    fn two_real_stations_converge_over_a_real_tcp_socket() {
        // Station A: the listener. Has a message B doesn't have yet.
        let station_a = fresh_db();
        set_station_identity(&station_a, "K7WSP", "a-secret");
        db::insert_synced_message(&station_a, &make_message("uuid-only-on-a"));

        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("failed to bind an ephemeral port");
        let port = listener.local_addr().unwrap().port();

        // Station B: the client. Trusts A's callsign+secret, and has a
        // message A doesn't have yet, so this proves both directions
        // converge in one connection.
        let station_b = fresh_db();
        set_station_identity(&station_b, "KJ4ESQ", "b-secret");
        db::add_trusted_peer_conn(&station_b, "K7WSP".to_string(), "a-secret".to_string(), None).unwrap();
        db::insert_synced_message(&station_b, &make_message("uuid-only-on-b"));

        // A must also trust B, or its listener rejects the connection.
        db::add_trusted_peer_conn(&station_a, "KJ4ESQ".to_string(), "b-secret".to_string(), None).unwrap();

        let server_thread = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("listener should accept the one connection this test makes");
            handle_connection(stream, &station_a);
            station_a
        });

        let nonce = "test-nonce".to_string();
        let signature = Some(sign_nonce("b-secret", &nonce));
        let mut client_stream = TcpStream::connect(("127.0.0.1", port)).expect("client should connect to the loopback listener");
        write_message(&mut client_stream, &NetSyncMessage::Hello { callsign: Some("KJ4ESQ".to_string()), nonce, signature }).unwrap();
        match read_message(&mut client_stream).unwrap() {
            NetSyncMessage::Accepted => {}
            other => panic!("expected Accepted, got {other:?}"),
        }
        let report = run_exchange(&mut client_stream, &station_b).expect("exchange should complete cleanly");
        let _ = write_message(&mut client_stream, &NetSyncMessage::Done);

        let station_a = server_thread.join().expect("server thread should not panic");

        assert_eq!(report.inserted, vec!["uuid-only-on-a".to_string()], "client (B) should have pulled A's message");
        assert!(db::get_message_by_uuid(&station_b, "uuid-only-on-a").is_some());
        assert!(db::get_message_by_uuid(&station_a, "uuid-only-on-b").is_some(), "server (A) should have pulled B's message");
        assert_eq!(db::get_message_by_uuid(&station_b, "uuid-only-on-a").unwrap().trust_state, "received");

        // The object B received was actually signed by A -- proves the
        // network transport reuses the same wrap_objects/verify path
        // the file transport already does, not a second code path.
        assert_eq!(report.signature_status, sync::SignatureStatus::Verified);
    }

    #[test]
    fn an_untrusted_connection_is_rejected_before_any_data_moves() {
        let station_a = fresh_db();
        set_station_identity(&station_a, "K7WSP", "a-secret");
        db::insert_synced_message(&station_a, &make_message("uuid-a-private"));
        // Deliberately no trusted_peers entry for the connecting station.

        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("failed to bind an ephemeral port");
        let port = listener.local_addr().unwrap().port();

        let server_thread = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            handle_connection(stream, &station_a);
        });

        let mut client_stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write_message(&mut client_stream, &NetSyncMessage::Hello { callsign: Some("STRANGER".to_string()), nonce: "n".to_string(), signature: Some("bogus".to_string()) }).unwrap();
        match read_message(&mut client_stream).unwrap() {
            NetSyncMessage::Rejected { .. } => {}
            other => panic!("an unregistered callsign must be rejected, got {other:?}"),
        }

        server_thread.join().unwrap();
    }
}
