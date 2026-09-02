import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Mirrors db::Incident. Phase D slice 1 -- create/list/close. Personnel,
// resources, and a timeline exist as separate panels/sections now;
// structured SITREP and tactical-map integration are still real future
// work, not something this panel claims to do.
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

// Mirrors db::IncidentEvent.
interface IncidentEvent {
  id: number;
  incident_id: string;
  event_type: string;
  object_type: string | null;
  object_uuid: string | null;
  summary: string;
  occurred_at: string;
}

function IncidentTimeline({ incidentUuid }: { incidentUuid: string }) {
  const [events, setEvents] = useState<IncidentEvent[] | null>(null);

  useEffect(() => {
    invoke<IncidentEvent[]>("get_incident_events", { incidentId: incidentUuid }).then(setEvents);
  }, [incidentUuid]);

  if (events === null) return <div className="incident-timeline incident-timeline-loading">Loading timeline…</div>;
  if (events.length === 0) return <div className="incident-timeline incident-timeline-empty">Nothing recorded yet.</div>;

  return (
    <div className="incident-timeline">
      {events.map((event) => (
        <div key={event.id} className="incident-timeline-row">
          <span className="incident-timeline-time">{new Date(event.occurred_at).toLocaleTimeString()}</span>
          <span className="incident-timeline-summary">{event.summary}</span>
        </div>
      ))}
    </div>
  );
}

function IncidentsPanel() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [closingId, setClosingId] = useState<number | null>(null);
  const [expandedUuid, setExpandedUuid] = useState<string | null>(null);

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

  function toggleTimeline(uuid: string) {
    setExpandedUuid((current) => (current === uuid ? null : uuid));
  }

  const active = incidents.filter((i) => i.status === "active");
  const closed = incidents.filter((i) => i.status === "closed");

  function renderIncident(incident: Incident) {
    const isExpanded = expandedUuid === incident.uuid;
    return (
      <div key={incident.id} className={`incident-row incident-row-${incident.status}`}>
        <div className="incident-row-top">
          <div className="incident-row-main">
            <span className="incident-name">{incident.name}</span>
            {incident.description && <span className="incident-description">{incident.description}</span>}
            <span className="incident-meta">
              {incident.status === "active"
                ? `Started ${new Date(incident.created_at).toLocaleString()}`
                : `${new Date(incident.created_at).toLocaleDateString()} – ${incident.closed_at ? new Date(incident.closed_at).toLocaleDateString() : "?"}`}
            </span>
          </div>
          <button type="button" onClick={() => toggleTimeline(incident.uuid)}>
            {isExpanded ? "Hide Timeline" : "Timeline"}
          </button>
          {incident.status === "active" && (
            <button type="button" onClick={() => closeIncident(incident.id)} disabled={closingId === incident.id}>
              {closingId === incident.id ? "Closing…" : "Close"}
            </button>
          )}
        </div>
        {isExpanded && <IncidentTimeline incidentUuid={incident.uuid} />}
      </div>
    );
  }

  return (
    <div className="panel-incidents">
      <p className="incidents-lede">
        A declared incident is what messages, map markers, personnel, and resource requests get tagged against —
        the shared context everything else in Phase D builds on. Every tag, status change, and assignment against
        an incident is recorded on its timeline.
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
        {active.map(renderIncident)}
      </div>

      {closed.length > 0 && (
        <div className="incidents-section">
          <h3>Closed ({closed.length})</h3>
          {closed.map(renderIncident)}
        </div>
      )}
    </div>
  );
}

export default IncidentsPanel;
