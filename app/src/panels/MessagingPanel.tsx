import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import MeshPanel from "./MeshPanel";
import MessagesPanel from "./MessagesPanel";
import NetControlPanel from "./NetControlPanel";
import WinlinkPanel from "./WinlinkPanel";
import Js8CallPanel from "./Js8CallPanel";
import PacketPanel from "./PacketPanel";
import QrTransportPanel from "./QrTransportPanel";
import CotPanel from "./CotPanel";
import NamedChannelsPanel from "./NamedChannelsPanel";
import MessageTemplatesPanel from "./MessageTemplatesPanel";

// Consolidates six panels that used to each show up as their own separate
// stacked tile under the "messaging" sidebar category into one tabbed
// page, matching the Messaging mockup's unified comms center. Same
// treatment WeatherPanel and ActivityPanel already got -- every tab embeds
// the real existing panel component unchanged.
//
// Named Channels and Templates are real now (2026-11-23): an operator-
// given name resolves to whichever per-transport value applies (today,
// just Meshtastic's numbered channel -- Winlink/JS8Call already address
// by callsign), and templates are real saved text an operator can
// quick-fill into Mesh's compose box.

const TABS = [
  "Overview",
  "Mesh (Meshtastic)",
  "Messages (ICS-213/309)",
  "Net Control",
  "Winlink",
  "JS8Call",
  "Packet (APRS/Direwolf)",
  "QR Code",
  "ATAK/CoT",
  "Named Channels",
  "Templates",
] as const;
type Tab = (typeof TABS)[number];

interface MeshStatus { connected: boolean }
interface WinlinkStatus { binary_found: boolean; process_running: boolean; api_reachable: boolean; foreign_process: boolean }
interface Js8CallStatus { reachable: boolean }
interface DirewolfStatus { binary_found: boolean; process_running: boolean; agw_reachable: boolean }
interface RosterEntry { status: string }

function StatusTile({ label, ok, detail, onClick }: { label: string; ok: boolean | null; detail: string; onClick: () => void }) {
  const dotClass = ok === null ? "gray" : ok ? "green" : "red";
  return (
    <div className="supply-item" onClick={onClick} style={{ cursor: "pointer" }}>
      <span className={`dot dot-${dotClass}`} />
      <span className="name">{label}</span>
      <span className="count">{detail}</span>
    </div>
  );
}

function OverviewTab({ goTo }: { goTo: (t: Tab) => void }) {
  const [mesh, setMesh] = useState<MeshStatus | null>(null);
  const [winlink, setWinlink] = useState<WinlinkStatus | null>(null);
  const [js8, setJs8] = useState<Js8CallStatus | null>(null);
  const [packet, setPacket] = useState<DirewolfStatus | null>(null);
  const [roster, setRoster] = useState<RosterEntry[] | null>(null);

  useEffect(() => {
    // Real bug found live 2026-10-09 (same file-wide sweep): no catch on
    // any of these -- each status tile below renders "Loading..." as
    // long as its own state stays null, so a failure here leaves that
    // tile stuck showing "Loading..." forever instead of an honest
    // disconnected/unknown state.
    invoke<MeshStatus>("get_mesh_status").then(setMesh).catch((err) => console.error("get_mesh_status failed:", err));
    invoke<WinlinkStatus>("get_winlink_status").then(setWinlink).catch((err) => console.error("get_winlink_status failed:", err));
    invoke<Js8CallStatus>("get_js8call_status").then(setJs8).catch((err) => console.error("get_js8call_status failed:", err));
    invoke<DirewolfStatus>("get_direwolf_status").then(setPacket).catch((err) => console.error("get_direwolf_status failed:", err));
    invoke<RosterEntry[]>("get_net_roster").then(setRoster).catch((err) => console.error("get_net_roster failed:", err));
  }, []);

  const checkedIn = roster?.filter((r) => r.status === "checked_in").length ?? 0;

  return (
    <div>
      <div className="supply-panel" style={{ marginBottom: "1rem" }}>
        <div className="supply-panel-head">Transport Status — click to open</div>
        <div className="supply-strip">
          <StatusTile label="Mesh" ok={mesh?.connected ?? null} detail={mesh?.connected ? "Connected" : mesh ? "Disconnected" : "Loading..."} onClick={() => goTo("Mesh (Meshtastic)")} />
          <StatusTile
            label="Winlink"
            ok={winlink ? winlink.process_running && !winlink.foreign_process : null}
            detail={!winlink ? "Loading..." : !winlink.binary_found ? "Pat not installed" : winlink.foreign_process ? "Foreign process" : winlink.process_running ? "Running" : "Not running"}
            onClick={() => goTo("Winlink")}
          />
          <StatusTile label="JS8Call" ok={js8?.reachable ?? null} detail={js8?.reachable ? "Reachable" : js8 ? "Not reachable" : "Loading..."} onClick={() => goTo("JS8Call")} />
          <StatusTile
            label="APRS / Direwolf"
            ok={packet ? packet.process_running && packet.agw_reachable : null}
            detail={!packet ? "Loading..." : !packet.binary_found ? "Not installed" : packet.process_running ? "Running" : "Stopped"}
            onClick={() => goTo("Packet (APRS/Direwolf)")}
          />
        </div>
      </div>

      <div className="weather-overview-grid">
        <div className="sync-section">
          <div className="sync-section-head">
            <h3>Net Control</h3>
            <button type="button" className="weather-link-btn" onClick={() => goTo("Net Control")}>
              View Full
            </button>
          </div>
          <div className="alert-card">
            <div className="alert-area">{roster === null ? "Loading..." : `${checkedIn} station${checkedIn === 1 ? "" : "s"} checked in`}</div>
          </div>
        </div>

        <div className="sync-section">
          <div className="sync-section-head">
            <h3>Mesh (Meshtastic)</h3>
            <button type="button" className="weather-link-btn" onClick={() => goTo("Mesh (Meshtastic)")}>
              Open Chat
            </button>
          </div>
          <div className="alert-card">
            <div className="alert-area">The main live-chat-style workspace — channels, direct messages, and node health.</div>
          </div>
        </div>

        <div className="sync-section">
          <div className="sync-section-head">
            <h3>Messages (ICS-213 / ICS-309)</h3>
            <button type="button" className="weather-link-btn" onClick={() => goTo("Messages (ICS-213/309)")}>
              View Full
            </button>
          </div>
          <div className="alert-card">
            <div className="alert-area">Formal traffic log, dispatched across whichever transport can reach the recipient.</div>
          </div>
        </div>

        <div className="sync-section">
          <div className="sync-section-head">
            <h3>Named Channels</h3>
            <button type="button" className="weather-link-btn" onClick={() => goTo("Named Channels")}>
              View Full
            </button>
          </div>
          <div className="alert-card">
            <div className="alert-area">Give a group a real name once, reuse it across whichever transport you're on.</div>
          </div>
        </div>

        <div className="sync-section">
          <div className="sync-section-head">
            <h3>Templates</h3>
            <button type="button" className="weather-link-btn" onClick={() => goTo("Templates")}>
              View Full
            </button>
          </div>
          <div className="alert-card">
            <div className="alert-area">Saved quick-messages, pickable from Mesh's own compose box.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Maps each transport's own tab name to the station_profile field that
// gates it -- all four local-hardware transports now have a real Settings
// > Modules toggle (2026-09-25), each hiding its own tab here when off,
// the same way Tactical Mode already hides hobbyist panels from the
// sidebar. "Overview"/"Messages (ICS-213/309)"/"Net Control" aren't tied
// to any one module, so they're absent from this map and always visible.
const TAB_MODULE_FIELD: Partial<Record<Tab, keyof StationProfileTransportFields>> = {
  "Mesh (Meshtastic)": "mesh_enabled",
  Winlink: "winlink_enabled",
  JS8Call: "js8call_enabled",
  "Packet (APRS/Direwolf)": "packet_enabled",
  "ATAK/CoT": "cot_enabled",
};

interface StationProfileTransportFields {
  mesh_enabled: boolean;
  winlink_enabled: boolean;
  js8call_enabled: boolean;
  packet_enabled: boolean;
  cot_enabled: boolean;
}

function MessagingPanel() {
  const [tab, setTab] = useState<Tab>("Overview");
  const [enabled, setEnabled] = useState<StationProfileTransportFields>({
    mesh_enabled: true,
    winlink_enabled: true,
    js8call_enabled: true,
    packet_enabled: true,
    // Real default is off (see db.rs migration v58) -- this is a new
    // network listener nothing asked for until an operator opts in via
    // Settings -> Modules, unlike the other transports above.
    cot_enabled: false,
  });

  useEffect(() => {
    // Real bug found live 2026-10-09 (same file-wide sweep): no catch --
    // fails open to the existing all-true defaults on failure, harmless,
    // but still worth logging rather than an unhandled rejection.
    invoke<StationProfileTransportFields>("get_station_profile")
      .then(setEnabled)
      .catch((err) => console.error("get_station_profile failed:", err));
  }, []);

  const visibleTabs = TABS.filter((t) => {
    const field = TAB_MODULE_FIELD[t];
    return !field || enabled[field];
  });
  useEffect(() => {
    const field = TAB_MODULE_FIELD[tab];
    if (field && !enabled[field]) setTab("Overview");
  }, [enabled, tab]);

  return (
    <div className="panel-weather">
      <p className="sync-lede">
        Unified communications center across every transport WayStation supports — without pretending they all
        behave like the same kind of chat.
      </p>

      <div className="panel-tabs">
        {visibleTabs.map((t) => (
          <button key={t} type="button" className={t === tab ? "panel-tab-btn active" : "panel-tab-btn"} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      <div className="panel-tab-content">
        {tab === "Overview" && <OverviewTab goTo={setTab} />}
        {tab === "Mesh (Meshtastic)" && <MeshPanel />}
        {tab === "Messages (ICS-213/309)" && <MessagesPanel />}
        {tab === "Net Control" && <NetControlPanel />}
        {tab === "Winlink" && <WinlinkPanel />}
        {tab === "JS8Call" && <Js8CallPanel />}
        {tab === "Packet (APRS/Direwolf)" && <PacketPanel />}
        {tab === "QR Code" && <QrTransportPanel />}
        {tab === "ATAK/CoT" && <CotPanel />}
        {tab === "Named Channels" && <NamedChannelsPanel />}
        {tab === "Templates" && <MessageTemplatesPanel />}
      </div>
    </div>
  );
}

export default MessagingPanel;
