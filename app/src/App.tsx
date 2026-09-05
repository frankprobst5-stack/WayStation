import { useEffect, useState } from "react";
import "./panels"; // side-effect: registers built-in panels
import { listPanels } from "./panels";
import type { PanelCategory } from "./panels";
import ConnectivityBadge from "./connectivity/ConnectivityBadge";
import OfflineToggle from "./connectivity/OfflineToggle";
import TacticalModeToggle from "./connectivity/TacticalModeToggle";
import { startRulesEngine } from "./rules/engine";
import TimeBar from "./TimeBar";
import StatusLights from "./StatusLights";
import FirstRunWizard from "./FirstRunWizard";
import "./App.css";

const TAB_ORDER: PanelCategory[] = [
  "dashboard",
  "incident-ops",
  "messaging",
  "tactical-map",
  "flight-tracking",
  "scanner",
  "weather",
  "activity",
  "reference",
  "tools",
  "settings",
  "manual",
];
const TAB_LABELS: Record<PanelCategory, string> = {
  dashboard: "Dashboard",
  "incident-ops": "Incident Ops",
  messaging: "Messaging",
  "tactical-map": "Tactical Map",
  "flight-tracking": "Flight Tracking",
  scanner: "Scanner",
  weather: "Weather",
  activity: "Activity",
  reference: "Reference",
  tools: "Tools",
  settings: "Settings",
  manual: "User Manual",
};

function App() {
  const panels = listPanels();
  const [activeTab, setActiveTab] = useState<PanelCategory>("dashboard");
  // Defaults true (Tactical Mode) matching the backend's own default, so
  // hobbyist panels don't flash into view for a frame while the real
  // value loads.
  const [tacticalMode, setTacticalMode] = useState(true);

  useEffect(() => {
    startRulesEngine();
  }, []);

  const visible = tacticalMode ? panels.filter((p) => !p.hobbyist) : panels;
  const tabs = TAB_ORDER.filter((cat) => visible.some((p) => p.category === cat));
  const visiblePanels = visible.filter((p) => p.category === activeTab);

  return (
    <div className="shell">
      <FirstRunWizard onFinished={() => {}} />
      <nav className="sidebar">
        <div className="sidebar-brand">
          <h1>Waystation</h1>
        </div>

        <div className="sidebar-nav">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              className={`sidebar-link ${activeTab === tab ? "sidebar-link-active" : ""}`}
              onClick={() => setActiveTab(tab)}
            >
              {TAB_LABELS[tab]}
            </button>
          ))}
        </div>

        <div className="sidebar-footer">
          <TacticalModeToggle onChange={setTacticalMode} />
          <OfflineToggle />
          <ConnectivityBadge />
        </div>
      </nav>

      <div className="shell-main">
        <div className="shell-topbar">
          <TimeBar />
          <StatusLights />
        </div>

        <main className="panel-grid">
          {visiblePanels.map((panel) => {
            const PanelComponent = panel.component;
            return (
              <section
                key={panel.id}
                className="panel"
                aria-label={panel.title}
                data-width={panel.width ?? "standard"}
                data-height={panel.height ?? "standard"}
              >
                <h2 className="panel-title">{panel.title}</h2>
                <PanelComponent />
              </section>
            );
          })}
        </main>
      </div>
    </div>
  );
}

export default App;
