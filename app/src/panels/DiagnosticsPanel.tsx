import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

const ISSUES_URL = "https://github.com/frankprobst5-stack/WayStation/issues/new";

// Mirrors connectivity::SourceHealth. Every ingest worker and integration
// reports here on its own cadence, so this panel needs no per-source
// knowledge — it renders whatever registered itself.
interface SourceHealth {
  source_id: string;
  label: string;
  status: string;
  via: string;
  last_success_at: string | null;
  last_attempt_at: string | null;
  detail: string | null;
}

interface ConnectivitySnapshot {
  overall: string;
  sources: SourceHealth[];
}

const REFRESH_MS = 15_000;

// Worst first. An operator opening this panel is looking for what's wrong,
// not for reassurance that eight things are fine.
const STATUS_RANK: Record<string, number> = { down: 0, degraded: 1, unknown: 2, healthy: 3 };

const VIA_LABELS: Record<string, string> = {
  internet: "Internet",
  mesh: "Mesh",
  rf: "RF",
  manual: "Manual",
};

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function DiagnosticsPanel() {
  const [snapshot, setSnapshot] = useState<ConnectivitySnapshot | null>(null);
  const [copied, setCopied] = useState(false);
  const [backupState, setBackupState] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [backupError, setBackupError] = useState<string | null>(null);

  async function refresh() {
    setSnapshot(await invoke<ConnectivitySnapshot>("get_connectivity_state"));
  }

  useEffect(() => {
    refresh();
    let unlisten: (() => void) | undefined;
    listen("connectivity-changed", refresh).then((fn) => {
      unlisten = fn;
    });
    const id = setInterval(refresh, REFRESH_MS);
    return () => {
      unlisten?.();
      clearInterval(id);
    };
  }, []);

  if (!snapshot) {
    return <div className="panel-diagnostics">Loading...</div>;
  }

  const sorted = [...snapshot.sources].sort((a, b) => {
    const rank = (STATUS_RANK[a.status] ?? 2) - (STATUS_RANK[b.status] ?? 2);
    return rank !== 0 ? rank : a.label.localeCompare(b.label);
  });
  const problems = sorted.filter((s) => s.status !== "healthy").length;

  // A tester who isn't the author needs to hand this to someone else.
  // Plain text, so a bug report doesn't depend on a screenshot.
  async function copyReport() {
    const lines = [
      `Waystation diagnostics — ${new Date().toISOString()}`,
      `Overall: ${snapshot!.overall}`,
      "",
      ...sorted.map((s) => {
        const base = `[${s.status.toUpperCase()}] ${s.label} (${VIA_LABELS[s.via] ?? s.via}) — last success ${relativeTime(s.last_success_at)}`;
        return s.detail ? `${base}\n    ${s.detail}` : base;
      }),
    ];
    await navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  // A real SQLite copy via VACUUM INTO, not a JSON export -- every table,
  // every migration's schema, byte-for-byte, with nothing to keep in sync
  // as new tables get added later.
  async function backupDatabase() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const destination = await save({
      defaultPath: `waystation-backup-${stamp}.db`,
      filters: [{ name: "SQLite database", extensions: ["db"] }],
    });
    if (!destination) return; // user cancelled the dialog
    setBackupState("saving");
    setBackupError(null);
    try {
      await invoke("backup_database", { destination });
      setBackupState("done");
      setTimeout(() => setBackupState("idle"), 2000);
    } catch (err) {
      setBackupState("error");
      setBackupError(String(err));
    }
  }

  return (
    <div className="panel-diagnostics">
      <div className="diag-header">
        <span className={`diag-summary diag-${problems > 0 ? "problem" : "ok"}`}>
          {problems === 0
            ? `All ${sorted.length} sources healthy`
            : `${problems} of ${sorted.length} sources need attention`}
        </span>
        <button type="button" onClick={copyReport}>
          {copied ? "Copied" : "Copy report"}
        </button>
        <button type="button" onClick={() => openUrl(ISSUES_URL)}>
          Report a bug
        </button>
      </div>

      <div className="diag-list">
        {sorted.map((s) => (
          <div key={s.source_id} className={`diag-row diag-status-${s.status}`}>
            <div className="diag-row-head">
              <span className="diag-label">{s.label}</span>
              <span className="diag-chips">
                <span className="resource-chip">{VIA_LABELS[s.via] ?? s.via}</span>
                <span className={`diag-badge diag-badge-${s.status}`}>{s.status}</span>
              </span>
            </div>
            {/* Last *success*, not last attempt — an integration retrying
                every 30s looks busy while having been broken for hours. */}
            <div className="diag-meta">Last success {relativeTime(s.last_success_at)}</div>
            {s.detail && <div className="diag-detail">{s.detail}</div>}
          </div>
        ))}
      </div>

      <div className="diag-backup">
        <div className="diag-backup-text">
          <strong>Back up your data.</strong> QSO log, channels, resources, net roster, everything
          — one file, no safety net until you make one. Worth doing before any update or reinstall.
        </div>
        <button type="button" onClick={backupDatabase} disabled={backupState === "saving"}>
          {backupState === "saving" ? "Saving..." : backupState === "done" ? "Saved" : "Back Up Now"}
        </button>
        {backupState === "error" && <div className="diag-backup-error">Backup failed: {backupError}</div>}
      </div>
    </div>
  );
}

export default DiagnosticsPanel;
