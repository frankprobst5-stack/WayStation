import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface WinlinkStatus {
  binary_found: boolean;
  callsign_configured: boolean;
  process_running: boolean;
  api_reachable: boolean;
  foreign_process: boolean;
  raw_status: { connected?: boolean; active_listeners?: string[] } | null;
}

// Pat's mailbox JSON shape isn't pinned down here (no real Winlink account
// used in development — see project notes on why). Read defensively and
// fall back to a raw dump rather than guessing wrong and hiding data.
type WinlinkMessage = Record<string, unknown>;

function fieldAsString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "address" in value) {
    return String((value as { address: unknown }).address);
  }
  return null;
}

function WinlinkPanel() {
  const [status, setStatus] = useState<WinlinkStatus | null>(null);
  const [inbox, setInbox] = useState<WinlinkMessage[]>([]);
  const [restarting, setRestarting] = useState(false);

  async function refresh() {
    const s = await invoke<WinlinkStatus>("get_winlink_status");
    setStatus(s);
    if (s.api_reachable) {
      setInbox(await invoke<WinlinkMessage[]>("get_winlink_inbox"));
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, []);

  async function restart() {
    setRestarting(true);
    try {
      await invoke("restart_winlink_service");
      await new Promise((r) => setTimeout(r, 1500)); // give the process a moment to bind its port
      await refresh();
    } finally {
      setRestarting(false);
    }
  }

  if (!status) {
    return <div className="panel-winlink">Loading...</div>;
  }

  if (!status.binary_found) {
    return (
      <div className="panel-winlink panel-alerts-empty">
        Pat (Winlink client) isn't installed. Install it, then reopen this panel.
      </div>
    );
  }

  if (!status.callsign_configured) {
    return (
      <div className="panel-winlink panel-alerts-empty">
        Set your callsign in the Station panel to enable Winlink.
      </div>
    );
  }

  return (
    <div className="panel-winlink">
      <div className="winlink-status-line">
        <span
          className={`mesh-dot ${status.foreign_process ? "degraded" : status.process_running ? "up" : ""}`}
        />
        <span>
          {status.foreign_process
            ? "Another Pat is running"
            : status.process_running
              ? "Pat running"
              : "Pat not responding"}
        </span>
        {status.raw_status?.connected && <span className="resource-chip">connected</span>}
        <button type="button" onClick={restart} disabled={restarting}>
          {restarting ? "Restarting..." : "Restart Service"}
        </button>
      </div>

      {/* "Pat running" only means the local helper process and mailbox
          work -- it says nothing about whether real Winlink traffic can
          move. That needs an actual account, a radio, and an audio
          interface, none of which this status implies. Stated plainly so
          "Pat running" isn't misread as "ready to pass traffic." */}
      {status.process_running && !status.foreign_process && (
        <p className="field-hint">
          "Pat running" means the local mailbox works — it doesn't mean Winlink traffic can actually
          move yet. That also needs a registered account, a radio, and an audio interface connected.
        </p>
      )}

      {/* Pat runs headless — no window, no tray icon — so there is nothing
          for a user to find on their desktop, and "Pat running" gives them
          no way to reach it.

          Deliberately does NOT claim account setup happens there: Pat's
          web UI is mail only. The password lives in Pat's config file,
          which is edited from a terminal — and the config path matters,
          because Pat's own default is not the file Waystation runs it
          with, so `pat configure` without --config silently edits the
          wrong file. */}
      {status.api_reachable && (
        <div className="winlink-hint">
          Pat runs in the background with no window of its own.{" "}
          <a href="http://127.0.0.1:8778" target="_blank" rel="noreferrer">
            Open Pat's interface
          </a>{" "}
          to read and send mail.
          <br />
          To enter your Winlink password, run this in a terminal, then press Restart Service:
          <code className="winlink-cmd">
            pat --config ~/.local/share/waystation/pat/config.json configure
          </code>
        </div>
      )}

      {/* Reachable but not ours. Never show this as a healthy green light:
          a leftover Pat keeps whatever callsign it was launched with, so
          the operator could transmit as someone else while the panel looks
          fine. */}
      {status.foreign_process && (
        <div className="winlink-warning">
          Pat is answering on port 8778, but Waystation didn't start it — most likely a leftover
          from an earlier session. It may be using a different callsign than the one set in the
          Station panel. If it's a leftover from Waystation itself, pressing Restart Service will
          find and replace it automatically. If it's a Pat you started yourself under a different
          setup, quit that one first.
        </div>
      )}

      {status.api_reachable && (
        <div className="winlink-inbox">
          {inbox.length === 0 ? (
            <div className="panel-alerts-empty">Inbox empty.</div>
          ) : (
            inbox.map((msg, i) => {
              const subject = typeof msg.subject === "string" ? msg.subject : null;
              const from = fieldAsString(msg.from) ?? fieldAsString(msg.mid) ?? "(unknown)";
              return (
                <div key={i} className="winlink-message-row">
                  <span className="winlink-from">{from}</span>
                  <span>{subject ?? JSON.stringify(msg).slice(0, 80)}</span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

export default WinlinkPanel;
