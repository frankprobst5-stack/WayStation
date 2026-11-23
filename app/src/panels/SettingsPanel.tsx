import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import StationIdentityPanel from "./StationIdentityPanel";
import ModulesPanel from "./ModulesPanel";
import AppearancePanel from "./AppearancePanel";
import RequiredSoftwarePanel from "./RequiredSoftwarePanel";
import DiagnosticsPanel from "./DiagnosticsPanel";
import SyncPanel from "./SyncPanel";
import AboutPanel from "./AboutPanel";
import DataStoragePanel from "./DataStoragePanel";

// Consolidates six panels that used to each show up as their own separate
// stacked tile under the "settings" category into one tabbed page,
// matching the Settings mockup. Every tab embeds the real existing panel
// component unchanged.
//
// The mockup splits Station / Connections / Integrations into three
// separate tabs, each with its own per-item Enabled toggle and gear icon.
// The real StationIdentityPanel is still one combined form -- station
// identity and every connection host (mesh, rigctld, rotctld, Citadel map
// server, local weather station, Citadel Kiwix, Direwolf audio device) all
// save together as one profile -- restructuring that into per-item tabs
// would mean rebuilding the form itself, not just moving components, so it
// stays one "Station" tab. What IS real now: a genuine "Modules" tab with
// per-item Enabled toggles for every module that has one -- Mesh, Rig,
// Rotator, Winlink, JS8Call, Packet (APRS/Direwolf), and ATAK/CoT, all
// seven as of 2026-11-22 -- see ModulesPanel.tsx and the Citadel Ecosystem
// ARCHITECTURE.md's "Module conventions" section. It's additive, not a
// replacement: Station's own rig_enabled/rotator_enabled checkboxes still
// work exactly as before, both surfaces write the same columns. A real
// "Data & Storage" usage tab exists too (added 2026-11-22, DataStoragePanel.tsx) --
// the Station/Connections/Integrations split above remains the one real,
// deliberately-not-built-yet gap in this list.

const TABS = ["Overview", "Station", "Modules", "Appearance", "Data & Storage", "Required Software", "Diagnostics", "Sync", "About"] as const;
type Tab = (typeof TABS)[number];

interface StationProfile { callsign: string | null; grid_square: string | null }
interface SoftwareEntry { detected: boolean }
interface SourceHealth { status: string }
interface ConnectivitySnapshot { sources: SourceHealth[] }
interface TrustedPeer { id: number }
interface StorageUsageSummary { db_file_bytes: number; pat_dir_bytes: number; other_files: { bytes: number }[] }

function formatBytesShort(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function useInvoke<T>(command: string) {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    // Real bug found live 2026-10-09 (same hook pattern/fix as
    // ActivityPanel's useCount and IncidentOpsPanel's useList, same
    // file-wide sweep): no catch meant a failed invoke left `data` null
    // forever, which several SummaryCard tiles below render as a
    // permanent "Loading..." on failure.
    invoke<T>(command)
      .then(setData)
      .catch((err) => console.error(`${command} failed:`, err));
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
  const storage = useInvoke<StorageUsageSummary>("get_storage_usage");

  const missingSoftware = software?.filter((s) => !s.detected).length ?? 0;
  const totalStorageBytes = storage ? storage.db_file_bytes + storage.pat_dir_bytes + storage.other_files.reduce((sum, f) => sum + f.bytes, 0) : 0;
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

      <SummaryCard title="Modules" onView={() => goTo("Modules")}>
        <div className="alert-card"><div className="alert-area">Pick only the local-hardware capability this station needs.</div></div>
      </SummaryCard>

      <SummaryCard title="Appearance" onView={() => goTo("Appearance")}>
        <div className="alert-card"><div className="alert-area">Theme, including a real red night-vision mode.</div></div>
      </SummaryCard>

      <SummaryCard title="Data & Storage" onView={() => goTo("Data & Storage")}>
        <div className="alert-card">
          <div className="alert-area">{storage === null ? "Loading..." : `${formatBytesShort(totalStorageBytes)} used${storage.other_files.length > 0 ? ` (${storage.other_files.length} stray file${storage.other_files.length === 1 ? "" : "s"})` : ""}`}</div>
        </div>
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
          The mockup's per-item Enabled toggles are real now for every module that has one — Mesh, Rig, Rotator,
          Winlink, JS8Call, Packet (APRS/Direwolf), and ATAK/CoT — see the Modules tab above. A real Data & Storage
          tab exists too. The one real remaining gap: the Station tab is still one combined form rather than split
          into Station/Connections/Integrations, since that would mean restructuring the form itself, not just
          moving components around.
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
        {tab === "Modules" && <ModulesPanel />}
        {tab === "Appearance" && <AppearancePanel />}
        {tab === "Data & Storage" && <DataStoragePanel />}
        {tab === "Required Software" && <RequiredSoftwarePanel />}
        {tab === "Diagnostics" && <DiagnosticsPanel />}
        {tab === "Sync" && <SyncPanel />}
        {tab === "About" && <AboutPanel />}
      </div>
    </div>
  );
}

export default SettingsPanel;
