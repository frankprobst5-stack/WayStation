//! Operator-uploaded reference documents, closing `ReferencePanel.tsx`'s
//! own "Not built yet" gap: the real mockup's "Reference Docs" meant
//! documents an operator adds themselves, stored locally -- genuinely
//! absent before this, since the Field Library tab only ever searches
//! Citadel's own Kiwix library, nothing could be added to it from here.
//!
//! Real files are copied into this app's own data directory
//! (`data_dir()/reference_docs/`), not referenced by their original path
//! -- the source file could be on a USB drive, a network share, or
//! another user's home directory that won't exist on a future launch,
//! and WayStation's whole design already keeps every other real asset
//! (the database itself) inside its own data dir for exactly that
//! reason. No in-app viewer: `openPath` hands the file to whatever the
//! OS already opens that file type with, the same real pattern this
//! app's own `AboutPanel.tsx`/`FieldReferencePanel.tsx` already use for
//! URLs via `tauri-plugin-opener`.

use crate::db::Db;
use rusqlite::{params, Connection};
use tauri::State;

fn docs_dir() -> std::path::PathBuf {
    let dir = crate::db::data_dir().join("reference_docs");
    std::fs::create_dir_all(&dir).expect("failed to create reference_docs directory");
    dir
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ReferenceDoc {
    pub id: i64,
    pub filename: String,
    pub title: String,
    pub size_bytes: i64,
    pub added_at: String,
}

pub fn get_reference_docs_conn(conn: &Connection) -> Vec<ReferenceDoc> {
    let mut stmt = conn
        .prepare("SELECT id, filename, title, size_bytes, added_at FROM reference_docs ORDER BY added_at DESC")
        .expect("failed to prepare reference_docs query");
    stmt.query_map([], |row| {
        Ok(ReferenceDoc {
            id: row.get(0)?,
            filename: row.get(1)?,
            title: row.get(2)?,
            size_bytes: row.get(3)?,
            added_at: row.get(4)?,
        })
    })
    .expect("failed to query reference_docs")
    .filter_map(Result::ok)
    .collect()
}

#[tauri::command]
pub fn get_reference_docs(db: State<Db>) -> Vec<ReferenceDoc> {
    let conn = db.0.lock().expect("db mutex poisoned");
    get_reference_docs_conn(&conn)
}

/// Copies the real file at `source_path` (an absolute path the frontend's
/// own `@tauri-apps/plugin-dialog` file picker returned -- this app never
/// uses the fs plugin's own JS-exposed scope, every real file operation
/// goes through a command like this one using `std::fs` directly) into
/// this app's own `reference_docs/` directory under a collision-safe
/// generated filename, and records it. `title` defaults to the original
/// filename (without its generated-name collision-avoidance) when the
/// operator doesn't supply one.
#[tauri::command]
pub fn add_reference_doc(db: State<Db>, source_path: String, title: Option<String>) -> Result<ReferenceDoc, String> {
    let source = std::path::Path::new(&source_path);
    let original_name = source.file_name().and_then(|n| n.to_str()).ok_or("source path has no real filename")?.to_string();
    let extension = source.extension().and_then(|e| e.to_str()).unwrap_or("");

    let stored_name = format!(
        "{}-{}{}",
        uuid::Uuid::new_v4(),
        chrono::Utc::now().format("%Y%m%d%H%M%S"),
        if extension.is_empty() { String::new() } else { format!(".{extension}") }
    );
    let dest = docs_dir().join(&stored_name);
    std::fs::copy(source, &dest).map_err(|e| format!("could not copy {source_path}: {e}"))?;

    let size_bytes = std::fs::metadata(&dest).map(|m| m.len() as i64).unwrap_or(0);
    let added_at = chrono::Utc::now().to_rfc3339();
    let title = title.filter(|t| !t.trim().is_empty()).unwrap_or(original_name);

    let conn = db.0.lock().expect("db mutex poisoned");
    conn.execute(
        "INSERT INTO reference_docs (filename, title, size_bytes, added_at) VALUES (?1, ?2, ?3, ?4)",
        params![stored_name, title, size_bytes, added_at],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();

    Ok(ReferenceDoc { id, filename: stored_name, title, size_bytes, added_at })
}

/// Returns the real absolute path for an existing doc, for the frontend
/// to hand to `@tauri-apps/plugin-opener`'s `openPath` -- this command
/// doesn't open anything itself (opening is a frontend-side capability
/// this app already uses elsewhere), it just resolves which real file on
/// disk a given doc id actually is.
#[tauri::command]
pub fn get_reference_doc_path(db: State<Db>, id: i64) -> Result<String, String> {
    let conn = db.0.lock().expect("db mutex poisoned");
    let filename: String = conn
        .query_row("SELECT filename FROM reference_docs WHERE id = ?1", params![id], |row| row.get(0))
        .map_err(|_| format!("no reference doc with id {id}"))?;
    Ok(docs_dir().join(filename).to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_reference_doc(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().expect("db mutex poisoned");
    let filename: Option<String> = conn.query_row("SELECT filename FROM reference_docs WHERE id = ?1", params![id], |row| row.get(0)).ok();
    conn.execute("DELETE FROM reference_docs WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    if let Some(filename) = filename {
        // Best-effort: the DB row is the real source of truth for what
        // exists from the UI's perspective, so a file already missing on
        // disk (manually removed, a prior partial failure) isn't itself
        // an error worth surfacing here.
        let _ = std::fs::remove_file(docs_dir().join(filename));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_db() -> Connection {
        let mut conn = Connection::open_in_memory().expect("failed to open in-memory db");
        crate::db::migrate(&mut conn);
        conn
    }

    #[test]
    fn get_reference_docs_conn_returns_newest_first() {
        let conn = fresh_db();
        conn.execute(
            "INSERT INTO reference_docs (filename, title, size_bytes, added_at) VALUES ('a.pdf', 'First', 100, '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO reference_docs (filename, title, size_bytes, added_at) VALUES ('b.pdf', 'Second', 200, '2026-02-01T00:00:00Z')",
            [],
        )
        .unwrap();
        let docs = get_reference_docs_conn(&conn);
        assert_eq!(docs.len(), 2);
        assert_eq!(docs[0].title, "Second", "most recently added doc should come first");
    }
}
