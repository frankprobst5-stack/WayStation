import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import AlertsPanel from "./AlertsPanel";
import IncidentInfoPanel from "./IncidentInfoPanel";
import IncidentsPanel from "./IncidentsPanel";
import PersonnelPanel from "./PersonnelPanel";
import ResourceRequestsPanel from "./ResourceRequestsPanel";
import ResourcesPanel from "./ResourcesPanel";
import ReadinessPanel from "./ReadinessPanel";

// Consolidates six panels that used to each show up as their own separate
// stacked tile under the "incident-ops" category into one tabbed page,
// matching the Incident Ops mockup ("the heart of WayStation"). Every tab
// embeds the real existing panel component unchanged.
//
// Two of the mockup's tabs -- Timeline and SITREP -- already exist for
// real, but nested inside IncidentsPanel itself (each incident row has its
// own Timeline/SITREP toggle), not as top-level tabs here. Promoting them
// would mean IncidentsPanel needs a "currently selected incident" shared
// across tabs instead of its own per-row state -- a real restructuring,
// not a consolidation, so left as-is rather than force-fit.
//
// Tasks (2026-11-23) is a real top-level tab now: a standalone tracker
// (assign/due/status), independent of resource requests, optionally tied
// to an incident. After Action Report is real too, but lives next to
// SITREPs on each incident row in the Incidents tab (see IncidentsPanel)
// since it's generated per-incident, same as a SITREP is.

const TABS = ["Overview", "Incidents", "Personnel", "Resources", "Requests", "Tasks", "Alerts"] as const;
type Tab = (typeof TABS)[number];

interface AlertSummary { id: string; event: string; severity: string }
interface Incident { status: "active" | "closed" }
interface Person { status: string }
interface ResourceRequest { status: string; priority: string }

// Mirrors db::Task.
interface Task {
  id: number;
  uuid: string;
  incident_id: string | null;
  title: string;
  assignee: string | null;
  due_at: string | null;
  status: "open" | "in_progress" | "done";
  created_at: string;
  updated_at: string;
}

interface IncidentOption { uuid: string; name: string; status: "active" | "closed" }

const TASK_STATUSES = ["open", "in_progress", "done"] as const;
const TASK_STATUS_LABELS: Record<string, string> = { open: "Open", in_progress: "In Progress", done: "Done" };

const SEVERITY_ORDER = ["Extreme", "Severe", "Moderate", "Minor", "Unknown"];

function useList<T>(command: string, args?: Record<string, unknown>) {
  const [items, setItems] = useState<T[] | null>(null);
  useEffect(() => {
    // Real bug found live 2026-10-09 (same file-wide sweep): no .catch()
    // meant a failed invoke left `items` null forever -- this hook feeds
    // four separate SummaryCard tiles below (Incidents/Personnel/
    // Requests/Alerts), each of which shows "Loading..." permanently
    // when its own `items === null`. Falling back to [] unblocks all
    // four instead of hanging.
    invoke<T[]>(command, args)
      .then(setItems)
      .catch((err) => {
        console.error(`${command} failed:`, err);
        setItems([]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);
  return items;
}

function SummaryCard({ title, onView, children }: { title: string; onView: () => void; children: React.ReactNode }) {
  return (
    <div className="sync-section">
      <div className="sync-section-head">
        <h3>{title}</h3>
        <button type="button" className="weather-link-btn" onClick={onView}>
          View Full
        </button>
      </div>
      {children}
    </div>
  );
}

function TasksTab() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [incidents, setIncidents] = useState<IncidentOption[] | null>(null);
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [incidentUuid, setIncidentUuid] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const [t, i] = await Promise.all([invoke<Task[]>("get_tasks", { incidentId: null }), invoke<IncidentOption[]>("get_incidents")]);
      setTasks(t);
      setIncidents(i);
    } catch (err) {
      console.error("task refresh failed:", err);
      setError(String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function createTask(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setCreating(true);
    try {
      await invoke("create_task", {
        incidentId: incidentUuid || null,
        title: title.trim(),
        assignee: assignee.trim() || null,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
      });
      setError(null);
      setTitle("");
      setAssignee("");
      setDueAt("");
      setIncidentUuid("");
      await refresh();
    } catch (err) {
      console.error("create_task failed:", err);
      setError(String(err));
    } finally {
      setCreating(false);
    }
  }

  async function changeStatus(uuid: string, status: string) {
    try {
      await invoke("set_task_status", { uuid, status });
      await refresh();
    } catch (err) {
      console.error("set_task_status failed:", err);
      setError(String(err));
    }
  }

  async function removeTask(uuid: string) {
    try {
      await invoke("delete_task", { uuid });
      await refresh();
    } catch (err) {
      console.error("delete_task failed:", err);
      setError(String(err));
    }
  }

  function incidentName(uuid: string | null): string | null {
    if (!uuid) return null;
    return incidents?.find((i) => i.uuid === uuid)?.name ?? "(unknown incident)";
  }

  if (tasks === null || incidents === null) {
    return <div className="panel-alerts">Loading...</div>;
  }

  const activeIncidents = incidents.filter((i) => i.status === "active");

  return (
    <div className="panel-sync">
      <p className="sync-lede">
        A standalone tracker for who's doing what by when -- separate from resource requests (which track supply,
        not assignments). Tying a task to an incident is optional; untagged tasks are general station work.
      </p>

      <form className="incidents-create-form" onSubmit={createTask}>
        <input type="text" placeholder="Task (e.g. Check generator fuel level)" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input type="text" placeholder="Assignee (optional)" value={assignee} onChange={(e) => setAssignee(e.target.value)} />
        <input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        <select value={incidentUuid} onChange={(e) => setIncidentUuid(e.target.value)}>
          <option value="">No incident</option>
          {activeIncidents.map((i) => (
            <option key={i.uuid} value={i.uuid}>
              {i.name}
            </option>
          ))}
        </select>
        <button type="submit" disabled={creating || !title.trim()}>
          {creating ? "Adding…" : "Add Task"}
        </button>
      </form>
      {error && <div className="panel-alerts-empty">{error}</div>}

      {tasks.length === 0 ? (
        <div className="incidents-empty">No tasks tracked yet.</div>
      ) : (
        <table style={{ marginTop: "0.8rem" }}>
          <thead>
            <tr>
              <th>Task</th>
              <th>Assignee</th>
              <th>Due</th>
              <th>Incident</th>
              <th>Status</th>
              <th style={{ width: "80px" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.uuid}>
                <td>{t.title}</td>
                <td>{t.assignee ?? "—"}</td>
                <td>{t.due_at ? new Date(t.due_at).toLocaleString() : "—"}</td>
                <td>{incidentName(t.incident_id) ?? "—"}</td>
                <td>
                  <select value={t.status} onChange={(e) => changeStatus(t.uuid, e.target.value)}>
                    {TASK_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {TASK_STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <button type="button" className="action-btn" onClick={() => removeTask(t.uuid)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function OverviewTab({ goTo }: { goTo: (t: Tab) => void }) {
  const alerts = useList<AlertSummary>("get_alerts");
  const incidents = useList<Incident>("get_incidents");
  const personnel = useList<Person>("get_personnel");
  const requests = useList<ResourceRequest>("get_resource_requests");
  const tasks = useList<Task>("get_tasks", { incidentId: null });

  const activeIncidents = incidents?.filter((i) => i.status === "active").length ?? 0;
  const available = personnel?.filter((p) => p.status === "available").length ?? 0;
  const openRequests = requests?.filter((r) => r.status !== "fulfilled" && r.status !== "cancelled");
  const criticalOpen = openRequests?.filter((r) => r.priority === "emergency" || r.priority === "immediate").length ?? 0;
  const topAlert = alerts?.slice().sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))[0];

  return (
    <div>
      <IncidentInfoPanel />

      <div className="weather-overview-grid" style={{ marginTop: "1rem" }}>
        <SummaryCard title="Incidents" onView={() => goTo("Incidents")}>
          <div className="alert-card">
            <div className="alert-area">{incidents === null ? "Loading..." : `${activeIncidents} active incident${activeIncidents === 1 ? "" : "s"}`}</div>
          </div>
        </SummaryCard>

        <SummaryCard title="Personnel" onView={() => goTo("Personnel")}>
          <div className="alert-card">
            <div className="alert-area">{personnel === null ? "Loading..." : `${available} of ${personnel.length} available`}</div>
          </div>
        </SummaryCard>

        <SummaryCard title="Resource Requests" onView={() => goTo("Requests")}>
          <div className="alert-card">
            <div className="alert-area">
              {requests === null ? "Loading..." : `${openRequests?.length ?? 0} open`}
              {criticalOpen > 0 && <span className="resource-chip" style={{ marginLeft: "0.5rem" }}>{criticalOpen} urgent</span>}
            </div>
          </div>
        </SummaryCard>

        <SummaryCard title="Alerts" onView={() => goTo("Alerts")}>
          {alerts === null ? (
            <div className="alert-card"><div className="alert-area">Loading...</div></div>
          ) : !topAlert ? (
            <div className="alert-card"><div className="alert-area">No active alerts.</div></div>
          ) : (
            <div className={`alert-card severity-${topAlert.severity.toLowerCase()}`}>
              <div className="alert-header"><span>{topAlert.event}</span><span className="alert-severity">{topAlert.severity}</span></div>
              <div className="alert-area">{alerts.length} total</div>
            </div>
          )}
        </SummaryCard>

        <SummaryCard title="Tasks" onView={() => goTo("Tasks")}>
          <div className="alert-card">
            <div className="alert-area">
              {tasks === null ? "Loading..." : `${tasks.filter((t) => t.status !== "done").length} of ${tasks.length} open`}
            </div>
          </div>
        </SummaryCard>

        <div className="sync-section">
          <div className="sync-section-head">
            <h3>📥 Prepare for Offline</h3>
          </div>
          <ReadinessPanel />
        </div>
      </div>
    </div>
  );
}

function IncidentOpsPanel() {
  const [tab, setTab] = useState<Tab>("Overview");

  return (
    <div className="panel-weather">
      <p className="sync-lede">
        The heart of WayStation's incident coordination — one declared incident is what messages, map markers,
        personnel, and resource requests all get tagged against.
      </p>

      <div className="panel-tabs">
        {TABS.map((t) => (
          <button key={t} type="button" className={t === tab ? "panel-tab-btn active" : "panel-tab-btn"} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      <div className="panel-tab-content">
        {tab === "Overview" && <OverviewTab goTo={setTab} />}
        {tab === "Incidents" && <IncidentsPanel />}
        {tab === "Personnel" && <PersonnelPanel />}
        {tab === "Resources" && <ResourcesPanel />}
        {tab === "Requests" && <ResourceRequestsPanel />}
        {tab === "Tasks" && <TasksTab />}
        {tab === "Alerts" && <AlertsPanel />}
      </div>
    </div>
  );
}

export default IncidentOpsPanel;
