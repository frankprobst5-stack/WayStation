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

  async function refresh() {
    setRoster(await invoke<RosterEntry[]>("get_net_roster"));
  }

  useEffect(() => {
    refresh();
  }, []);

  async function checkIn(e: React.FormEvent) {
    e.preventDefault();
    if (!callsign.trim()) return;
    await invoke("check_in_station", {
      callsign: callsign.toUpperCase(),
      name: name || null,
      notes: null,
      gridSquare: gridSquare || null,
    });
    setCallsign("");
    setName("");
    setGridSquare("");
    refresh();
  }

  async function checkOut(id: number) {
    await invoke("check_out_station", { id });
    refresh();
  }

  async function markHeard(id: number) {
    await invoke("mark_heard", { id });
    refresh();
  }

  async function clearRoster() {
    if (!window.confirm("Clear the entire net roster? This starts a fresh net session.")) return;
    await invoke("clear_net_roster");
    refresh();
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
