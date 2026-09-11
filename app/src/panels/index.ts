import { registerPanel } from "./registry";
import StationIdentityPanel from "./StationIdentityPanel";
import AppearancePanel from "./AppearancePanel";
import RequiredSoftwarePanel from "./RequiredSoftwarePanel";
import WorldMapPanel from "./WorldMapPanel";
import MessagingPanel from "./MessagingPanel";
import IncidentOpsPanel from "./IncidentOpsPanel";
import TacticalMapPanel from "./TacticalMapPanel";
import ActivityPanel from "./ActivityPanel";
import SpectrumReferencePanel from "./SpectrumReferencePanel";
import ChannelDirectoryPanel from "./ChannelDirectoryPanel";
import BearingDistancePanel from "./BearingDistancePanel";
import BandPlanPanel from "./BandPlanPanel";
import AntennaCalculatorPanel from "./AntennaCalculatorPanel";
import DecibelCalculatorPanel from "./DecibelCalculatorPanel";
import SwrCalculatorPanel from "./SwrCalculatorPanel";
import RfSafetyPanel from "./RfSafetyPanel";
import RepeaterLookupPanel from "./RepeaterLookupPanel";
import WebSdrPanel from "./WebSdrPanel";
import ContestCalendarPanel from "./ContestCalendarPanel";
import DxClusterPanel from "./DxClusterPanel";
import FlightTrackingPanel from "./FlightTrackingPanel";
import ScannerPanel from "./ScannerPanel";
import WeatherPanel from "./WeatherPanel";
import AboutPanel from "./AboutPanel";
import DiagnosticsPanel from "./DiagnosticsPanel";
import FieldReferencePanel from "./FieldReferencePanel";
import RigControlPanel from "./RigControlPanel";
import RotatorControlPanel from "./RotatorControlPanel";
import UserManualPanel from "./UserManualPanel";
import SyncPanel from "./SyncPanel";

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

registerPanel({
  id: "rig-control",
  title: "Rig Control",
  category: "tools",
  refreshCadenceSeconds: 2,
  offlineBehavior: "always-available",
  width: "wide",
  height: "natural",
  component: RigControlPanel,
});

registerPanel({
  id: "rotator-control",
  title: "Rotator Control",
  category: "tools",
  refreshCadenceSeconds: 2,
  offlineBehavior: "always-available",
  width: "wide",
  height: "natural",
  component: RotatorControlPanel,
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

registerPanel({
  id: "spectrum-reference",
  title: "Spectrum Reference",
  category: "reference",
  refreshCadenceSeconds: null,
  offlineBehavior: "always-available",
  height: "tall",
  component: SpectrumReferencePanel,
});

registerPanel({
  id: "band-plan",
  title: "Band Plan",
  category: "reference",
  refreshCadenceSeconds: null,
  offlineBehavior: "always-available",
  height: "tall",
  component: BandPlanPanel,
});

registerPanel({
  id: "bearing-distance",
  title: "Bearing & Distance",
  category: "tools",
  refreshCadenceSeconds: null,
  offlineBehavior: "always-available",
  component: BearingDistancePanel,
});

registerPanel({
  id: "antenna-calculator",
  title: "Antenna Length Calculator",
  category: "tools",
  refreshCadenceSeconds: null,
  offlineBehavior: "always-available",
  width: "wide",
  component: AntennaCalculatorPanel,
});

registerPanel({
  id: "decibel-calculator",
  title: "dB Calculator",
  category: "tools",
  refreshCadenceSeconds: null,
  offlineBehavior: "always-available",
  width: "wide",
  component: DecibelCalculatorPanel,
});

registerPanel({
  id: "swr-calculator",
  title: "SWR / Impedance Calculator",
  category: "tools",
  refreshCadenceSeconds: null,
  offlineBehavior: "always-available",
  width: "wide",
  component: SwrCalculatorPanel,
});

registerPanel({
  id: "rf-safety",
  title: "RF Power Density Calculator",
  category: "tools",
  refreshCadenceSeconds: null,
  offlineBehavior: "always-available",
  width: "wide",
  height: "natural",
  component: RfSafetyPanel,
});

registerPanel({
  id: "repeater-lookup",
  title: "Repeater Lookup",
  category: "reference",
  refreshCadenceSeconds: null,
  offlineBehavior: "internet-only",
  width: "wide",
  component: RepeaterLookupPanel,
});

registerPanel({
  id: "websdr-directory",
  title: "WebSDR Directory",
  category: "reference",
  refreshCadenceSeconds: null,
  offlineBehavior: "internet-only",
  width: "full",
  height: "natural",
  component: WebSdrPanel,
});

registerPanel({
  id: "channel-directory",
  title: "Channel Directory",
  category: "reference",
  refreshCadenceSeconds: null,
  offlineBehavior: "always-available",
  width: "full",
  height: "natural",
  component: ChannelDirectoryPanel,
});

registerPanel({
  id: "field-reference",
  title: "Field Reference (Kiwix Library Search)",
  category: "reference",
  refreshCadenceSeconds: null,
  offlineBehavior: "degrades",
  width: "full",
  height: "tall",
  component: FieldReferencePanel,
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


registerPanel({
  id: "station-identity",
  title: "Station",
  category: "settings",
  refreshCadenceSeconds: null,
  offlineBehavior: "always-available",
  width: "wide",
  height: "natural",
  component: StationIdentityPanel,
});

registerPanel({
  id: "appearance",
  title: "Appearance",
  category: "settings",
  refreshCadenceSeconds: null,
  offlineBehavior: "always-available",
  component: AppearancePanel,
});

registerPanel({
  id: "required-software",
  title: "Required Software",
  category: "settings",
  refreshCadenceSeconds: null,
  offlineBehavior: "always-available",
  width: "wide",
  height: "natural",
  component: RequiredSoftwarePanel,
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

registerPanel({
  id: "diagnostics",
  title: "Diagnostics",
  category: "settings",
  refreshCadenceSeconds: 15,
  offlineBehavior: "always-available",
  width: "wide",
  height: "natural",
  component: DiagnosticsPanel,
});

registerPanel({
  id: "sync",
  title: "Peer Sync",
  category: "settings",
  refreshCadenceSeconds: null,
  offlineBehavior: "always-available",
  width: "wide",
  height: "natural",
  component: SyncPanel,
});

registerPanel({
  id: "about",
  title: "About",
  category: "settings",
  refreshCadenceSeconds: null,
  offlineBehavior: "always-available",
  height: "natural",
  component: AboutPanel,
});

export { listPanels } from "./registry";
export type { PanelDefinition, OfflineBehavior, PanelCategory } from "./types";
