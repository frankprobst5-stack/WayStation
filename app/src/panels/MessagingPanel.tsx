import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import MeshPanel from "./MeshPanel";
import MessagesPanel from "./MessagesPanel";
import NetControlPanel from "./NetControlPanel";
import WinlinkPanel from "./WinlinkPanel";
import Js8CallPanel from "./Js8CallPanel";
import PacketPanel from "./PacketPanel";

// Consolidates six panels that used to each show up as their own separate
// stacked tile under the "messaging" sidebar category into one tabbed
// page, matching the Messaging mockup's unified comms center. Same
// treatment WeatherPanel and ActivityPanel already got -- every tab embeds
// the real existing panel component unchanged.
//
// Two things the mockup shows that genuinely don't exist yet, called out
// honestly on the Overview instead of faked: named/labeled channels
// spanning transports (Meshtastic only has numbered channels 0-7 today,
// not "Pine Ridge Incident" or "Field Team Alpha"), and message templates
// / preset quick-messages (no template storage anywhere in the backend).

const TABS = ["Overview", "Mesh (Meshtastic)", "Messages (ICS-213/309)", "Net Control", "Winlink", "JS8Call", "Packet (APRS/Direwolf)"] as const;
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
    invoke<MeshStatus>("get_mesh_status").then(setMesh);
    invoke<WinlinkStatus>("get_winlink_status").then(setWinlink);
    invoke<Js8CallStatus>("get_js8call_status").then(setJs8);
    invoke<DirewolfStatus>("get_direwolf_status").then(setPacket);
    invoke<RosterEntry[]>("get_net_roster").then(setRoster);
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
            <h3>Not built yet</h3>
          </div>
          <div className="bandplan-disclaimer">
            Two things the mockup for this page shows that don't exist here yet: named channels spanning transports
            (Meshtastic only has numbered channels 0–7 today, not "Pine Ridge Incident" or "Field Team Alpha"), and
            message templates / preset quick-messages (no template storage anywhere in the backend). Flagged here
            rather than faked.
          </div>
        </div>
      </div>
    </div>
  );
}

function MessagingPanel() {
  const [tab, setTab] = useState<Tab>("Overview");
  // Mesh and Winlink both have real Settings > Modules toggles now
  // (2026-09-25) -- each hides its own tab here when off, the same way
  // Tactical Mode already hides hobbyist panels from the sidebar.
  // JS8Call/Packet don't have their own toggle yet (see ModulesPanel.tsx's
  // own note on why), so their tabs stay unconditional.
  const [meshEnabled, setMeshEnabled] = useState(true);
  const [winlinkEnabled, setWinlinkEnabled] = useState(true);

  useEffect(() => {
    invoke<{ mesh_enabled: boolean; winlink_enabled: boolean }>("get_station_profile").then((p) => {
      setMeshEnabled(p.mesh_enabled);
      setWinlinkEnabled(p.winlink_enabled);
    });
  }, []);

  const visibleTabs = TABS.filter((t) => (meshEnabled || t !== "Mesh (Meshtastic)") && (winlinkEnabled || t !== "Winlink"));
  useEffect(() => {
    if (!meshEnabled && tab === "Mesh (Meshtastic)") setTab("Overview");
    if (!winlinkEnabled && tab === "Winlink") setTab("Overview");
  }, [meshEnabled, winlinkEnabled, tab]);

  return (
    <div className="panel-weather">
      <p className="sync-lede">
        Unified communications center across every transport Waystation supports — without pretending they all
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
      </div>
    </div>
  );
}

export default MessagingPanel;
