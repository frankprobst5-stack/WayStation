import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Mirrors direwolf::DirewolfStatus.
interface DirewolfStatus {
  binary_found: boolean;
  callsign_configured: boolean;
  process_running: boolean;
  agw_reachable: boolean;
  kiss_reachable: boolean;
}

function PacketPanel() {
  const [status, setStatus] = useState<DirewolfStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setStatus(await invoke<DirewolfStatus>("get_direwolf_status"));
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, []);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await invoke("start_direwolf");
      // Direwolf takes a moment to open the audio device and bind its
      // TCP ports -- same reasoning as Winlink's restart delay.
      await new Promise((r) => setTimeout(r, 1500));
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await invoke("stop_direwolf");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return <div className="panel-packet">Loading...</div>;
  }

  if (!status.binary_found) {
    return (
      <div className="panel-packet panel-alerts-empty">
        Direwolf isn't installed. On Debian/Ubuntu:
        <code className="packet-cmd">sudo apt-get install direwolf</code>
        Then reopen this panel.
      </div>
    );
  }

  if (!status.callsign_configured) {
    return (
      <div className="panel-packet panel-alerts-empty">
        Set your callsign in the Station panel to enable Direwolf.
      </div>
    );
  }

  const running = status.process_running;
  const healthy = running && status.agw_reachable;

  return (
    <div className="panel-packet">
      <p className="packet-lede">
        Direwolf decodes AX.25/APRS packets from a real radio + audio interface — this is the
        start/stop and connectivity control only. Real packet decoding and APRS positions on the
        Tactical Map are a separate, not-yet-built piece (see ROADMAP.md).
      </p>

      <div className="winlink-status-line">
        <span className={`mesh-dot ${healthy ? "up" : running ? "degraded" : ""}`} />
        <span>
          {healthy ? "Direwolf running" : running ? "Direwolf starting…" : "Direwolf stopped"}
        </span>
        {status.kiss_reachable && <span className="resource-chip">KISS reachable</span>}
        {running ? (
          <button type="button" onClick={stop} disabled={busy}>
            {busy ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button type="button" onClick={start} disabled={busy}>
            {busy ? "Starting…" : "Start"}
          </button>
        )}
      </div>

      {error && <div className="winlink-warning">{error}</div>}

      <p className="field-hint">
        No PTT is configured yet, so this is receive-only — Direwolf runs in its own VOX-fallback
        mode, which is expected, not an error. Set the ALSA audio device in the Station panel
        (run <code>arecord -l</code> in a terminal to list real device names) before starting;
        blank uses Direwolf's own default device.
      </p>

      {healthy && (
        <p className="field-hint">
          Reachable on <code>127.0.0.1:8010</code> (AGW) and <code>127.0.0.1:8011</code> (KISS) —
          WayStation's own pinned ports, not Direwolf's defaults, so a manually-run copy elsewhere
          never collides with this one.
        </p>
      )}
    </div>
  );
}

export default PacketPanel;
