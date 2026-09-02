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

function PersonnelPanel() {
  const [personnel, setPersonnel] = useState<Person[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [callsign, setCallsign] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [creating, setCreating] = useState(false);

  async function refresh() {
    const [people, allIncidents] = await Promise.all([invoke<Person[]>("get_personnel"), invoke<Incident[]>("get_incidents")]);
    setPersonnel(people);
    setIncidents(allIncidents.filter((i) => i.status === "active"));
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
      setCallsign("");
      setName("");
      setRole("");
      await refresh();
    } finally {
      setCreating(false);
    }
  }

  async function changeStatus(personId: number, status: string) {
    await invoke("set_person_status", { personId, status });
    await refresh();
  }

  async function changeIncident(personId: number, incidentUuid: string) {
    await invoke("assign_person_to_incident", { personId, incidentId: incidentUuid || null });
    await refresh();
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
          </div>
        ))}
      </div>
    </div>
  );
}

export default PersonnelPanel;
