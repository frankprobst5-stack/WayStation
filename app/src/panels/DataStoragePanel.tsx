import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Mirrors backup::StorageFile / backup::StorageUsage.
interface StorageFile {
  name: string;
  bytes: number;
  modified: string | null;
}

interface StorageUsage {
  db_file_bytes: number;
  pat_dir_bytes: number;
  other_files: StorageFile[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

/** Real disk usage from this app's own real data directory -- the
 * Settings page's own long-standing "Not built yet" gap. Surfaces the
 * main database, Pat's real Winlink mailbox, and any other real file
 * sitting in the data dir that isn't part of this app's own known
 * layout (in practice: stray pre-migration backup snapshots a past
 * repair left behind), with a real delete action for the latter. */
function DataStoragePanel() {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletingName, setDeletingName] = useState<string | null>(null);

  async function refresh() {
    try {
      setUsage(await invoke<StorageUsage>("get_storage_usage"));
    } catch (err) {
      console.error("get_storage_usage failed:", err);
      setError(String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function deleteFile(name: string) {
    if (!confirm(`Permanently delete "${name}"? This can't be undone.`)) return;
    setDeletingName(name);
    try {
      await invoke("delete_storage_file", { name });
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setDeletingName(null);
    }
  }

  if (error) {
    return <div className="panel-alerts panel-alerts-empty">Could not read storage usage: {error}</div>;
  }
  if (!usage) {
    return <div className="panel-alerts">Loading...</div>;
  }

  const total = usage.db_file_bytes + usage.pat_dir_bytes + usage.other_files.reduce((sum, f) => sum + f.bytes, 0);

  return (
    <div className="panel-sync">
      <p className="sync-lede">
        Real disk usage from this station's own data directory — not an estimate. For a full backup of the
        database itself, use Settings → Diagnostics → Backup Database.
      </p>

      <div className="quick-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "0.8rem", marginBottom: "1rem" }}>
        <div className="sw-tile">
          <span className="sw-label">Total</span>
          <span className="sw-value">{formatBytes(total)}</span>
        </div>
        <div className="sw-tile">
          <span className="sw-label">Database</span>
          <span className="sw-value">{formatBytes(usage.db_file_bytes)}</span>
        </div>
        <div className="sw-tile">
          <span className="sw-label">Winlink Mailbox (Pat)</span>
          <span className="sw-value">{formatBytes(usage.pat_dir_bytes)}</span>
        </div>
      </div>

      <div className="sync-section">
        <div className="sync-section-head">
          <h3>Other Files in the Data Directory</h3>
        </div>
        {usage.other_files.length === 0 ? (
          <div className="panel-alerts-empty">Nothing else here — just the database and Pat's mailbox.</div>
        ) : (
          <>
            <p className="field-hint">
              Real files found alongside the database that aren't part of this app's normal layout — commonly
              stray backup snapshots a past repair or migration left behind. Safe to delete once you're sure you
              don't need them; this doesn't touch the live database or the Winlink mailbox.
            </p>
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Size</th>
                  <th>Last Modified</th>
                  <th style={{ width: "100px" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {usage.other_files.map((f) => (
                  <tr key={f.name}>
                    <td>{f.name}</td>
                    <td>{formatBytes(f.bytes)}</td>
                    <td>{f.modified ? new Date(f.modified).toLocaleString() : "unknown"}</td>
                    <td>
                      <button type="button" className="action-btn" disabled={deletingName === f.name} onClick={() => deleteFile(f.name)}>
                        {deletingName === f.name ? "..." : "Delete"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

export default DataStoragePanel;
