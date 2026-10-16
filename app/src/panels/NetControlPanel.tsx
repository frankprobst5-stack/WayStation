import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatAge } from "../staleness/format";

interface RosterEntry {
  id: number;
  callsign: string;
  name: string | null;
  status: "checked_in" | "checked_out";
  checked_in_at: string;
  last_heard_at: string | null;
  traffic_count: number;
  notes: string | null;
  grid_square: string | null;
  latitude: number | null;
  longitude: number | null;
}

function elapsed(iso: string): string {
  return formatAge((Date.now() - new Date(iso).getTime()) / 1000);
}

function NetControlPanel() {
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [callsign, setCallsign] = useState("");
  const [name, setName] = useState("");
  const [gridSquare, setGridSquare] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Real bug found live 2026-10-09 (same file-wide sweep): none of the
  // five functions below caught a failed invoke -- refresh() just left
  // the roster stale with no signal, and the four write actions
  // (check-in/out, mark heard, clear) silently did nothing on failure,
  // with no indication to the net control operator that their action
  // didn't take.
  async function refresh() {
    try {
      setRoster(await invoke<RosterEntry[]>("get_net_roster"));
    } catch (err) {
      console.error("get_net_roster failed:", err);
      setError(String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function checkIn(e: React.FormEvent) {
    e.preventDefault();
    if (!callsign.trim()) return;
    try {
      await invoke("check_in_station", {
        callsign: callsign.toUpperCase(),
        name: name || null,
        notes: null,
        gridSquare: gridSquare || null,
      });
      setError(null);
      setCallsign("");
      setName("");
      setGridSquare("");
      refresh();
    } catch (err) {
      console.error("check_in_station failed:", err);
      setError(String(err));
    }
  }

  async function checkOut(id: number) {
    try {
      await invoke("check_out_station", { id });
      setError(null);
      refresh();
    } catch (err) {
      console.error("check_out_station failed:", err);
      setError(String(err));
    }
  }

  async function markHeard(id: number) {
    try {
      await invoke("mark_heard", { id });
      setError(null);
      refresh();
    } catch (err) {
      console.error("mark_heard failed:", err);
      setError(String(err));
    }
  }

  async function clearRoster() {
    if (!window.confirm("Clear the entire net roster? This starts a fresh net session.")) return;
    try {
      await invoke("clear_net_roster");
      setError(null);
      refresh();
    } catch (err) {
      console.error("clear_net_roster failed:", err);
      setError(String(err));
    }
  }

  return (
    <div className="panel-net-control">
      <form className="net-checkin-form" onSubmit={checkIn}>
        <input
          value={callsign}
          onChange={(e) => setCallsign(e.currentTarget.value.toUpperCase())}
          placeholder="Callsign"
          className="net-callsign-input"
        />
        <input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Name (optional)" />
        <input
          value={gridSquare}
          onChange={(e) => setGridSquare(e.currentTarget.value)}
          placeholder="Grid square (optional, for the map)"
          className="net-grid-input"
        />
        {error && <div className="panel-alerts-empty">{error}</div>}
        <button type="submit">Check In</button>
      </form>

      {roster.length === 0 ? (
        <div className="panel-alerts-empty">No stations checked in yet.</div>
      ) : (
        <div className="net-roster-table-wrap">
          <table className="net-roster-table">
            <thead>
              <tr>
                <th>Callsign</th>
                <th>Name</th>
                <th>Status</th>
                <th>Checked In</th>
                <th>Last Heard</th>
                <th>Traffic</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {roster.map((r) => (
                <tr key={r.id} className={`status-${r.status}`}>
                  <td className="net-callsign">{r.callsign}</td>
                  <td>{r.name || "—"}</td>
                  <td>
                    <span className={`net-status-pill status-${r.status}`}>{r.status === "checked_in" ? "IN" : "OUT"}</span>
                  </td>
                  <td>{elapsed(r.checked_in_at)}</td>
                  <td>{r.last_heard_at ? elapsed(r.last_heard_at) : "—"}</td>
                  <td>{r.traffic_count}</td>
                  <td className="net-roster-actions">
                    <button type="button" onClick={() => markHeard(r.id)}>
                      Mark Heard
                    </button>
                    {r.status === "checked_in" && (
                      <button type="button" onClick={() => checkOut(r.id)}>
                        Check Out
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {roster.length > 0 && (
        <button type="button" className="net-clear-button" onClick={clearRoster}>
          Clear Roster (new net)
        </button>
      )}
    </div>
  );
}

export default NetControlPanel;
