import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Mirrors db::Incident. Phase D slice 1 -- create/list/close only.
// Personnel, resources, SITREP, timeline, and tactical-map integration
// are real, separate future work, not something this panel claims to do.
interface Incident {
  id: number;
  uuid: string;
  name: string;
  description: string | null;
  status: "active" | "closed";
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  revision: number;
  trust_state: string;
}

function IncidentsPanel() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [closingId, setClosingId] = useState<number | null>(null);

  async function refresh() {
    setIncidents(await invoke<Incident[]>("get_incidents"));
  }

  useEffect(() => {
    refresh();
  }, []);

  async function createIncident(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      await invoke("create_incident", { name: name.trim(), description: description.trim() || null });
      setName("");
      setDescription("");
      await refresh();
    } finally {
      setCreating(false);
    }
  }

  async function closeIncident(id: number) {
    setClosingId(id);
    try {
      await invoke("close_incident", { incidentId: id });
      await refresh();
    } finally {
      setClosingId(null);
    }
  }

  const active = incidents.filter((i) => i.status === "active");
  const closed = incidents.filter((i) => i.status === "closed");

  return (
    <div className="panel-incidents">
      <p className="incidents-lede">
        A declared incident is what messages and map markers get tagged against — the shared context an incident
        timeline, situation report, and tactical map will eventually be built on. This is the foundation: create,
        see what's open, close when it's over. Personnel, resources, and SITREPs are not here yet.
      </p>

      <form className="incidents-create-form" onSubmit={createIncident}>
        <input
          type="text"
          placeholder="Incident name (e.g. Panhandle Severe Weather)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          type="text"
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <button type="submit" disabled={creating || !name.trim()}>
          {creating ? "Creating…" : "Declare Incident"}
        </button>
      </form>

      <div className="incidents-section">
        <h3>Active ({active.length})</h3>
        {active.length === 0 && <div className="incidents-empty">No active incidents.</div>}
        {active.map((incident) => (
          <div key={incident.id} className="incident-row incident-row-active">
            <div className="incident-row-main">
              <span className="incident-name">{incident.name}</span>
              {incident.description && <span className="incident-description">{incident.description}</span>}
              <span className="incident-meta">Started {new Date(incident.created_at).toLocaleString()}</span>
            </div>
            <button type="button" onClick={() => closeIncident(incident.id)} disabled={closingId === incident.id}>
              {closingId === incident.id ? "Closing…" : "Close"}
            </button>
          </div>
        ))}
      </div>

      {closed.length > 0 && (
        <div className="incidents-section">
          <h3>Closed ({closed.length})</h3>
          {closed.map((incident) => (
            <div key={incident.id} className="incident-row incident-row-closed">
              <div className="incident-row-main">
                <span className="incident-name">{incident.name}</span>
                <span className="incident-meta">
                  {new Date(incident.created_at).toLocaleDateString()} –{" "}
                  {incident.closed_at ? new Date(incident.closed_at).toLocaleDateString() : "?"}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default IncidentsPanel;
