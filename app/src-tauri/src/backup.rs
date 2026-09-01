//! Full-database backup.
//!
//! Every real record in Waystation — QSO log, channel directory, resources,
//! net roster, station profile — lives in one SQLite file with no export
//! path. A migration bug or a reinstall could lose all of it, with nothing
//! to recover from. This is the safety net.
//!
//! Uses SQLite's own `VACUUM INTO`, not a raw file copy. A live database can
//! have uncommitted WAL data that a plain `cp` would miss or corrupt;
//! `VACUUM INTO` produces a complete, consistent, compacted snapshot in one
//! atomic step, and it's SQLite doing that work rather than this app
//! reimplementing its own copy/consistency logic — same "orchestrate, don't
//! reimplement" reasoning as everywhere else in this codebase.

use crate::db::Db;
use tauri::State;

#[tauri::command]
pub fn backup_database(db: State<Db>, destination: String) -> Result<(), String> {
    let conn = db.0.lock().expect("db mutex poisoned");
    conn.execute("VACUUM INTO ?1", [&destination])
        .map_err(|e| e.to_string())?;
    Ok(())
}
