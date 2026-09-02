import { registerPanel } from "./registry";
import StationIdentityPanel from "./StationIdentityPanel";
import RequiredSoftwarePanel from "./RequiredSoftwarePanel";
import WorldMapPanel from "./WorldMapPanel";
import AlertsPanel from "./AlertsPanel";
import NetControlPanel from "./NetControlPanel";
import MessagesPanel from "./MessagesPanel";
import IncidentInfoPanel from "./IncidentInfoPanel";
import IncidentsPanel from "./IncidentsPanel";
import TacticalMapPanel from "./TacticalMapPanel";
import ResourcesPanel from "./ResourcesPanel";
import ReadinessPanel from "./ReadinessPanel";
import WinlinkPanel from "./WinlinkPanel";
import Js8CallPanel from "./Js8CallPanel";
import SpaceWeatherPanel from "./SpaceWeatherPanel";
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
import PskReporterPanel from "./PskReporterPanel";
import PotaPanel from "./PotaPanel";
import DxClusterPanel from "./DxClusterPanel";
import AboutPanel from "./AboutPanel";
import DiagnosticsPanel from "./DiagnosticsPanel";
import RigControlPanel from "./RigControlPanel";
import RotatorControlPanel from "./RotatorControlPanel";
import UserManualPanel from "./UserManualPanel";
import SatellitePanel from "./SatellitePanel";
import QsoLogPanel from "./QsoLogPanel";
import MeshPanel from "./MeshPanel";
import SyncPanel from "./SyncPanel";

registerPanel({
  id: "world-map",
  title: "World Map",
  category: "dashboard",
  refreshCadenceSeconds: 60,
  offlineBehavior: "always-available",
  width: "full",
  height: "natural",
  component: WorldMapPanel,
});

registerPanel({
  id: "rig-control",
  title: "Rig Control",
  category: "dashboard",
  refreshCadenceSeconds: 2,
  offlineBehavior: "always-available",
  width: "wide",
  height: "natural",
  component: RigControlPanel,
});

registerPanel({
  id: "rotator-control",
  title: "Rotator Control",
  category: "dashboard",
  refreshCadenceSeconds: 2,
  offlineBehavior: "always-available",
  width: "wide",
  height: "natural",
  component: RotatorControlPanel,
});

registerPanel({
  id: "alerts",
  title: "Active Alerts",
  category: "dashboard",
  refreshCadenceSeconds: 300,
  offlineBehavior: "degrades",
  height: "tall",
  component: AlertsPanel,
});

registerPanel({
  id: "incident-info",
  title: "Situation Summary",
  category: "emcomm",
  refreshCadenceSeconds: null,
  offlineBehavior: "always-available",
  width: "full",
  height: "natural",
  component: IncidentInfoPanel,
});

registerPanel({
  id: "incidents",
  title: "Incidents",
  category: "emcomm",
  refreshCadenceSeconds: null,
  offlineBehavior: "always-available",
  width: "wide",
  height: "natural",
  component: IncidentsPanel,
});

registerPanel({
  id: "tactical-map",
  title: "Tactical Map",
  category: "emcomm",
  refreshCadenceSeconds: null,
  offlineBehavior: "degrades",
  width: "full",
  height: "tall",
  component: TacticalMapPanel,
});

registerPanel({
  id: "net-control",
  title: "Net Control",
  category: "emcomm",
  refreshCadenceSeconds: null,
  offlineBehavior: "always-available",
  width: "wide",
  height: "tall",
  component: NetControlPanel,
});

registerPanel({
  id: "messages",
  title: "Messages (ICS-213 / ICS-309)",
  category: "emcomm",
  refreshCadenceSeconds: null,
  offlineBehavior: "always-available",
  width: "wide",
  height: "natural",
  component: MessagesPanel,
});

registerPanel({
  id: "resources",
  title: "Resources",
  category: "emcomm",
  refreshCadenceSeconds: null,
  offlineBehavior: "always-available",
  component: ResourcesPanel,
});

registerPanel({
  id: "readiness",
  title: "Prepare for Offline",
  category: "emcomm",
  refreshCadenceSeconds: null,
  offlineBehavior: "always-available",
  component: ReadinessPanel,
});

registerPanel({
  id: "winlink",
  title: "Winlink",
  category: "messaging",
  refreshCadenceSeconds: 15,
  offlineBehavior: "degrades",
  component: WinlinkPanel,
});

registerPanel({
  id: "js8call",
  title: "JS8Call",
  category: "messaging",
  refreshCadenceSeconds: 15,
  offlineBehavior: "degrades",
  component: Js8CallPanel,
});

registerPanel({
  id: "space-weather",
  title: "Space Weather",
  category: "dashboard",
  refreshCadenceSeconds: 1800,
  offlineBehavior: "degrades",
  width: "wide",
  height: "natural",
  component: SpaceWeatherPanel,
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
  id: "pskreporter",
  title: "Reception Reports (PSKReporter)",
  category: "activity",
  refreshCadenceSeconds: 20 * 60,
  offlineBehavior: "internet-only",
  height: "tall",
  component: PskReporterPanel,
});

registerPanel({
  id: "pota-spots",
  title: "POTA Activator Spots",
  category: "activity",
  refreshCadenceSeconds: 5 * 60,
  offlineBehavior: "internet-only",
  height: "tall",
  component: PotaPanel,
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
  id: "satellites",
  title: "Satellite Passes",
  category: "activity",
  refreshCadenceSeconds: null,
  offlineBehavior: "internet-only",
  width: "full",
  height: "natural",
  component: SatellitePanel,
});

registerPanel({
  id: "qso-log",
  title: "QSO Log",
  category: "activity",
  refreshCadenceSeconds: null,
  offlineBehavior: "always-available",
  width: "full",
  height: "natural",
  component: QsoLogPanel,
});

registerPanel({
  id: "mesh",
  title: "Mesh (Meshtastic)",
  category: "messaging",
  refreshCadenceSeconds: null,
  offlineBehavior: "degrades",
  width: "full",
  height: "natural",
  component: MeshPanel,
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
