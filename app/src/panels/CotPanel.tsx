import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// Mirrors cot::CotContactRow.
interface CotContactRow {
  uid: string;
  callsign: string;
  cot_type: string;
  lat: number;
  lon: number;
  stale_at: string;
  heard_at: string;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

function isStale(staleAt: string): boolean {
  if (!staleAt) return false;
  return new Date(staleAt).getTime() < Date.now();
}

/** ATAK/CoT (Cursor-on-Target) interoperability -- exchanges position
 * data with ATAK/WinTAK directly over their own real default "SA
 * Multicast" UDP group (239.2.3.1:6969), no server and no WayStation-
 * specific app needed on the other end. Listening happens automatically
 * in the background once this module is enabled (Settings -> Modules);
 * broadcasting is an explicit, operator-triggered snapshot, not a
 * recurring poller -- see cot.rs's own module doc for why. */
function CotPanel() {
  const [contacts, setContacts] = useState<CotContactRow[]>([]);
  const [broadcasting, setBroadcasting] = useState(false);
  const [broadcastStatus, setBroadcastStatus] = useState<string | null>(null);

  async function refresh() {
    try {
      setContacts(await invoke<CotContactRow[]>("get_cot_contacts"));
    } catch (err) {
      console.error("get_cot_contacts failed:", err);
    }
  }

  useEffect(() => {
    refresh();
    let unlisten: (() => void) | undefined;
    listen("cot-contacts-changed", refresh).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  async function broadcast() {
    setBroadcasting(true);
    setBroadcastStatus(null);
    try {
      const count = await invoke<number>("broadcast_cot_snapshot");
      setBroadcastStatus(`Sent ${count} event${count === 1 ? "" : "s"}: this station, any mesh nodes with a known position, and every map marker.`);
    } catch (err) {
      setBroadcastStatus(`Failed: ${String(err)}`);
    } finally {
      setBroadcasting(false);
    }
  }

  return (
    <div className="panel-sync">
      <p className="sync-lede">
        Exchange position data directly with ATAK/WinTAK over their own default local-network broadcast — no TAK
        Server, no account, no app of its own. Any ATAK device on this LAN with SA Multicast on (the out-of-the-box
        default) sees a broadcast with zero setup on its side, and WayStation shows what ATAK devices broadcast back
        here automatically.
      </p>

      <div className="sync-section">
        <div className="sync-section-head">
          <h3>Broadcast to ATAK</h3>
        </div>
        <p className="field-hint">
          Sends this station's own position, any mesh nodes with a known position, and every map marker as real CoT
          events. A one-time snapshot, not a recurring broadcast — send it again whenever positions change.
        </p>
        <button type="button" className="action-btn" onClick={broadcast} disabled={broadcasting}>
          {broadcasting ? "Sending..." : "Broadcast Snapshot"}
        </button>
        {broadcastStatus && <p className="field-hint">{broadcastStatus}</p>}
      </div>

      <div className="sync-section" style={{ marginTop: "1rem" }}>
        <div className="sync-section-head">
          <h3>Heard from ATAK</h3>
        </div>
        {contacts.length === 0 ? (
          <div className="panel-alerts-empty">No CoT contacts heard yet.</div>
        ) : (
          <div className="mesh-participant-list">
            {contacts.map((c) => (
              <div key={c.uid} className="mesh-participant-row">
                <div className="mesh-participant-body">
                  <div className="mesh-participant-name-row">
                    <span className="resource-label">{c.callsign}</span>
                    <span className="resource-chip">{c.cot_type}</span>
                    {isStale(c.stale_at) && <span className="resource-chip">stale</span>}
                  </div>
                  <div className="resource-tokens">
                    <span className="resource-chip">
                      {c.lat.toFixed(4)}, {c.lon.toFixed(4)}
                    </span>
                    <span className="resource-chip">Heard {relativeTime(c.heard_at)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default CotPanel;
