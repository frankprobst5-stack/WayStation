import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Mirrors db::ResourceRequest. Phase D slice 3 -- a real request/need
// with a fulfillment lifecycle. Not the same thing as the bracket-token
// Resources panel (a passive current-status board, e.g. "[Beds 30/100]");
// this is an active ask that gets tracked to done.
interface ResourceRequest {
  id: number;
  uuid: string;
  incident_id: string | null;
  resource_type: string;
  description: string | null;
  quantity: string | null;
  location: string | null;
  priority: string;
  status: string;
  requested_by: string | null;
  needed_by: string | null;
  created_at: string;
  updated_at: string;
  fulfilled_at: string | null;
  revision: number;
  trust_state: string;
}

interface Incident {
  id: number;
  uuid: string;
  name: string;
  status: "active" | "closed";
}

const PRIORITIES = ["routine", "priority", "immediate", "emergency"] as const;
const STATUSES = ["requested", "acknowledged", "in_progress", "fulfilled", "cancelled"] as const;

const STATUS_LABELS: Record<string, string> = {
  requested: "Requested",
  acknowledged: "Acknowledged",
  in_progress: "In Progress",
  fulfilled: "Fulfilled",
  cancelled: "Cancelled",
};

function ResourceRequestsPanel() {
  const [requests, setRequests] = useState<ResourceRequest[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [resourceType, setResourceType] = useState("");
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("");
  const [location, setLocation] = useState("");
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>("routine");
  const [creating, setCreating] = useState(false);

  async function refresh() {
    const [reqs, allIncidents] = await Promise.all([invoke<ResourceRequest[]>("get_resource_requests"), invoke<Incident[]>("get_incidents")]);
    setRequests(reqs);
    setIncidents(allIncidents.filter((i) => i.status === "active"));
  }

  useEffect(() => {
    refresh();
  }, []);

  async function addRequest(e: React.FormEvent) {
    e.preventDefault();
    if (!resourceType.trim()) return;
    setCreating(true);
    try {
      await invoke("create_resource_request", {
        incidentId: null,
        resourceType: resourceType.trim(),
        description: description.trim() || null,
        quantity: quantity.trim() || null,
        location: location.trim() || null,
        priority,
        requestedBy: null,
        neededBy: null,
      });
      setResourceType("");
      setDescription("");
      setQuantity("");
      setLocation("");
      setPriority("routine");
      await refresh();
    } finally {
      setCreating(false);
    }
  }

  async function changeStatus(requestId: number, status: string) {
    await invoke("set_resource_request_status", { requestId, status });
    await refresh();
  }

  async function changeIncident(requestId: number, incidentUuid: string) {
    await invoke("set_resource_request_incident", { requestId, incidentId: incidentUuid || null });
    await refresh();
  }

  return (
    <div className="panel-resource-requests">
      <p className="resource-requests-lede">
        Real, active requests with a fulfillment lifecycle — not the same as the Resources status board, which
        shows current inventory ("[Beds 30/100]"). This is for "Shelter B needs 40 gallons of fuel," tracked from
        requested through fulfilled.
      </p>

      <form className="resource-requests-create-form" onSubmit={addRequest}>
        <input type="text" placeholder="What's needed (e.g. fuel, medical, food)" value={resourceType} onChange={(e) => setResourceType(e.target.value)} />
        <input type="text" placeholder="Quantity (optional)" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        <input type="text" placeholder="Location (optional)" value={location} onChange={(e) => setLocation(e.target.value)} />
        <input type="text" placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
        <select value={priority} onChange={(e) => setPriority(e.target.value as (typeof PRIORITIES)[number])}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button type="submit" disabled={creating || !resourceType.trim()}>
          {creating ? "Logging…" : "Log Request"}
        </button>
      </form>

      <div className="resource-requests-list">
        {requests.length === 0 && <div className="resource-requests-empty">No requests logged yet.</div>}
        {requests.map((req) => (
          <div key={req.id} className={`resource-request-row resource-request-priority-${req.priority} resource-request-status-${req.status}`}>
            <div className="resource-request-row-main">
              <span className="resource-request-type">
                {req.resource_type}
                {req.quantity && <span className="resource-request-quantity"> — {req.quantity}</span>}
              </span>
              {req.location && <span className="resource-request-location">{req.location}</span>}
              {req.description && <span className="resource-request-description">{req.description}</span>}
              <span className="resource-request-priority-badge">{req.priority}</span>
            </div>
            <select value={req.status} onChange={(e) => changeStatus(req.id, e.target.value)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
            <select value={req.incident_id ?? ""} onChange={(e) => changeIncident(req.id, e.target.value)}>
              <option value="">Not assigned</option>
              {incidents.map((incident) => (
                <option key={incident.uuid} value={incident.uuid}>
                  {incident.name}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}

export default ResourceRequestsPanel;
