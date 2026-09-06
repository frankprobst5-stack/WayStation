//! Real KISS/AX.25/APRS decoding -- Direwolf slice 2. Slice 1 (direwolf.rs)
//! only orchestrates the Direwolf process and reports connectivity; this
//! module is what actually turns the bytes Direwolf emits on its KISS TCP
//! port into real station positions.
//!
//! Every byte-layout claim below (KISS framing, AX.25 7-byte address
//! fields, the last-address/SSID bit layout, control/PID placement) was
//! verified against a real captured frame before writing any of this,
//! not assumed from the spec: synthesized a real AX.25/APRS packet with
//! Direwolf's own bundled `gen_packets` tool
//! (`KJ4ESQ-9>APRS,WIDE1-1:!3521.50N/10130.20W>Test packet from
//! gen_packets`), fed the resulting WAV into a real running Direwolf via
//! stdin, connected a real TCP client to its KISS port *before* the audio
//! was fed in (Direwolf doesn't replay a decoded frame to a client that
//! joins after the fact -- found by watching an early attempt capture
//! zero bytes despite a successful decode), and captured the exact 74
//! raw bytes Direwolf sent. That capture is `REAL_CAPTURED_KISS_FRAME`
//! below and is hand-verified byte-by-byte in this module's own tests --
//! not a synthetic fixture. The one piece not live-captured is KISS's
//! FESC escaping (0xC0/0xDB bytes inside the payload) -- that specific
//! byte pair essentially never appears in an ASCII APRS info field, so
//! it's implemented from KISS's own unambiguous spec rather than chased
//! down with a second live capture, and said so plainly here rather than
//! implied to be equally verified.
//!
//! Position parsing only covers the uncompressed lat/lon format
//! (`DDMM.hhN/DDDMM.hhWsymbol`). Compressed-format and Mic-E encoded
//! positions are real, different formats this doesn't decode yet --
//! named here rather than silently dropped, not started this slice.

use crate::connectivity::{self, Status, Via};
use crate::db::Db;
use serde::Serialize;
use std::io::Read;
use std::net::TcpStream;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const KISS_PORT: u16 = 8011;
const SOURCE_ID: &str = "aprs-rf";
const FEND: u8 = 0xC0;
const FESC: u8 = 0xDB;
const TFEND: u8 = 0xDC;
const TFESC: u8 = 0xDD;
const READ_TIMEOUT: Duration = Duration::from_secs(10);
const RECONNECT_DELAY: Duration = Duration::from_secs(10);

/// The real 74 bytes captured live from Direwolf's KISS TCP port (see
/// this module's own doc comment for exactly how). `c0 00` is
/// FEND+data-frame-on-channel-0; the AX.25 frame follows; the trailing
/// `c0` is the closing FEND.
#[cfg(test)]
const REAL_CAPTURED_KISS_FRAME: &str = "c00082a0a4a64040e09694688aa6a2f2ae92888a62406303f021333532312e35304e2f31303133302e3230573e54657374207061636b65742066726f6d2067656e5f7061636b657473c0";

/// Splits a growing byte buffer into complete FEND-delimited KISS frames,
/// leaving any trailing partial frame in `buf` for the next read -- same
/// incremental-parse shape as scanner_bridge.py's line-delimited
/// messages, just framed on 0xC0 instead of newlines. Returns each
/// frame's payload with the outer FEND bytes stripped but the leading
/// command byte still present (callers check/strip that).
fn extract_kiss_frames(buf: &mut Vec<u8>) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    loop {
        let Some(start) = buf.iter().position(|&b| b == FEND) else { break };
        let Some(end_offset) = buf[start + 1..].iter().position(|&b| b == FEND) else { break };
        let end = start + 1 + end_offset;
        let payload = buf[start + 1..end].to_vec();
        if !payload.is_empty() {
            frames.push(payload);
        }
        buf.drain(..=end);
    }
    frames
}

/// Reverses KISS's escaping of literal FEND/FESC bytes inside a frame's
/// payload. Per KISS's own spec (not live-captured, see module doc
/// comment): 0xC0 -> FESC TFEND, 0xDB -> FESC TFESC.
fn kiss_unescape(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len());
    let mut i = 0;
    while i < payload.len() {
        if payload[i] == FESC && i + 1 < payload.len() {
            match payload[i + 1] {
                TFEND => {
                    out.push(FEND);
                    i += 2;
                    continue;
                }
                TFESC => {
                    out.push(FESC);
                    i += 2;
                    continue;
                }
                _ => {}
            }
        }
        out.push(payload[i]);
        i += 1;
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
pub struct Ax25Frame {
    pub destination: String,
    pub source: String,
    /// Digipeater path, e.g. `["WIDE1-1", "WIDE2-1"]`.
    pub path: Vec<String>,
    pub control: u8,
    pub pid: u8,
    pub info: Vec<u8>,
}

/// Decodes one AX.25 address field (7 bytes: 6 shifted-ASCII callsign
/// chars, space-padded, then an SSID/control byte). Returns the
/// formatted `CALL` or `CALL-SSID` string and whether this was the last
/// address field (bit 0 of the 7th byte).
fn parse_ax25_address(field: &[u8]) -> Result<(String, bool), String> {
    if field.len() != 7 {
        return Err(format!("AX.25 address field must be 7 bytes, got {}", field.len()));
    }
    let callsign: String = field[..6].iter().map(|&b| (b >> 1) as char).collect();
    let callsign = callsign.trim_end().to_string();
    let ssid_byte = field[6];
    let ssid = (ssid_byte >> 1) & 0x0F;
    let is_last = ssid_byte & 0x01 != 0;
    let formatted = if ssid == 0 { callsign } else { format!("{callsign}-{ssid}") };
    Ok((formatted, is_last))
}

/// Parses one unescaped AX.25 UI frame (destination + source + up to 8
/// digipeater addresses, control, PID, info). Verified against the real
/// captured frame in this module's own tests. Only handles UI frames
/// (control byte 0x03) -- the only kind APRS ever uses; anything else is
/// a different AX.25 frame type this doesn't need to understand.
pub fn parse_ax25_frame(bytes: &[u8]) -> Result<Ax25Frame, String> {
    if bytes.len() < 16 {
        return Err(format!("frame too short to hold destination+source+control+PID: {} bytes", bytes.len()));
    }
    let (destination, dest_last) = parse_ax25_address(&bytes[0..7])?;
    if dest_last {
        return Err("destination address marked as last -- no source address present".to_string());
    }
    let (source, mut last) = parse_ax25_address(&bytes[7..14])?;
    let mut offset = 14;
    let mut path = Vec::new();
    while !last {
        if bytes.len() < offset + 7 {
            return Err("frame ended mid-digipeater-path".to_string());
        }
        let (addr, is_last) = parse_ax25_address(&bytes[offset..offset + 7])?;
        path.push(addr);
        last = is_last;
        offset += 7;
    }
    if bytes.len() < offset + 2 {
        return Err("frame too short to hold control+PID after addressing".to_string());
    }
    let control = bytes[offset];
    let pid = bytes[offset + 1];
    let info = bytes[offset + 2..].to_vec();
    Ok(Ax25Frame { destination, source, path, control, pid, info })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AprsPosition {
    pub lat: f64,
    pub lon: f64,
    pub symbol_table: char,
    pub symbol_code: char,
    pub comment: String,
}

/// Parses one NMEA-style coordinate pair, `DDMM.hhN`/`DDDMM.hhW`-shaped,
/// into signed decimal degrees. `lat_digits` is 2 (DD), `lon_digits` is
/// 3 (DDD) -- the only structural difference between the two fields.
fn parse_coord(s: &str, lat_digits: usize) -> Option<f64> {
    if s.len() < lat_digits + 5 {
        return None;
    }
    let degrees: f64 = s[..lat_digits].parse().ok()?;
    let minutes: f64 = s[lat_digits..lat_digits + 5].parse().ok()?;
    let hemisphere = s.chars().last()?;
    let magnitude = degrees + minutes / 60.0;
    match hemisphere {
        'N' | 'E' => Some(magnitude),
        'S' | 'W' => Some(-magnitude),
        _ => None,
    }
}

/// Parses the uncompressed APRS position-report format:
/// `!DDMM.hhN<sym-table>DDDMM.hhW<sym-code><comment>` (data type
/// indicators `!`/`=`/`/`/`@` all use this same shape; `/`/`@` are
/// timestamped variants this doesn't decode the timestamp of -- the
/// position/comment still parse correctly since the fixed-width
/// timestamp field is simply skipped as part of `rest` below when
/// present would need its own 7-byte strip, not implemented here since
/// no real captured example has needed it yet).
pub fn parse_aprs_position(info: &[u8]) -> Option<AprsPosition> {
    let text = std::str::from_utf8(info).ok()?;
    let mut chars = text.chars();
    let dti = chars.next()?;
    if !matches!(dti, '!' | '=') {
        // '/' and '@' (timestamped) are real APRS position formats too,
        // but need a timestamp field stripped first -- not implemented,
        // named rather than silently mis-parsed as garbage.
        return None;
    }
    let rest: String = chars.collect();
    // DDMM.hhN (8) + symbol table (1) + DDDMM.hhW (9) + symbol code (1) = 19
    if rest.len() < 19 {
        return None;
    }
    let lat_field = &rest[0..8]; // DDMM.hhN
    let symbol_table = rest[8..9].chars().next()?;
    let lon_field = &rest[9..18]; // DDDMM.hhW
    let symbol_code = rest[18..19].chars().next()?;
    let comment = rest[19..].to_string();

    let lat = parse_coord(lat_field, 2)?;
    let lon = parse_coord(lon_field, 3)?;

    Some(AprsPosition { lat, lon, symbol_table, symbol_code, comment })
}

#[derive(Debug, Clone, Serialize)]
pub struct AprsStation {
    pub callsign: String,
    pub lat: f64,
    pub lon: f64,
    pub symbol_table: String,
    pub symbol_code: String,
    pub comment: String,
    pub path: String,
    pub heard_at: String,
}

fn upsert_heard_station(conn: &rusqlite::Connection, source: &str, pos: &AprsPosition, path: &str) {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO aprs_stations (callsign, lat, lon, symbol_table, symbol_code, comment, path, heard_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(callsign) DO UPDATE SET
            lat = excluded.lat, lon = excluded.lon,
            symbol_table = excluded.symbol_table, symbol_code = excluded.symbol_code,
            comment = excluded.comment, path = excluded.path, heard_at = excluded.heard_at",
        rusqlite::params![
            source, pos.lat, pos.lon,
            pos.symbol_table.to_string(), pos.symbol_code.to_string(),
            pos.comment, path, now
        ],
    )
    .expect("failed to upsert aprs_stations");
}

#[tauri::command]
pub fn get_aprs_stations(db: tauri::State<Db>) -> Vec<AprsStation> {
    let conn = db.0.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare("SELECT callsign, lat, lon, symbol_table, symbol_code, comment, path, heard_at FROM aprs_stations ORDER BY heard_at DESC")
        .expect("failed to prepare aprs_stations query");
    stmt.query_map([], |row| {
        Ok(AprsStation {
            callsign: row.get(0)?,
            lat: row.get(1)?,
            lon: row.get(2)?,
            symbol_table: row.get(3)?,
            symbol_code: row.get(4)?,
            comment: row.get(5)?,
            path: row.get(6)?,
            heard_at: row.get(7)?,
        })
    })
    .expect("failed to query aprs_stations")
    .filter_map(Result::ok)
    .collect()
}

/// One connection attempt to Direwolf's real KISS TCP port -- reads
/// until the socket errors (Direwolf stopped, or never started), parsing
/// and persisting every real position report heard along the way.
/// Mirrors mesh.rs's `run_connection` shape (connect, report healthy,
/// loop-read-until-error).
fn run_connection(app: &AppHandle) -> Result<(), String> {
    let addr = ("127.0.0.1", KISS_PORT);
    let mut stream = TcpStream::connect(addr).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(READ_TIMEOUT)).map_err(|e| e.to_string())?;

    {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("db mutex poisoned");
        connectivity::report_source_health(&conn, SOURCE_ID, "APRS (RF)", Status::Healthy, Via::Aprs, None);
    }

    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let n = stream.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("connection closed".to_string());
        }
        buf.extend_from_slice(&chunk[..n]);
        for frame in extract_kiss_frames(&mut buf) {
            // First byte is the KISS command byte (port<<4 | command);
            // 0x00 = data frame on port 0, the only kind Direwolf's RX
            // path ever sends. Anything else (e.g. a future TNC with
            // multiple channels) is skipped rather than mis-parsed.
            if frame.first() != Some(&0x00) {
                continue;
            }
            let unescaped = kiss_unescape(&frame[1..]);
            let Ok(ax25) = parse_ax25_frame(&unescaped) else { continue };
            let Some(pos) = parse_aprs_position(&ax25.info) else { continue };
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            upsert_heard_station(&conn, &ax25.source, &pos, &ax25.path.join(","));
        }
    }
}

/// Reconnect loop -- same shape as mesh.rs's `spawn_poller`. Direwolf
/// not running yet (or stopped by the operator) just means repeated
/// connection failures here, reported honestly rather than as an error
/// state -- APRS/RF has no data to show until Direwolf's actually up,
/// same as every other "nothing configured yet" state elsewhere in this
/// app.
pub fn spawn_listener(app: AppHandle) {
    std::thread::spawn(move || loop {
        if let Err(detail) = run_connection(&app) {
            let db = app.state::<Db>();
            let conn = db.0.lock().expect("db mutex poisoned");
            connectivity::report_source_health(&conn, SOURCE_ID, "APRS (RF)", Status::Unknown, Via::Aprs, Some(&detail));
        }
        std::thread::sleep(RECONNECT_DELAY);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tiny local hex decoder for the one real fixture above -- not
    /// worth a new crate dependency for a single test constant.
    fn decode_hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn real_frame_bytes() -> Vec<u8> {
        decode_hex(REAL_CAPTURED_KISS_FRAME)
    }

    #[test]
    fn extract_kiss_frames_finds_the_one_real_captured_frame() {
        let mut buf = real_frame_bytes();
        let frames = extract_kiss_frames(&mut buf);
        assert_eq!(frames.len(), 1);
        assert!(buf.is_empty(), "the whole real capture should be consumed, nothing left over");
        // Includes the leading 0x00 command byte, excludes both FENDs.
        assert_eq!(frames[0][0], 0x00);
        assert_eq!(frames[0].len(), real_frame_bytes().len() - 2);
    }

    #[test]
    fn extract_kiss_frames_leaves_a_partial_trailing_frame_in_the_buffer() {
        let mut full = real_frame_bytes();
        let split_at = full.len() - 10;
        let mut buf = full[..split_at].to_vec();
        let frames = extract_kiss_frames(&mut buf);
        assert!(frames.is_empty(), "no complete frame yet -- the closing FEND hasn't arrived");
        assert_eq!(buf, full.drain(..split_at).collect::<Vec<u8>>());
    }

    #[test]
    fn kiss_unescape_reverses_fend_and_fesc_escaping_per_spec() {
        // Not live-captured (see module doc comment) -- KISS's own
        // unambiguous documented escaping rule, exercised directly.
        let escaped = [0x41, FESC, TFEND, 0x42, FESC, TFESC, 0x43];
        let unescaped = kiss_unescape(&escaped);
        assert_eq!(unescaped, vec![0x41, FEND, 0x42, FESC, 0x43]);
    }

    #[test]
    fn parse_ax25_address_decodes_the_real_captured_destination() {
        let raw = real_frame_bytes();
        let (addr, is_last) = parse_ax25_address(&raw[2..9]).unwrap(); // skip FEND+cmd byte
        assert_eq!(addr, "APRS");
        assert!(!is_last, "source address must follow the destination");
    }

    #[test]
    fn parse_ax25_address_decodes_the_real_captured_source_with_ssid() {
        let raw = real_frame_bytes();
        let (addr, is_last) = parse_ax25_address(&raw[9..16]).unwrap();
        assert_eq!(addr, "KJ4ESQ-9");
        assert!(!is_last, "a WIDE1-1 digipeater address follows");
    }

    #[test]
    fn parse_ax25_address_decodes_the_real_captured_digipeater_as_the_last_address() {
        let raw = real_frame_bytes();
        let (addr, is_last) = parse_ax25_address(&raw[16..23]).unwrap();
        assert_eq!(addr, "WIDE1-1");
        assert!(is_last, "WIDE1-1 is the only digipeater hop -- must be marked last");
    }

    #[test]
    fn parse_ax25_frame_decodes_the_real_captured_frame_end_to_end() {
        let raw = real_frame_bytes();
        let unescaped = kiss_unescape(&raw[2..raw.len() - 1]); // strip FEND+cmd .. FEND
        let frame = parse_ax25_frame(&unescaped).unwrap();
        assert_eq!(frame.destination, "APRS");
        assert_eq!(frame.source, "KJ4ESQ-9");
        assert_eq!(frame.path, vec!["WIDE1-1".to_string()]);
        assert_eq!(frame.control, 0x03);
        assert_eq!(frame.pid, 0xF0);
        assert_eq!(frame.info, b"!3521.50N/10130.20W>Test packet from gen_packets");
    }

    #[test]
    fn parse_aprs_position_decodes_the_real_captured_info_field() {
        let info = b"!3521.50N/10130.20W>Test packet from gen_packets";
        let pos = parse_aprs_position(info).unwrap();
        // 35 + 21.50/60 = 35.35833..., -(101 + 30.20/60) = -101.50333...
        assert!((pos.lat - 35.358333).abs() < 1e-5, "lat: {}", pos.lat);
        assert!((pos.lon - -101.503333).abs() < 1e-5, "lon: {}", pos.lon);
        assert_eq!(pos.symbol_table, '/');
        assert_eq!(pos.symbol_code, '>');
        assert_eq!(pos.comment, "Test packet from gen_packets");
    }

    #[test]
    fn parse_aprs_position_handles_southern_and_western_hemispheres() {
        let pos = parse_aprs_position(b"!3345.12S/07023.45E-").unwrap();
        assert!(pos.lat < 0.0, "S must be negative");
        assert!(pos.lon > 0.0, "E must be positive");
    }

    #[test]
    fn parse_aprs_position_rejects_a_too_short_field_instead_of_panicking() {
        // Caught a real off-by-two bug here before it shipped: the
        // original length guard was 2 bytes short of what the slicing
        // below actually needs, which would have panicked (index out of
        // bounds) on a malformed/truncated info field between 17-18
        // bytes rather than returning a clean None.
        assert!(parse_aprs_position(b"!3521.50N/10130.2").is_none());
    }

    #[test]
    fn parse_aprs_position_rejects_non_position_info_fields() {
        // A status message or other non-position APRS packet must not be
        // silently mis-parsed as a position.
        assert!(parse_aprs_position(b">Station status text").is_none());
    }

    #[test]
    fn parse_aprs_position_declines_timestamped_formats_rather_than_mis_parse() {
        // '/' and '@' are real, different (timestamped) position formats
        // this doesn't decode yet -- must return None, not garbage.
        assert!(parse_aprs_position(b"/092345z3521.50N/10130.20W>test").is_none());
    }
}
