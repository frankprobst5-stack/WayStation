import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useConnectivity } from "./connectivity/useConnectivity";
import type { PanelCategory } from "./panels";
import TacticalMapPanel from "./panels/TacticalMapPanel";

// Every interface below mirrors a real Rust struct byte-for-byte (see the
// cited source file) -- this page renders nothing that isn't already a
// real command's real return value.

interface StationProfile {
  callsign: string | null;
}

// db::IncidentInfo
interface IncidentInfo {
  incident_name: string | null;
  operational_period: string | null;
  net_frequency: string | null;
  net_status: string | null;
  updated_at: string | null;
}

// db::TrafficCounts
interface TrafficCounts {
  emergency: number;
  immediate: number;
  priority: number;
  routine: number;
  checked_in: number;
}

// db::ActivityEntry
interface ActivityEntry {
  occurred_at: string;
  summary: string;
}

// system_health::SystemHealthSnapshot
interface SystemHealthSnapshot {
  cpu_percent: number;
  memory_percent: number;
  memory_used_mb: number;
  memory_total_mb: number;
  disk_percent: number | null;
  disk_used_gb: number | null;
  disk_total_gb: number | null;
  temperature_c: number | null;
}

// rig::RigStatus
interface RigStatus {
  reachable: boolean;
  enabled: boolean;
  target: string;
  frequency_hz: number | null;
  mode: string | null;
  strength_db: number | null;
}

// rotator::RotatorStatus
interface RotatorStatus {
  reachable: boolean;
  enabled: boolean;
  azimuth_deg: number | null;
  elevation_deg: number | null;
}

// db::SpaceWeather
interface SpaceWeather {
  fetched_at: string | null;
  solar_flux: number | null;
  a_index: number | null;
  k_index: number | null;
  band_conditions: string | null;
}
interface BandCondition {
  name: string;
  time: string;
  condition: string;
}

// db::LocalWeatherObservation
interface LocalWeatherObservation {
  fetched_at: string | null;
  source: string | null;
  temperature_f: number | null;
  humidity_pct: number | null;
  wind_speed_mph: number | null;
  wind_direction_deg: number | null;
  pressure_inhg: number | null;
}

// db::Channel
interface Channel {
  id: number;
  label: string;
  frequency: string;
  tone_offset: string | null;
}

// citadel_scanner::ScannerStatus
interface ScannerStatus {
  status: string;
}

function StatusChip({ label, state }: { label: string; state: "good" | "bad" | "warn" | "off" }) {
  const text = state === "good" ? "Online" : state === "bad" ? "Offline" : state === "warn" ? "Degraded" : "Unknown";
  return (
    <div className="dash-status-chip">
      <div className="dash-status-chip-top">
        <span className="dash-status-chip-label">{label}</span>
        <span className={`dash-dot dash-dot-${state}`} />
      </div>
      <span className={`dash-status-chip-value dash-status-chip-value-${state}`}>{text}</span>
    </div>
  );
}

function healthState(status: string | undefined): "good" | "bad" | "warn" | "off" {
  if (status === "healthy") return "good";
  if (status === "down") return "bad";
  if (status === "degraded") return "warn";
  return "off";
}

function DashboardPage({ onNavigate }: { onNavigate: (tab: PanelCategory) => void }) {
  const connectivity = useConnectivity();
  const [profile, setProfile] = useState<StationProfile | null>(null);
  const [incidentInfo, setIncidentInfo] = useState<IncidentInfo | null>(null);
  const [traffic, setTraffic] = useState<TrafficCounts | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);
  const [health, setHealth] = useState<SystemHealthSnapshot | null>(null);
  const [rig, setRig] = useState<RigStatus | null>(null);
  const [rotator, setRotator] = useState<RotatorStatus | null>(null);
  const [spaceWeather, setSpaceWeather] = useState<SpaceWeather | null>(null);
  const [localWeather, setLocalWeather] = useState<LocalWeatherObservation | null>(null);
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [scanner, setScanner] = useState<ScannerStatus | null>(null);

  useEffect(() => {
    invoke<StationProfile>("get_station_profile").then(setProfile);
    invoke<Channel[]>("get_channels").then(setChannels);

    const refreshIncident = () => {
      invoke<IncidentInfo>("get_incident_info").then(setIncidentInfo);
      invoke<TrafficCounts>("get_traffic_counts").then(setTraffic);
    };
    const refreshActivity = () => invoke<ActivityEntry[]>("get_recent_activity").then(setActivity);
    const refreshRig = () => invoke<RigStatus>("get_rig_status").then(setRig);
    const refreshRotator = () => invoke<RotatorStatus>("get_rotator_status").then(setRotator);
    const refreshScanner = () =>
      invoke<ScannerStatus>("get_citadel_scanner_status")
        .then(setScanner)
        .catch(() => setScanner(null));

    refreshIncident();
    refreshActivity();
    refreshRig();
    refreshRotator();
    refreshScanner();
    invoke<SystemHealthSnapshot | null>("get_system_health").then(setHealth);
    invoke<SpaceWeather>("get_space_weather").then(setSpaceWeather);
    invoke<LocalWeatherObservation>("get_local_weather_observation").then(setLocalWeather);

    const incidentTimer = setInterval(refreshIncident, 30_000);
    const activityTimer = setInterval(refreshActivity, 15_000);
    const rigTimer = setInterval(refreshRig, 3_000);
    const rotatorTimer = setInterval(refreshRotator, 3_000);
    const scannerTimer = setInterval(refreshScanner, 20_000);

    let unlistenHealth: (() => void) | undefined;
    let unlistenSpaceWeather: (() => void) | undefined;
    let unlistenLocalWeather: (() => void) | undefined;
    listen<void>("system-health-changed", () => invoke<SystemHealthSnapshot | null>("get_system_health").then(setHealth)).then((fn) => (unlistenHealth = fn));
    listen<void>("space-weather-changed", () => invoke<SpaceWeather>("get_space_weather").then(setSpaceWeather)).then((fn) => (unlistenSpaceWeather = fn));
    listen<void>("local-weather-changed", () => invoke<LocalWeatherObservation>("get_local_weather_observation").then(setLocalWeather)).then(
      (fn) => (unlistenLocalWeather = fn),
    );

    return () => {
      clearInterval(incidentTimer);
      clearInterval(activityTimer);
      clearInterval(rigTimer);
      clearInterval(rotatorTimer);
      clearInterval(scannerTimer);
      unlistenHealth?.();
      unlistenSpaceWeather?.();
      unlistenLocalWeather?.();
    };
  }, []);

  const source = (id: string) => connectivity?.sources.find((s) => s.source_id === id);
  const internetState: "good" | "bad" | "warn" | "off" =
    connectivity?.overall === "online" ? "good" : connectivity?.overall === "degraded" ? "warn" : connectivity?.overall === "rf_only" ? "bad" : "off";
  const scannerState: "good" | "bad" | "warn" | "off" =
    scanner?.status === "listening" || scanner?.status === "ok" ? "good" : scanner?.status === "error" ? "bad" : "off";

  const bandConditions: BandCondition[] = spaceWeather?.band_conditions ? JSON.parse(spaceWeather.band_conditions) : [];

  return (
    <div className="dash-main">
      {/* Row 1 -- operational status */}
      <section className="dash-row-status">
        <div className="dash-panel">
          <div className="dash-panel-head">
            <span className="dash-panel-title">Operational Status</span>
          </div>
          <div className="dash-status-strip">
            <StatusChip label="Radio" state={healthState(source("rigctl")?.status)} />
            <StatusChip label="Rotator" state={healthState(source("rotctl")?.status)} />
            <StatusChip label="Winlink" state={healthState(source("winlink-pat")?.status)} />
            <StatusChip label="JS8Call" state={healthState(source("js8call")?.status)} />
            <StatusChip label="Mesh" state={healthState(source("meshtastic")?.status)} />
            <StatusChip label="Scanner" state={scannerState} />
            <StatusChip label="Internet" state={internetState} />
          </div>
        </div>
        <div className="dash-panel">
          <div className="dash-panel-head">
            <span className="dash-panel-title">System Health</span>
          </div>
          {health ? (
            <div className="dash-health-bars">
              <div className="dash-health-row">
                <span>CPU</span>
                <div className="dash-health-track">
                  <div className="dash-health-fill" style={{ width: `${Math.min(100, health.cpu_percent)}%` }} />
                </div>
                <span className="mono">{health.cpu_percent.toFixed(0)}%</span>
              </div>
              <div className="dash-health-row">
                <span>MEM</span>
                <div className="dash-health-track">
                  <div className="dash-health-fill" style={{ width: `${Math.min(100, health.memory_percent)}%` }} />
                </div>
                <span className="mono">{health.memory_percent.toFixed(0)}%</span>
              </div>
              {health.disk_percent !== null && (
                <div className="dash-health-row">
                  <span>DISK</span>
                  <div className="dash-health-track">
                    <div className="dash-health-fill" style={{ width: `${Math.min(100, health.disk_percent)}%` }} />
                  </div>
                  <span className="mono">{health.disk_percent.toFixed(0)}%</span>
                </div>
              )}
              {health.temperature_c !== null && (
                <div className="dash-health-row">
                  <span>TEMP</span>
                  <div className="dash-health-track">
                    <div className="dash-health-fill" style={{ width: `${Math.min(100, (health.temperature_c / 90) * 100)}%` }} />
                  </div>
                  <span className="mono">{health.temperature_c.toFixed(0)}°C</span>
                </div>
              )}
            </div>
          ) : (
            <div className="dash-empty">Reading host telemetry...</div>
          )}
        </div>
      </section>

      {/* Row 2 -- hero: map + incident */}
      <section className="dash-row-hero">
        <div className="dash-panel dash-map-panel">
          <div className="dash-panel-head">
            <span className="dash-panel-title">Tactical Map — Live Station Activity</span>
            <button type="button" className="dash-ghost-btn" onClick={() => onNavigate("tactical-map")}>
              Full Screen
            </button>
          </div>
          <div className="dash-map-embed">
            <TacticalMapPanel />
          </div>
        </div>

        <div className="dash-panel dash-incident-panel">
          <div className="dash-panel-head">
            <span className="dash-panel-title">Incident Status</span>
            <span className={`dash-pill ${incidentInfo?.incident_name ? "dash-pill-active" : "dash-pill-standby"}`}>
              {incidentInfo?.incident_name ? "Active" : "Standby"}
            </span>
          </div>
          <dl className="dash-field-grid">
            <dt>Mode</dt>
            <dd>{incidentInfo?.incident_name ? "Incident Declared" : "Normal Operations"}</dd>
            <dt>Incident</dt>
            <dd>{incidentInfo?.incident_name ?? "None declared"}</dd>
            <dt>Operator</dt>
            <dd className="mono">{profile?.callsign ?? "Not set"}</dd>
            <dt>Op Period</dt>
            <dd className="mono">{incidentInfo?.operational_period ?? "—"}</dd>
            <dt>Net</dt>
            <dd>{incidentInfo?.net_frequency ? `${incidentInfo.net_frequency}${incidentInfo.net_status ? ` · ${incidentInfo.net_status}` : ""}` : "—"}</dd>
          </dl>
          <div className="dash-divider" />
          <div className="dash-traffic-title">Traffic</div>
          <div className="dash-traffic-row">
            <span className="dash-label">
              <span className="dash-dot dash-dot-bad" />
              Emergency
            </span>
            <span className="dash-traffic-count">{traffic?.emergency ?? 0}</span>
          </div>
          <div className="dash-traffic-row">
            <span className="dash-label">
              <span className="dash-dot dash-dot-warn" />
              Immediate
            </span>
            <span className="dash-traffic-count">{traffic?.immediate ?? 0}</span>
          </div>
          <div className="dash-traffic-row">
            <span className="dash-label">
              <span className="dash-dot dash-dot-warn" />
              Priority
            </span>
            <span className="dash-traffic-count">{traffic?.priority ?? 0}</span>
          </div>
          <div className="dash-traffic-row">
            <span className="dash-label">
              <span className="dash-dot dash-dot-good" />
              Routine
            </span>
            <span className="dash-traffic-count">{traffic?.routine ?? 0}</span>
          </div>
          <div className="dash-traffic-row">
            <span className="dash-label">
              <span className="dash-dot" style={{ background: "var(--blue, #5aa9e6)" }} />
              Check-ins
            </span>
            <span className="dash-traffic-count">{traffic?.checked_in ?? 0}</span>
          </div>
          <div className="dash-incident-actions">
            <button type="button" className="dash-primary-btn" onClick={() => onNavigate("incident-ops")}>
              ▶ Incident Ops
            </button>
          </div>
        </div>
      </section>

      {/* Row 3 -- radio / rotator / comms / activity */}
      <section className="dash-row-quad">
        <div className="dash-panel">
          <div className="dash-panel-head">
            <span className="dash-panel-title">Radio</span>
            <span className={`dash-pill ${rig?.reachable ? "dash-pill-ok" : "dash-pill-active"}`}>{rig?.reachable ? "Online" : "Offline"}</span>
          </div>
          <div className="dash-kv-row">
            <span>Target</span>
            <strong className="mono">{rig?.target || "—"}</strong>
          </div>
          <div className="dash-kv-row">
            <span>Frequency</span>
            <strong className="mono">{rig?.frequency_hz ? `${(rig.frequency_hz / 1_000_000).toFixed(4)} MHz` : "—"}</strong>
          </div>
          <div className="dash-kv-row">
            <span>Mode</span>
            <strong>{rig?.mode ?? "—"}</strong>
          </div>
          <div className="dash-kv-row">
            <span>Signal</span>
            <strong className="mono">{rig?.strength_db !== null && rig?.strength_db !== undefined ? `${rig.strength_db} dB` : "—"}</strong>
          </div>
          <div className="dash-footer-actions">
            <button type="button" className="dash-ghost-btn" onClick={() => onNavigate("tools")}>
              Open
            </button>
          </div>
        </div>

        <div className="dash-panel">
          <div className="dash-panel-head">
            <span className="dash-panel-title">Rotator</span>
            <span className={`dash-pill ${rotator?.reachable ? "dash-pill-ok" : "dash-pill-active"}`}>{rotator?.reachable ? "Online" : "Offline"}</span>
          </div>
          <div className="dash-dial">
            <span className="dash-dial-n">N</span>
            <span className="dash-dial-s">S</span>
            <span className="dash-dial-e">E</span>
            <span className="dash-dial-w">W</span>
            {rotator?.azimuth_deg !== null && rotator?.azimuth_deg !== undefined && (
              <div className="dash-dial-needle" style={{ transform: `rotate(${rotator.azimuth_deg}deg)` }} />
            )}
          </div>
          <div className="dash-kv-row">
            <span>Azimuth</span>
            <strong className="mono">{rotator?.azimuth_deg !== null && rotator?.azimuth_deg !== undefined ? `${rotator.azimuth_deg.toFixed(0)}°` : "—"}</strong>
          </div>
          <div className="dash-kv-row">
            <span>Elevation</span>
            <strong className="mono">
              {rotator?.elevation_deg !== null && rotator?.elevation_deg !== undefined ? `${rotator.elevation_deg.toFixed(0)}°` : "—"}
            </strong>
          </div>
          <div className="dash-footer-actions">
            <button type="button" className="dash-ghost-btn" onClick={() => onNavigate("tools")}>
              Open
            </button>
          </div>
        </div>

        <div className="dash-panel">
          <div className="dash-panel-head">
            <span className="dash-panel-title">Communications</span>
          </div>
          <div className="dash-comms-list">
            <div className="dash-comms-row">
              <span className={`dash-dot dash-dot-${healthState(source("winlink-pat")?.status)}`} />
              <span>Winlink</span>
              <span className="dash-via-label">RF</span>
              <button type="button" className="dash-ghost-btn" onClick={() => onNavigate("messaging")}>
                Open
              </button>
            </div>
            <div className="dash-comms-row">
              <span className={`dash-dot dash-dot-${healthState(source("js8call")?.status)}`} />
              <span>JS8Call</span>
              <span className="dash-via-label">RF</span>
              <button type="button" className="dash-ghost-btn" onClick={() => onNavigate("messaging")}>
                Open
              </button>
            </div>
            <div className="dash-comms-row">
              <span className={`dash-dot dash-dot-${healthState(source("meshtastic")?.status)}`} />
              <span>Mesh</span>
              <span className="dash-via-label">LoRa</span>
              <button type="button" className="dash-ghost-btn" onClick={() => onNavigate("messaging")}>
                Open
              </button>
            </div>
          </div>
        </div>

        <div className="dash-panel">
          <div className="dash-panel-head">
            <span className="dash-panel-title">Recent Activity</span>
          </div>
          <div className="dash-activity-list">
            {activity && activity.length > 0 ? (
              activity.map((a, i) => (
                <div className="dash-activity-row" key={i}>
                  <span className="dash-activity-time mono">{a.occurred_at.slice(11, 16)}</span>
                  <span className="dash-activity-text">{a.summary}</span>
                </div>
              ))
            ) : (
              <div className="dash-empty">No activity recorded yet.</div>
            )}
          </div>
        </div>
      </section>

      {/* Row 4 -- space weather / local weather / tactical nets */}
      <section className="dash-row-tri">
        <div className="dash-panel">
          <div className="dash-panel-head">
            <span className="dash-panel-title">Space Weather · HF Conditions</span>
          </div>
          <div className="dash-swx-grid">
            <div className="dash-swx-tile">
              <div className="dash-swx-v mono">{spaceWeather?.solar_flux ?? "—"}</div>
              <div className="dash-swx-l">SFI</div>
            </div>
            <div className="dash-swx-tile">
              <div className="dash-swx-v mono">{spaceWeather?.a_index ?? "—"}</div>
              <div className="dash-swx-l">A-Index</div>
            </div>
            <div className="dash-swx-tile">
              <div className="dash-swx-v mono">{spaceWeather?.k_index ?? "—"}</div>
              <div className="dash-swx-l">K-Index</div>
            </div>
          </div>
          {bandConditions.length > 0 && (
            <table className="dash-band-table">
              <thead>
                <tr>
                  <th>Band</th>
                  <th>Cond.</th>
                </tr>
              </thead>
              <tbody>
                {bandConditions.map((b) => (
                  <tr key={`${b.name}-${b.time}`}>
                    <td className="mono">{b.name}</td>
                    <td>{b.condition}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="dash-footer-actions">
            <button type="button" className="dash-ghost-btn" onClick={() => onNavigate("activity")}>
              View Details
            </button>
          </div>
        </div>

        <div className="dash-panel">
          <div className="dash-panel-head">
            <span className="dash-panel-title">Weather (Local)</span>
          </div>
          {localWeather?.source ? (
            <>
              <div className="dash-weather-hero">
                <div>
                  <div className="dash-weather-temp">{localWeather.temperature_f !== null ? `${localWeather.temperature_f.toFixed(0)}°F` : "—"}</div>
                  <div className="dash-weather-sub">{localWeather.source}</div>
                </div>
              </div>
              <div className="dash-kv-row">
                <span>Humidity</span>
                <strong>{localWeather.humidity_pct !== null ? `${localWeather.humidity_pct.toFixed(0)}%` : "—"}</strong>
              </div>
              <div className="dash-kv-row">
                <span>Pressure</span>
                <strong className="mono">{localWeather.pressure_inhg !== null ? `${localWeather.pressure_inhg.toFixed(2)} inHg` : "—"}</strong>
              </div>
              <div className="dash-kv-row">
                <span>Wind</span>
                <strong className="mono">
                  {localWeather.wind_speed_mph !== null ? `${localWeather.wind_speed_mph.toFixed(0)} mph` : "—"}
                  {localWeather.wind_direction_deg !== null ? ` @ ${localWeather.wind_direction_deg.toFixed(0)}°` : ""}
                </strong>
              </div>
            </>
          ) : (
            <div className="dash-empty">Not configured — set a local weather console in Settings.</div>
          )}
          <div className="dash-footer-actions">
            <button type="button" className="dash-ghost-btn" style={{ flex: 1 }} onClick={() => onNavigate("weather")}>
              View Forecast
            </button>
          </div>
        </div>

        <div className="dash-panel">
          <div className="dash-panel-head">
            <span className="dash-panel-title">Tactical Nets</span>
          </div>
          {channels && channels.length > 0 ? (
            <table className="dash-nets-table">
              <tbody>
                {channels.slice(0, 5).map((c) => (
                  <tr key={c.id}>
                    <td>{c.label}</td>
                    <td className="mono">
                      {c.frequency}
                      {c.tone_offset ? ` ${c.tone_offset}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="dash-empty">No channels configured yet.</div>
          )}
          <div className="dash-footer-actions">
            <button type="button" className="dash-ghost-btn" onClick={() => onNavigate("reference")}>
              Manage Channels
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

export default DashboardPage;
