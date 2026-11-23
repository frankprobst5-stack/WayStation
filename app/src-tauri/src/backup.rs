//! Full-database backup.
//!
//! Every real record in WayStation — QSO log, channel directory, resources,
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

// --- Data & Storage usage (Settings' own long-named "Not built yet" gap) ---
// Real disk usage from this app's own real data directory -- not an
// estimate. Surfaces exactly three things worth an operator's attention:
// the main database's real size, Pat's real mailbox directory size, and
// any other real file sitting in the data dir that isn't part of the
// app's own known layout -- in practice, stray pre-migration backup
// snapshots a past repair left behind (confirmed real on this machine:
// `waystation.db.pre-repair-backup-20260830`,
// `waystation.db.pre-v47-backup-20260906122230`), which are exactly the
// kind of silently-accumulating cruft an operator would want to see and
// clear, not guess at.

fn dir_size(path: &std::path::Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                total += if meta.is_dir() { dir_size(&entry.path()) } else { meta.len() };
            }
        }
    }
    total
}

#[derive(serde::Serialize)]
pub struct StorageFile {
    pub name: String,
    pub bytes: u64,
    /// RFC3339, when the OS reports a real mtime -- `None` rather than a
    /// guessed date on a filesystem/platform that doesn't.
    pub modified: Option<String>,
}

#[derive(serde::Serialize)]
pub struct StorageUsage {
    pub db_file_bytes: u64,
    pub pat_dir_bytes: u64,
    pub other_files: Vec<StorageFile>,
}

#[tauri::command]
pub fn get_storage_usage() -> StorageUsage {
    let dir = crate::db::data_dir();
    let mut usage = StorageUsage { db_file_bytes: 0, pat_dir_bytes: 0, other_files: Vec::new() };

    let Ok(entries) = std::fs::read_dir(&dir) else { return usage };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(meta) = entry.metadata() else { continue };
        if name == "waystation.db" {
            usage.db_file_bytes = meta.len();
        } else if name == "pat" && meta.is_dir() {
            usage.pat_dir_bytes = dir_size(&entry.path());
        } else if meta.is_file() {
            let modified = meta.modified().ok().map(|t| {
                let dt: chrono::DateTime<chrono::Utc> = t.into();
                dt.to_rfc3339()
            });
            usage.other_files.push(StorageFile { name, bytes: meta.len(), modified });
        }
    }
    usage.other_files.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    usage
}

/// Deletes one file directly inside the app's own data directory, by bare
/// filename only. Rejects any path separator (so this can never be tricked
/// into escaping `data_dir()` via `../` or an absolute path) and the two
/// filenames this app itself depends on (`waystation.db`, the `pat`
/// directory), regardless of what the caller passes -- an operator can
/// only ever clear real, named cruft `get_storage_usage` already listed,
/// never the live database or the Winlink mailbox.
#[tauri::command]
pub fn delete_storage_file(name: String) -> Result<(), String> {
    if name.contains('/') || name.contains('\\') || name == "waystation.db" || name == "pat" {
        return Err("refusing to delete that".to_string());
    }
    let path = crate::db::data_dir().join(&name);
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delete_storage_file_rejects_path_traversal() {
        assert!(delete_storage_file("../waystation.db".to_string()).is_err());
        assert!(delete_storage_file("sub/dir/file".to_string()).is_err());
        assert!(delete_storage_file("sub\\dir\\file".to_string()).is_err());
    }

    #[test]
    fn delete_storage_file_rejects_the_live_database_and_pat_mailbox_by_name() {
        assert!(delete_storage_file("waystation.db".to_string()).is_err());
        assert!(delete_storage_file("pat".to_string()).is_err());
    }

    #[test]
    fn delete_storage_file_rejects_an_absolute_path_disguised_as_a_bare_name() {
        // A bare filename never legitimately starts with a separator --
        // this is already caught by the '/' check above, locked in here
        // as its own real case rather than assumed covered.
        assert!(delete_storage_file("/etc/passwd".to_string()).is_err());
    }

    #[test]
    fn dir_size_sums_real_files_in_a_real_temp_directory() {
        let dir = std::env::temp_dir().join(format!("waystation-test-dirsize-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), b"12345").unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/b.txt"), b"1234567890").unwrap();

        assert_eq!(dir_size(&dir), 15);

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
