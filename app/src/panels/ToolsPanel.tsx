import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import RigControlPanel from "./RigControlPanel";
import RotatorControlPanel from "./RotatorControlPanel";
import AntennaCalculatorPanel from "./AntennaCalculatorPanel";
import DecibelCalculatorPanel from "./DecibelCalculatorPanel";
import SwrCalculatorPanel from "./SwrCalculatorPanel";
import RfSafetyPanel from "./RfSafetyPanel";
import BearingDistancePanel from "./BearingDistancePanel";
import FrequencyConversionPanel from "./FrequencyConversionPanel";

// Consolidates seven panels that used to each show up as their own
// separate stacked tile under the "tools" category into one tabbed page,
// matching the Tools mockup. Every real panel component is reused
// unchanged, grouped by what they actually do rather than kept as seven
// flat tiles. Frequency Conversions is the one genuinely new addition --
// confirmed missing by grep before building it (see its own file).
//
// The mockup's own Tools screenshot showed every calculator inline on one
// page rather than split by tab -- deliberately not copied pixel-for-
// pixel here, since by this point in the app Overview-then-drill-in is
// the established pattern (Weather, Activity, Messaging, Incident Ops
// all work this way); switching styles page-to-page would be more
// jarring than useful.
//
// "Utilities," "Saved/History," and a Tools-specific "Settings" tab from
// the mockup don't exist -- no calculation history storage anywhere in
// the backend, and Station Identity already covers real settings
// (rig/rotator host, callsign, grid square). Named on the Overview
// instead of faked.

const TABS = ["Overview", "Radio Control", "Antenna Tools", "RF Calculators", "Frequency Conversions"] as const;
type Tab = (typeof TABS)[number];

interface RigStatus { enabled: boolean; reachable: boolean }
interface RotatorStatus { enabled: boolean; reachable: boolean }

function statusLabel(s: { enabled: boolean; reachable: boolean } | null): { text: string; dot: "gray" | "green" | "red" } {
  if (!s) return { text: "Loading...", dot: "gray" };
  if (!s.enabled) return { text: "Off", dot: "gray" };
  if (!s.reachable) return { text: "Not connected", dot: "red" };
  return { text: "Connected", dot: "green" };
}

function OverviewTab({ goTo }: { goTo: (t: Tab) => void }) {
  const [rig, setRig] = useState<RigStatus | null>(null);
  const [rotator, setRotator] = useState<RotatorStatus | null>(null);

  useEffect(() => {
    invoke<RigStatus>("get_rig_status").then(setRig);
    invoke<RotatorStatus>("get_rotator_status").then(setRotator);
  }, []);

  const rigStatus = statusLabel(rig);
  const rotatorStatus = statusLabel(rotator);

  return (
    <div>
      <div className="supply-panel" style={{ marginBottom: "1rem" }}>
        <div className="supply-panel-head">Radio Hardware — click to open</div>
        <div className="supply-strip">
          <div className="supply-item" onClick={() => goTo("Radio Control")} style={{ cursor: "pointer" }}>
            <span className={`dot dot-${rigStatus.dot}`} />
            <span className="name">Rig (rigctld)</span>
            <span className="count">{rigStatus.text}</span>
          </div>
          <div className="supply-item" onClick={() => goTo("Radio Control")} style={{ cursor: "pointer" }}>
            <span className={`dot dot-${rotatorStatus.dot}`} />
            <span className="name">Rotator (rotctld)</span>
            <span className="count">{rotatorStatus.text}</span>
          </div>
        </div>
      </div>

      <div className="weather-overview-grid">
        <div className="sync-section">
          <div className="sync-section-head">
            <h3>Antenna Tools</h3>
            <button type="button" className="weather-link-btn" onClick={() => goTo("Antenna Tools")}>
              Open
            </button>
          </div>
          <div className="alert-card"><div className="alert-area">Antenna length calculator (dipole, vertical, quad, J-pole).</div></div>
        </div>

        <div className="sync-section">
          <div className="sync-section-head">
            <h3>RF Calculators</h3>
            <button type="button" className="weather-link-btn" onClick={() => goTo("RF Calculators")}>
              Open
            </button>
          </div>
          <div className="alert-card"><div className="alert-area">dB, SWR/impedance, RF power density, and bearing/distance.</div></div>
        </div>

        <div className="sync-section">
          <div className="sync-section-head">
            <h3>Frequency Conversions</h3>
            <button type="button" className="weather-link-btn" onClick={() => goTo("Frequency Conversions")}>
              Open
            </button>
          </div>
          <div className="alert-card"><div className="alert-area">Hz/kHz/MHz/GHz and free-space wavelength.</div></div>
        </div>

        <div className="sync-section">
          <div className="sync-section-head">
            <h3>Not built yet</h3>
          </div>
          <div className="bandplan-disclaimer">
            No calculation-history storage anywhere in the backend, so "Saved/History" and a generic "Utilities"
            catch-all from the mockup aren't here. A Tools-specific Settings tab isn't either -- real settings
            (rig/rotator host, callsign, grid square) already live on the Station Identity panel under Settings.
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolsPanel() {
  const [tab, setTab] = useState<Tab>("Overview");
  // Rig/Rotator each got a real Settings > Modules toggle in this same
  // pass (2026-09-25) -- hides Radio Control entirely when both are off,
  // same "a disabled module isn't in the UI at all" convention Mesh's own
  // tab in MessagingPanel.tsx just adopted, and shows just the one that's
  // still on if only one is disabled.
  const [rigEnabled, setRigEnabled] = useState(true);
  const [rotatorEnabled, setRotatorEnabled] = useState(true);

  useEffect(() => {
    invoke<{ rig_enabled: boolean; rotator_enabled: boolean }>("get_station_profile").then((p) => {
      setRigEnabled(p.rig_enabled);
      setRotatorEnabled(p.rotator_enabled);
    });
  }, []);

  const radioControlVisible = rigEnabled || rotatorEnabled;
  const visibleTabs = TABS.filter((t) => radioControlVisible || t !== "Radio Control");
  useEffect(() => {
    if (!radioControlVisible && tab === "Radio Control") setTab("Overview");
  }, [radioControlVisible, tab]);

  return (
    <div className="panel-weather">
      <p className="sync-lede">Radio hardware control and the RF/antenna math that goes with field operating.</p>

      <div className="panel-tabs">
        {visibleTabs.map((t) => (
          <button key={t} type="button" className={t === tab ? "panel-tab-btn active" : "panel-tab-btn"} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      <div className="panel-tab-content">
        {tab === "Overview" && <OverviewTab goTo={setTab} />}
        {tab === "Radio Control" && (
          <div className="weather-overview-grid">
            {rigEnabled && (
              <div className="sync-section">
                <div className="sync-section-head"><h3>Rig Control</h3></div>
                <RigControlPanel />
              </div>
            )}
            {rotatorEnabled && (
              <div className="sync-section">
                <div className="sync-section-head"><h3>Rotator Control</h3></div>
                <RotatorControlPanel />
              </div>
            )}
          </div>
        )}
        {tab === "Antenna Tools" && <AntennaCalculatorPanel />}
        {tab === "RF Calculators" && (
          <div className="weather-overview-grid">
            <div className="sync-section">
              <div className="sync-section-head"><h3>dB Calculator</h3></div>
              <DecibelCalculatorPanel />
            </div>
            <div className="sync-section">
              <div className="sync-section-head"><h3>SWR / Impedance</h3></div>
              <SwrCalculatorPanel />
            </div>
            <div className="sync-section">
              <div className="sync-section-head"><h3>RF Power Density</h3></div>
              <RfSafetyPanel />
            </div>
            <div className="sync-section">
              <div className="sync-section-head"><h3>Bearing & Distance</h3></div>
              <BearingDistancePanel />
            </div>
          </div>
        )}
        {tab === "Frequency Conversions" && <FrequencyConversionPanel />}
      </div>
    </div>
  );
}

export default ToolsPanel;
