import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Mirrors db::Incident. Phase D -- create/list/close, with personnel,
// resources, timeline, and SITREPs all built as of 2026-09-02. Tactical
// map integration is the one real piece still outstanding.
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

// Mirrors db::Sitrep.
interface Sitrep {
  id: number;
  uuid: string;
  incident_id: string;
  sequence: number;
  body: string;
  created_at: string;
  created_by: string | null;
  revision: number;
  trust_state: string;
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

type NarrativeState = { status: "loading"; text?: undefined; error?: undefined } | { status: "done"; text: string; error?: undefined } | { status: "error"; error: string; text?: undefined };

function IncidentSitreps({ incidentUuid }: { incidentUuid: string }) {
  const [sitreps, setSitreps] = useState<Sitrep[]>([]);
  const [generating, setGenerating] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [narratives, setNarratives] = useState<Record<number, NarrativeState>>({});

  async function refresh() {
    setSitreps(await invoke<Sitrep[]>("get_sitreps", { incidentId: incidentUuid }));
  }

  useEffect(() => {
    refresh();
  }, [incidentUuid]);

  async function generate() {
    setGenerating(true);
    try {
      await invoke("create_sitrep", { incidentId: incidentUuid, createdBy: null });
      await refresh();
    } finally {
      setGenerating(false);
    }
  }

  async function copyBody(sitrep: Sitrep) {
    await navigator.clipboard.writeText(sitrep.body);
    setCopiedId(sitrep.id);
    setTimeout(() => setCopiedId(null), 1500);
  }

  async function generateNarrative(sitrep: Sitrep) {
    setNarratives((current) => ({ ...current, [sitrep.id]: { status: "loading" } }));
    try {
      const text = await invoke<string>("generate_sitrep_narrative", { sitrepBody: sitrep.body });
      setNarratives((current) => ({ ...current, [sitrep.id]: { status: "done", text } }));
    } catch (err) {
      setNarratives((current) => ({ ...current, [sitrep.id]: { status: "error", error: String(err) } }));
    }
  }

  return (
    <div className="incident-sitreps">
      <div className="incident-sitreps-head">
        <span>
          {sitreps.length === 0 ? "No SITREPs generated yet." : `${sitreps.length} SITREP${sitreps.length === 1 ? "" : "s"} generated.`}
        </span>
        <button type="button" onClick={generate} disabled={generating}>
          {generating ? "Generating…" : "Generate New SITREP"}
        </button>
      </div>
      {sitreps.map((sitrep) => (
        <div key={sitrep.id} className="incident-sitrep-row">
          <div className="incident-sitrep-row-head">
            <span className="incident-sitrep-label">
              SITREP #{sitrep.sequence} — {new Date(sitrep.created_at).toLocaleString()}
            </span>
            <button type="button" onClick={() => setOpenId((current) => (current === sitrep.id ? null : sitrep.id))}>
              {openId === sitrep.id ? "Hide" : "View"}
            </button>
            <button type="button" onClick={() => copyBody(sitrep)}>
              {copiedId === sitrep.id ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              onClick={() => generateNarrative(sitrep)}
              disabled={narratives[sitrep.id]?.status === "loading"}
            >
              {narratives[sitrep.id]?.status === "loading" ? "Summarizing…" : "AI Narrative Summary"}
            </button>
          </div>
          {openId === sitrep.id && <pre className="incident-sitrep-body">{sitrep.body}</pre>}
          {narratives[sitrep.id]?.status === "loading" && (
            <div className="field-hint">Generating with Citadel's local AI — can take up to a minute on first use while the model loads.</div>
          )}
          {narratives[sitrep.id]?.status === "error" && (
            <div className="sync-result sync-result-error">Couldn't generate a summary: {narratives[sitrep.id].error}</div>
          )}
          {narratives[sitrep.id]?.status === "done" && (
            <div className="incident-sitrep-narrative">
              <div className="field-hint">AI-generated summary — not verified, always check against the SITREP text above.</div>
              <p>{narratives[sitrep.id].text}</p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

type ExpandedSection = "timeline" | "sitreps" | null;

function IncidentsPanel() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [closingId, setClosingId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<{ uuid: string; section: ExpandedSection }>({ uuid: "", section: null });

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

  function toggle(uuid: string, section: ExpandedSection) {
    setExpanded((current) => (current.uuid === uuid && current.section === section ? { uuid: "", section: null } : { uuid, section }));
  }

  const active = incidents.filter((i) => i.status === "active");
  const closed = incidents.filter((i) => i.status === "closed");

  function renderIncident(incident: Incident) {
    const isThis = expanded.uuid === incident.uuid;
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
          <button type="button" onClick={() => toggle(incident.uuid, "timeline")}>
            {isThis && expanded.section === "timeline" ? "Hide Timeline" : "Timeline"}
          </button>
          <button type="button" onClick={() => toggle(incident.uuid, "sitreps")}>
            {isThis && expanded.section === "sitreps" ? "Hide SITREPs" : "SITREPs"}
          </button>
          {incident.status === "active" && (
            <button type="button" onClick={() => closeIncident(incident.id)} disabled={closingId === incident.id}>
              {closingId === incident.id ? "Closing…" : "Close"}
            </button>
          )}
        </div>
        {isThis && expanded.section === "timeline" && <IncidentTimeline incidentUuid={incident.uuid} />}
        {isThis && expanded.section === "sitreps" && <IncidentSitreps incidentUuid={incident.uuid} />}
      </div>
    );
  }

  return (
    <div className="panel-incidents">
      <p className="incidents-lede">
        A declared incident is what messages, map markers, personnel, and resource requests get tagged against —
        the shared context everything else in Phase D builds on. Every tag, status change, and assignment is
        recorded on its timeline; a SITREP freezes a snapshot of all of it at one point in time, permanently, for
        the after-action record.
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
