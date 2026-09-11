import { registerPanel } from "./registry";
import SettingsPanel from "./SettingsPanel";
import WorldMapPanel from "./WorldMapPanel";
import MessagingPanel from "./MessagingPanel";
import IncidentOpsPanel from "./IncidentOpsPanel";
import TacticalMapPanel from "./TacticalMapPanel";
import ActivityPanel from "./ActivityPanel";
import ReferencePanel from "./ReferencePanel";
import ToolsPanel from "./ToolsPanel";
import ContestCalendarPanel from "./ContestCalendarPanel";
import DxClusterPanel from "./DxClusterPanel";
import FlightTrackingPanel from "./FlightTrackingPanel";
import ScannerPanel from "./ScannerPanel";
import WeatherPanel from "./WeatherPanel";
import UserManualPanel from "./UserManualPanel";

registerPanel({
  id: "world-map",
  title: "World Map",
  category: "tactical-map",
  refreshCadenceSeconds: 60,
  offlineBehavior: "always-available",
  width: "full",
  height: "natural",
  component: WorldMapPanel,
});

// Consolidates seven panels that used to each register separately (Rig
// Control, Rotator Control, Bearing & Distance, Antenna Length, dB, SWR/
// Impedance, and RF Power Density further below) into one tabbed page --
// see ToolsPanel.tsx. Every real panel component is reused unchanged.
registerPanel({
  id: "tools",
  title: "Tools",
  category: "tools",
  refreshCadenceSeconds: null,
  offlineBehavior: "always-available",
  width: "full",
  height: "natural",
  component: ToolsPanel,
});

// Consolidates six panels that used to each register separately (Active
// Alerts, Situation Summary, Incidents, Personnel, Resource Requests, and
// Resources further below) into one tabbed page -- see
// IncidentOpsPanel.tsx. Every real panel component is reused unchanged.
registerPanel({
  id: "incident-ops",
  title: "Incident Ops",
  category: "incident-ops",
  refreshCadenceSeconds: null,
  offlineBehavior: "degrades",
  width: "full",
  height: "natural",
  component: IncidentOpsPanel,
});

registerPanel({
  id: "tactical-map",
  title: "Tactical Map",
  category: "tactical-map",
  refreshCadenceSeconds: null,
  offlineBehavior: "degrades",
  width: "full",
  height: "tall",
  component: TacticalMapPanel,
});

// Consolidates six panels that used to each register separately (Net
// Control, Messages, Winlink, JS8Call, Packet/APRS, and Mesh further
// below) into one tabbed page -- see MessagingPanel.tsx. Every real panel
// component is reused unchanged.
registerPanel({
  id: "messaging",
  title: "Messaging",
  category: "messaging",
  refreshCadenceSeconds: null,
  offlineBehavior: "degrades",
  width: "full",
  height: "natural",
  component: MessagingPanel,
});

// Consolidates what used to be seven separately-registered panels (Space
// Weather, POTA Spots, Satellite Passes, Reception Reports, DX Cluster,
// Contest Calendar, QSO Log) into one tabbed page -- see ActivityPanel.tsx.
// Each real panel component is still used unchanged, just given a shared
// home instead of stacking as separate tiles under this same category.
registerPanel({
  id: "activity",
  title: "Activity",
  category: "activity",
  refreshCadenceSeconds: null,
  offlineBehavior: "degrades",
  width: "full",
  height: "natural",
  component: ActivityPanel,
});

// Consolidates six panels that used to each register separately (Spectrum
// Reference, Band Plan, Repeater Lookup, WebSDR Directory, Channel
// Directory, and Field Reference) into one tabbed page -- see
// ReferencePanel.tsx. Every real panel component is reused unchanged.
registerPanel({
  id: "reference",
  title: "Reference",
  category: "reference",
  refreshCadenceSeconds: null,
  offlineBehavior: "degrades",
  width: "full",
  height: "natural",
  component: ReferencePanel,
});

// Kept as separate, hobbyist-flagged registrations (not folded into
// ActivityPanel's tabs) specifically so Tactical Mode's existing
// `panels.filter(p => !p.hobbyist)` still hides them -- folding these into
// an internal tab would have made them inescapable even in Tactical Mode,
// since that filter only ever runs at the top-level registry, not inside
// a panel's own tab switcher. Also matches the actual mockup, which never
// listed DX Cluster or Contest Calendar as Activity tabs to begin with.
registerPanel({
  id: "contest-calendar",
  title: "Contest Calendar",
  category: "activity",
  refreshCadenceSeconds: 6 * 3600,
  offlineBehavior: "degrades",
  height: "tall",
  hobbyist: true,
  component: ContestCalendarPanel,
});

registerPanel({
  id: "dx-cluster",
  title: "DX Cluster",
  category: "activity",
  refreshCadenceSeconds: null,
  offlineBehavior: "internet-only",
  height: "tall",
  hobbyist: true,
  component: DxClusterPanel,
});

registerPanel({
  id: "flight-tracking",
  title: "Flight Tracking (ADS-B)",
  category: "flight-tracking",
  refreshCadenceSeconds: 5 * 60,
  offlineBehavior: "internet-only",
  width: "full",
  height: "tall",
  component: FlightTrackingPanel,
});

registerPanel({
  id: "scanner",
  title: "Trunked Scanner (P25)",
  category: "scanner",
  refreshCadenceSeconds: null,
  offlineBehavior: "degrades",
  height: "natural",
  width: "full",
  component: ScannerPanel,
});

registerPanel({
  id: "weather",
  title: "Weather",
  category: "weather",
  refreshCadenceSeconds: 5 * 60,
  offlineBehavior: "internet-only",
  width: "full",
  height: "natural",
  component: WeatherPanel,
});


// Consolidates six panels that used to each register separately (Station,
// Appearance, Required Software, Diagnostics, Peer Sync, and About) into
// one tabbed page -- see SettingsPanel.tsx. Every real panel component is
// reused unchanged.
registerPanel({
  id: "settings",
  title: "Settings",
  category: "settings",
  refreshCadenceSeconds: null,
  offlineBehavior: "always-available",
  width: "full",
  height: "natural",
  component: SettingsPanel,
});

registerPanel({
  id: "user-manual",
  title: "User Manual",
  category: "manual",
  refreshCadenceSeconds: null,
  offlineBehavior: "always-available",
  width: "full",
  height: "natural",
  component: UserManualPanel,
});

export { listPanels } from "./registry";
export type { PanelDefinition, OfflineBehavior, PanelCategory } from "./types";
