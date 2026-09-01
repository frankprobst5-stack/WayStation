import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Js8CallStatus {
  reachable: boolean;
  callsign: string | null;
  detail: string | null;
}

// JS8Call's own API docs are openly incomplete, so the inbox shape isn't
// pinned down here — read defensively rather than guess wrong and hide data.
type Js8CallMessage = Record<string, unknown>;

function Js8CallPanel() {
  const [status, setStatus] = useState<Js8CallStatus | null>(null);
  const [inbox, setInbox] = useState<Js8CallMessage[]>([]);

  async function refresh() {
    const s = await invoke<Js8CallStatus>("get_js8call_status");
    setStatus(s);
    if (s.reachable) {
      setInbox(await invoke<Js8CallMessage[]>("get_js8call_inbox"));
    } else {
      setInbox([]);
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, []);

  if (!status) {
    return <div className="panel-js8call">Loading...</div>;
  }

  if (!status.reachable) {
    return (
      <div className="panel-js8call panel-alerts-empty">
        JS8Call not reachable. Make sure it's running with the TCP API enabled
        (File → Settings → Reporting → Enable TCP Server API, port 2442).
      </div>
    );
  }

  return (
    <div className="panel-js8call">
      <div className="winlink-status-line">
        <span className="mesh-dot up" />
        <span>{status.callsign ?? "Connected"}</span>
      </div>
      <p className="field-hint">
        This only means Waystation can reach JS8Call's local API — it doesn't mean JS8Call has a
        working radio and audio interface connected, or is actually decoding anything off the air.
      </p>

      <div className="winlink-inbox">
        {inbox.length === 0 ? (
          <div className="panel-alerts-empty">Inbox empty.</div>
        ) : (
          inbox.map((msg, i) => (
            <div key={i} className="winlink-message-row">
              {JSON.stringify(msg).slice(0, 100)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default Js8CallPanel;
