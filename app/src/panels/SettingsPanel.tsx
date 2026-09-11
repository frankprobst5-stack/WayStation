import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import StationIdentityPanel from "./StationIdentityPanel";
import AppearancePanel from "./AppearancePanel";
import RequiredSoftwarePanel from "./RequiredSoftwarePanel";
import DiagnosticsPanel from "./DiagnosticsPanel";
import SyncPanel from "./SyncPanel";
import AboutPanel from "./AboutPanel";

// Consolidates six panels that used to each show up as their own separate
// stacked tile under the "settings" category into one tabbed page,
// matching the Settings mockup. Every tab embeds the real existing panel
// component unchanged.
//
// The mockup splits Station / Connections / Integrations into three
// separate tabs, each with its own per-item Enabled toggle and gear icon.
// The real StationIdentityPanel is one combined form -- station identity
// (callsign, grid, operator) and every connection host (mesh, rigctld,
// rotctld, Citadel map server, local weather station, Citadel Kiwix,
// Direwolf audio device) all save together as one profile, not as
// separately toggleable integrations. Splitting that into three tabs here
// would mean actually restructuring StationIdentityPanel's form and save
// logic, not just moving components around -- a real feature, not a
// consolidation, so left as one "Station" tab and named honestly below.
// Likewise, no separate "Data & Storage" usage panel exists.

const TABS = ["Overview", "Station", "Appearance", "Required Software", "Diagnostics", "Sync", "About"] as const;
type Tab = (typeof TABS)[number];

interface StationProfile { callsign: string | null; grid_square: string | null }
interface SoftwareEntry { detected: boolean }
interface SourceHealth { status: string }
interface ConnectivitySnapshot { sources: SourceHealth[] }
interface TrustedPeer { id: number }

function useInvoke<T>(command: string) {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    invoke<T>(command).then(setData);
  }, [command]);
  return data;
}

function SummaryCard({ title, onView, children }: { title: string; onView: () => void; children: React.ReactNode }) {
  return (
    <div className="sync-section">
      <div className="sync-section-head">
        <h3>{title}</h3>
        <button type="button" className="weather-link-btn" onClick={onView}>
          Open
        </button>
      </div>
      {children}
    </div>
  );
}

function OverviewTab({ goTo }: { goTo: (t: Tab) => void }) {
  const profile = useInvoke<StationProfile>("get_station_profile");
  const software = useInvoke<SoftwareEntry[]>("get_required_software");
  const connectivity = useInvoke<ConnectivitySnapshot>("get_connectivity_state");
  const peers = useInvoke<TrustedPeer[]>("get_trusted_peers");

  const missingSoftware = software?.filter((s) => !s.detected).length ?? 0;
  const problemSources = connectivity?.sources.filter((s) => s.status !== "healthy").length ?? 0;

  return (
    <div className="weather-overview-grid">
      <SummaryCard title="Station" onView={() => goTo("Station")}>
        <div className="alert-card">
          <div className="alert-area">
            {profile === null ? "Loading..." : profile.callsign ? `${profile.callsign}${profile.grid_square ? ` — ${profile.grid_square}` : ""}` : "Not configured yet"}
          </div>
        </div>
      </SummaryCard>

      <SummaryCard title="Appearance" onView={() => goTo("Appearance")}>
        <div className="alert-card"><div className="alert-area">Theme, including a real red night-vision mode.</div></div>
      </SummaryCard>

      <SummaryCard title="Required Software" onView={() => goTo("Required Software")}>
        <div className="alert-card">
          <div className="alert-area">{software === null ? "Loading..." : missingSoftware === 0 ? `All ${software.length} detected` : `${missingSoftware} of ${software.length} not found`}</div>
        </div>
      </SummaryCard>

      <SummaryCard title="Diagnostics" onView={() => goTo("Diagnostics")}>
        <div className="alert-card">
          <div className="alert-area">{connectivity === null ? "Loading..." : problemSources === 0 ? `All ${connectivity.sources.length} sources healthy` : `${problemSources} of ${connectivity.sources.length} need attention`}</div>
        </div>
      </SummaryCard>

      <SummaryCard title="Sync" onView={() => goTo("Sync")}>
        <div className="alert-card">
          <div className="alert-area">{peers === null ? "Loading..." : `${peers.length} trusted peer${peers.length === 1 ? "" : "s"}`}</div>
        </div>
      </SummaryCard>

      <div className="sync-section">
        <div className="sync-section-head">
          <h3>Not built yet</h3>
        </div>
        <div className="bandplan-disclaimer">
          The mockup splits Station/Connections/Integrations into three separate tabs, each with its own per-item
          Enabled toggle. The real Station tab is one combined form -- identity and every connection host save
          together as one profile. Splitting that apart would mean restructuring the form itself, not just moving
          it into a new tab, so it stays as one "Station" tab for now. A separate "Data & Storage" usage panel
          doesn't exist either.
        </div>
      </div>
    </div>
  );
}

function SettingsPanel() {
  const [tab, setTab] = useState<Tab>("Overview");

  return (
    <div className="panel-weather">
      <p className="sync-lede">Station identity, connections, appearance, and diagnostics — all in one place.</p>

      <div className="panel-tabs">
        {TABS.map((t) => (
          <button key={t} type="button" className={t === tab ? "panel-tab-btn active" : "panel-tab-btn"} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      <div className="panel-tab-content">
        {tab === "Overview" && <OverviewTab goTo={setTab} />}
        {tab === "Station" && <StationIdentityPanel />}
        {tab === "Appearance" && <AppearancePanel />}
        {tab === "Required Software" && <RequiredSoftwarePanel />}
        {tab === "Diagnostics" && <DiagnosticsPanel />}
        {tab === "Sync" && <SyncPanel />}
        {tab === "About" && <AboutPanel />}
      </div>
    </div>
  );
}

export default SettingsPanel;
