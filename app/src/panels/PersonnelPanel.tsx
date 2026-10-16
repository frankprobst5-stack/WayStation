import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Mirrors db::Person. Phase D slice 2 -- a standing roster with status
// and an optional current incident assignment. Not the same thing as
// net_roster (radio check-in state); this is incident-operations
// assignment tracking.
interface Person {
  id: number;
  uuid: string;
  callsign: string | null;
  name: string;
  role: string | null;
  status: string;
  location: string | null;
  incident_id: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
  trust_state: string;
  grid_square: string | null;
  latitude: number | null;
  longitude: number | null;
}

interface Incident {
  id: number;
  uuid: string;
  name: string;
  status: "active" | "closed";
}

const STATUSES = ["available", "assigned", "en_route", "on_scene", "unavailable", "off_duty", "emergency"] as const;

const STATUS_LABELS: Record<string, string> = {
  available: "Available",
  assigned: "Assigned",
  en_route: "En Route",
  on_scene: "On Scene",
  unavailable: "Unavailable",
  off_duty: "Off Duty",
  emergency: "Emergency",
};

/** Grid square is entered separately from `location` (free text like "the
 * north shelter") -- this is specifically the field that puts a pin on
 * the Tactical Map, so it needs its own save action and its own
 * plottable/not-plottable feedback. */
function GridSquareField({
  personId,
  value,
  plottable,
  onSaved,
}: {
  personId: number;
  value: string | null;
  plottable: boolean;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  async function save() {
    setSaving(true);
    // Real bug found live 2026-10-09: `finally` with no `catch` meant a
    // failed save left the "Set" button stuck on "…" with no
    // explanation (saving did correctly reset, but silently).
    try {
      await invoke("set_person_location", { personId, gridSquare: draft.trim() || null });
      onSaved();
    } catch (err) {
      console.error("set_person_location failed:", err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className="person-grid-square">
      <input
        type="text"
        placeholder="Grid square"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && save()}
        className={draft && !plottable ? "grid-square-unplottable" : undefined}
      />
      <button type="button" onClick={save} disabled={saving || draft.trim() === (value ?? "")}>
        {saving ? "…" : "Set"}
      </button>
      {draft && !plottable && <span className="grid-square-warning">not on map</span>}
    </span>
  );
}

function PersonnelPanel() {
  const [personnel, setPersonnel] = useState<Person[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [callsign, setCallsign] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Real bug found live 2026-10-09 (same file-wide sweep as
  // PersonLocationEditor above): none of these four caught a failed
  // invoke -- refresh() left the roster stale with no signal, and the
  // three write actions silently did nothing on failure.
  async function refresh() {
    try {
      const [people, allIncidents] = await Promise.all([invoke<Person[]>("get_personnel"), invoke<Incident[]>("get_incidents")]);
      setPersonnel(people);
      setIncidents(allIncidents.filter((i) => i.status === "active"));
    } catch (err) {
      console.error("refresh personnel/incidents failed:", err);
      setError(String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function addPerson(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      await invoke("create_person", { callsign: callsign.trim() || null, name: name.trim(), role: role.trim() || null });
      setError(null);
      setCallsign("");
      setName("");
      setRole("");
      await refresh();
    } catch (err) {
      console.error("create_person failed:", err);
      setError(String(err));
    } finally {
      setCreating(false);
    }
  }

  async function changeStatus(personId: number, status: string) {
    try {
      await invoke("set_person_status", { personId, status });
      setError(null);
      await refresh();
    } catch (err) {
      console.error("set_person_status failed:", err);
      setError(String(err));
    }
  }

  async function changeIncident(personId: number, incidentUuid: string) {
    try {
      await invoke("assign_person_to_incident", { personId, incidentId: incidentUuid || null });
      setError(null);
      await refresh();
    } catch (err) {
      console.error("assign_person_to_incident failed:", err);
      setError(String(err));
    }
  }

  function incidentName(uuid: string | null): string {
    if (!uuid) return "—";
    return incidents.find((i) => i.uuid === uuid)?.name ?? "(closed incident)";
  }

  return (
    <div className="panel-personnel">
      <p className="personnel-lede">
        A standing roster of who's available and what they're assigned to — separate from the Mesh/Net Control
        check-in lists, which track radio presence, not operational assignment.
      </p>

      <form className="personnel-create-form" onSubmit={addPerson}>
        <input type="text" placeholder="Callsign (optional)" value={callsign} onChange={(e) => setCallsign(e.target.value)} />
        <input type="text" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input type="text" placeholder="Role (optional)" value={role} onChange={(e) => setRole(e.target.value)} />
        <button type="submit" disabled={creating || !name.trim()}>
          {creating ? "Adding…" : "Add Person"}
        </button>
      </form>
      {error && <div className="panel-alerts-empty">{error}</div>}

      <div className="personnel-list">
        {personnel.length === 0 && <div className="personnel-empty">No one on the roster yet.</div>}
        {personnel.map((person) => (
          <div key={person.id} className={`person-row person-status-${person.status}`}>
            <div className="person-row-main">
              <span className="person-name">
                {person.name}
                {person.callsign && <span className="person-callsign"> ({person.callsign})</span>}
              </span>
              {person.role && <span className="person-role">{person.role}</span>}
            </div>
            <select value={person.status} onChange={(e) => changeStatus(person.id, e.target.value)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
            <select value={person.incident_id ?? ""} onChange={(e) => changeIncident(person.id, e.target.value)}>
              <option value="">Not assigned</option>
              {incidents.map((incident) => (
                <option key={incident.uuid} value={incident.uuid}>
                  {incident.name}
                </option>
              ))}
              {person.incident_id && !incidents.some((i) => i.uuid === person.incident_id) && (
                <option value={person.incident_id}>{incidentName(person.incident_id)}</option>
              )}
            </select>
            <GridSquareField personId={person.id} value={person.grid_square} plottable={person.latitude !== null} onSaved={refresh} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default PersonnelPanel;
