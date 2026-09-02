import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

// Mirrors sync::MergeReport. uuids only -- this panel doesn't need to
// know message/marker content to show what happened, just what and how
// many.
interface MergeReport {
  inserted: string[];
  updated: string[];
  ignored_stale: string[];
  conflicts: string[];
}

type ExportState = { status: "idle" } | { status: "exporting" } | { status: "done"; count: number; path: string } | { status: "error"; message: string };

type ImportState = { status: "idle" } | { status: "importing" } | { status: "done"; report: MergeReport } | { status: "error"; message: string };

function SyncPanel() {
  const [exportState, setExportState] = useState<ExportState>({ status: "idle" });
  const [importState, setImportState] = useState<ImportState>({ status: "idle" });

  async function exportBundle() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const path = await save({
      defaultPath: `waystation-sync-${stamp}.json`,
      filters: [{ name: "WayStation sync bundle", extensions: ["json"] }],
    });
    if (!path) return; // cancelled
    setExportState({ status: "exporting" });
    try {
      const count = await invoke<number>("export_full_bundle_to_file", { path });
      setExportState({ status: "done", count, path });
    } catch (err) {
      setExportState({ status: "error", message: String(err) });
    }
  }

  async function importBundle() {
    const path = await open({
      multiple: false,
      filters: [{ name: "WayStation sync bundle", extensions: ["json"] }],
    });
    if (!path) return; // cancelled
    setImportState({ status: "importing" });
    try {
      const report = await invoke<MergeReport>("import_objects_from_file", { path });
      setImportState({ status: "done", report });
    } catch (err) {
      setImportState({ status: "error", message: String(err) });
    }
  }

  return (
    <div className="panel-sync">
      <p className="sync-lede">
        Exchange messages and map markers with another WayStation station — no network required. Hand the exported
        file to the other station however you can (USB drive, LAN share, a mesh file transfer once that exists):
        export here, import there, and vice versa to sync both ways. Every object keeps its own identity and edit
        history, so importing the same file twice, or importing after you're already caught up, changes nothing.
      </p>

      <div className="sync-section">
        <div className="sync-section-head">
          <h3>Export</h3>
          <button type="button" onClick={exportBundle} disabled={exportState.status === "exporting"}>
            {exportState.status === "exporting" ? "Exporting…" : "Export My Data to File"}
          </button>
        </div>
        {exportState.status === "done" && (
          <div className="sync-result sync-result-ok">
            Exported {exportState.count} object{exportState.count === 1 ? "" : "s"} to {exportState.path}
          </div>
        )}
        {exportState.status === "error" && <div className="sync-result sync-result-error">Export failed: {exportState.message}</div>}
      </div>

      <div className="sync-section">
        <div className="sync-section-head">
          <h3>Import</h3>
          <button type="button" onClick={importBundle} disabled={importState.status === "importing"}>
            {importState.status === "importing" ? "Importing…" : "Import From File"}
          </button>
        </div>
        {importState.status === "done" && <ImportReport report={importState.report} />}
        {importState.status === "error" && <div className="sync-result sync-result-error">Import failed: {importState.message}</div>}
      </div>
    </div>
  );
}

function ImportReport({ report }: { report: MergeReport }) {
  const total = report.inserted.length + report.updated.length + report.ignored_stale.length + report.conflicts.length;
  if (total === 0) {
    return <div className="sync-result sync-result-ok">Nothing in that file — the exporting station had no objects yet.</div>;
  }
  return (
    <div className="sync-result">
      <div className="sync-summary-row">
        <span className="sync-stat sync-stat-inserted">{report.inserted.length} new</span>
        <span className="sync-stat sync-stat-updated">{report.updated.length} updated</span>
        <span className="sync-stat sync-stat-stale">{report.ignored_stale.length} already up to date</span>
        {report.conflicts.length > 0 && <span className="sync-stat sync-stat-conflict">{report.conflicts.length} conflicts</span>}
      </div>
      {report.conflicts.length > 0 && (
        <div className="sync-conflict-warning">
          <strong>{report.conflicts.length} object{report.conflicts.length === 1 ? "" : "s"} could not be merged automatically.</strong>{" "}
          Both stations edited the same item without either being clearly newer. Nothing was overwritten — your
          copy is untouched. Compare manually with the other station for now:
          <ul className="sync-conflict-list">
            {report.conflicts.map((uuid) => (
              <li key={uuid}>
                <code>{uuid}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default SyncPanel;
