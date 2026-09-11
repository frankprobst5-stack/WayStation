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
// matching the Incident Ops mockup ("the heart of Waystation"). Every tab
// embeds the real existing panel component unchanged.
//
// Two of the mockup's tabs -- Timeline and SITREP -- already exist for
// real, but nested inside IncidentsPanel itself (each incident row has its
// own Timeline/SITREP toggle), not as top-level tabs here. Promoting them
// would mean IncidentsPanel needs a "currently selected incident" shared
// across tabs instead of its own per-row state -- a real restructuring,
// not a consolidation, so left as-is rather than force-fit. Two more --
// Tasks and After Action -- don't exist anywhere yet (confirmed by grep
// before writing this) and are named honestly below instead of faked.

const TABS = ["Overview", "Incidents", "Personnel", "Resources", "Requests", "Alerts"] as const;
type Tab = (typeof TABS)[number];

interface AlertSummary { id: string; event: string; severity: string }
interface Incident { status: "active" | "closed" }
interface Person { status: string }
interface ResourceRequest { status: string; priority: string }

const SEVERITY_ORDER = ["Extreme", "Severe", "Moderate", "Minor", "Unknown"];

function useList<T>(command: string) {
  const [items, setItems] = useState<T[] | null>(null);
  useEffect(() => {
    invoke<T[]>(command).then(setItems);
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

function OverviewTab({ goTo }: { goTo: (t: Tab) => void }) {
  const alerts = useList<AlertSummary>("get_alerts");
  const incidents = useList<Incident>("get_incidents");
  const personnel = useList<Person>("get_personnel");
  const requests = useList<ResourceRequest>("get_resource_requests");

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

        <div className="sync-section">
          <div className="sync-section-head">
            <h3>📥 Prepare for Offline</h3>
          </div>
          <ReadinessPanel />
        </div>

        <div className="sync-section">
          <div className="sync-section-head">
            <h3>Not built yet</h3>
          </div>
          <div className="bandplan-disclaimer">
            Two things the mockup for this page shows that don't exist here yet: a standalone Tasks tracker
            (assign/due/status, separate from resource requests) and a dedicated After Action report. SITREPs
            already capture a real point-in-time snapshot for the historical record (see the Incidents tab) --
            a formal after-action workflow on top of that is real future work, not built yet.
          </div>
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
        The heart of Waystation's incident coordination — one declared incident is what messages, map markers,
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
        {tab === "Alerts" && <AlertsPanel />}
      </div>
    </div>
  );
}

export default IncidentOpsPanel;
