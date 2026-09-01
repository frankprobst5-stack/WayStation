//! DX cluster telnet client — first persistent-connection ingest in this
//! codebase (everything else is a periodic HTTP poll).
//!
//! Protocol verified live against a real, currently-active public cluster
//! (dxc.nc7j.com:7373, AR-Cluster v6) before writing anything: plain-text
//! login with a callsign, then a streaming feed of lines shaped like
//! `DX de <spotter>:     <freq_khz>  <dx_call>   <comment>          <HHMM>Z`.
//! No JSON, no framing — this is the classic AK1A cluster format used
//! across DXSpider/AR-Cluster/CC-Cluster implementations.
//!
//! Login SSID: PLANNING.md's own etiquette note says HamClock uses `-55`
//! and OpenHamClock uses `-56` ("pick something else") — this uses `-58`.

use crate::connectivity::{self, Status, Via};
use crate::db::{self, Db, IncomingDxSpot};
use chrono::Utc;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const SOURCE_ID: &str = "dx-cluster";
const CLUSTER_HOST: &str = "dxc.nc7j.com";
const CLUSTER_PORT: u16 = 7373;
const SSID_SUFFIX: &str = "-58";
const RECONNECT_DELAY: Duration = Duration::from_secs(30);
// Real spot traffic can go quiet for minutes on slow bands/times (observed
// directly during research) — generous enough not to false-positive a
// live-but-quiet connection as dead.
const READ_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// How often a live cluster session re-checks the manual offline switch.
const OFFLINE_CHECK_INTERVAL: Duration = Duration::from_secs(5);

/// Parses one `DX de <spotter>: <freq> <dxcall> <comment> <HHMM>Z` line.
/// Whitespace-tolerant rather than fixed-column, since different cluster
/// server software pads slightly differently. Any line not matching this
/// shape (announcements, WWV bulletins, sysop messages) is silently
/// skipped — this client only cares about spots.
fn parse_spot_line(line: &str) -> Option<IncomingDxSpot> {
    let rest = line.strip_prefix("DX de ")?;
    let colon = rest.find(':')?;
    let spotter = rest[..colon].trim().to_string();
    if spotter.is_empty() {
        return None;
    }

    let after_colon = rest[colon + 1..].trim();
    let without_z = after_colon.strip_suffix('Z')?.trim_end();
    let last_space = without_z.rfind(char::is_whitespace)?;
    let spot_time = without_z[last_space + 1..].to_string();
    if spot_time.len() != 4 || !spot_time.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }

    let body = without_z[..last_space].trim();
    let mut iter = body.split_whitespace();
    let freq_khz: f64 = iter.next()?.parse().ok()?;
    let dx_call = iter.next()?.to_string();
    let comment: String = iter.collect::<Vec<_>>().join(" ");

    Some(IncomingDxSpot {
        spotter,
        dx_call,
        freq_mhz: freq_khz / 1000.0,
        comment: if comment.is_empty() { None } else { Some(comment) },
        spot_time,
    })
}

fn run_connection(app: &AppHandle, callsign: &str) -> Result<(), String> {
    let stream = TcpStream::connect((CLUSTER_HOST, CLUSTER_PORT)).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(READ_TIMEOUT)).map_err(|e| e.to_string())?;
    let mut writer = stream.try_clone().map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream);

    // The login prompt ("Enter your callsign\n\nlogin: ") doesn't reliably
    // end in a newline the client can detect by reading lines, so this
    // sends the callsign after a short fixed delay instead — verified
    // live that the server accepts it fine either way.
    std::thread::sleep(Duration::from_millis(1500));
    let login_line = format!("{callsign}{SSID_SUFFIX}\n");
    writer.write_all(login_line.as_bytes()).map_err(|e| e.to_string())?;

    {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        connectivity::report_source_health(&conn, SOURCE_ID, "DX Cluster", Status::Healthy, Via::Internet, None);
    }

    // The offline switch has to be able to drop a session that is already
    // up. Checking only at reconnect time isn't enough: READ_TIMEOUT is 15
    // minutes and a busy cluster sends spots continuously, so a live
    // connection would otherwise keep streaming long after the operator
    // switched the internet off — offline in the badge, still talking on
    // the wire. Rate-limited so a busy feed doesn't hammer the db mutex.
    let mut last_offline_check = std::time::Instant::now();
    loop {
        if last_offline_check.elapsed() >= OFFLINE_CHECK_INTERVAL {
            last_offline_check = std::time::Instant::now();
            if connectivity::is_manual_offline(app) {
                return Err("switched offline by the operator".to_string());
            }
        }

        let mut line = String::new();
        let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("connection closed by server".to_string());
        }
        if let Some(spot) = parse_spot_line(line.trim_end()) {
            let fetched_at = Utc::now().to_rfc3339();
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            db::insert_dx_spot(&conn, SOURCE_ID, &fetched_at, &spot);
            drop(conn);
            let _ = app.emit("dx-spots-changed", ());
        }
    }
}

pub fn spawn_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        // Unlike the polling sources, this holds a long-lived telnet
        // session, so going offline has to actually not open one.
        if connectivity::paused_for_offline(&app, SOURCE_ID, "DX Cluster") {
            std::thread::sleep(RECONNECT_DELAY);
            continue;
        }

        let callsign = {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            db::station_profile(&conn).callsign
        };

        match callsign.filter(|c| !c.trim().is_empty()) {
            Some(callsign) => {
                if let Err(detail) = run_connection(&app, &callsign) {
                    let db = app.state::<Db>();
                    let conn = db.0.lock().expect("db mutex poisoned");
                    connectivity::report_source_health(
                        &conn,
                        SOURCE_ID,
                        "DX Cluster",
                        Status::Down,
                        Via::Internet,
                        Some(&detail),
                    );
                }
                std::thread::sleep(RECONNECT_DELAY);
            }
            None => {
                // No callsign configured yet — nothing to log in with.
                std::thread::sleep(RECONNECT_DELAY);
            }
        }
    });
}
