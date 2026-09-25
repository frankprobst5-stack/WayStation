import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import Freshness from "../staleness/Freshness";
import AlertsPanel from "./AlertsPanel";
import { buildDayStrip, feelsLikeF } from "../lib/weatherMath";
import { ONLINE_STYLE, citadelBase, citadelStyle, probeReachable } from "../lib/citadelMapStyle";
import { RADAR_LAYER_ID, RADAR_SOURCE_ID, fetchRadarFrames, type RadarFrame } from "../lib/radar";

// Mirrors db::ForecastPeriod.
interface ForecastPeriod {
  id: number;
  fetched_at: string;
  period_number: number;
  name: string;
  start_time: string;
  end_time: string;
  is_daytime: boolean;
  temperature: number | null;
  temperature_unit: string | null;
  probability_of_precip: number | null;
  wind_speed: string | null;
  wind_direction: string | null;
  icon: string | null;
  short_forecast: string | null;
  detailed_forecast: string | null;
}

// Mirrors db::LocalWeatherObservation.
interface LocalWeatherObservation {
  fetched_at: string | null;
  source: string | null;
  temperature_f: number | null;
  humidity_pct: number | null;
  wind_speed_mph: number | null;
  wind_gust_mph: number | null;
  wind_direction_deg: number | null;
  rain_rate_in_hr: number | null;
  pressure_inhg: number | null;
}

interface AlertSummary {
  id: string;
  event: string;
  severity: string;
  area_desc: string | null;
  expires: string | null;
}

const BRAND_LABELS: Record<string, string> = {
  ecowitt: "Ecowitt (Fine Offset)",
  davis_weatherlink_live: "Davis WeatherLink Live",
};

const SEVERITY_ORDER = ["Extreme", "Severe", "Moderate", "Minor", "Unknown"];

const TABS = ["Overview", "NWS Forecast", "Alerts", "Radar", "Stations"] as const;
type Tab = (typeof TABS)[number];

function useLocalObservation() {
  const [obs, setObs] = useState<LocalWeatherObservation | null>(null);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    async function refresh() {
      setObs(await invoke<LocalWeatherObservation>("get_local_weather_observation"));
    }
    refresh();
    listen("local-weather-changed", refresh).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);
  return obs;
}

function useForecast() {
  const [periods, setPeriods] = useState<ForecastPeriod[] | null>(null);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    async function refresh() {
      setPeriods(await invoke<ForecastPeriod[]>("get_forecast_periods"));
    }
    refresh();
    listen("forecast-changed", refresh).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);
  return periods;
}

function useAlertSummaries() {
  const [alerts, setAlerts] = useState<AlertSummary[] | null>(null);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    async function refresh() {
      setAlerts(await invoke<AlertSummary[]>("get_alerts"));
    }
    refresh();
    listen("alerts-changed", refresh).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);
  return alerts;
}

function CurrentConditionsCard({ obs }: { obs: LocalWeatherObservation | null }) {
  if (!obs || !obs.source) {
    return (
      <div className="sync-section">
        <div className="sync-section-head">
          <h3>Current Conditions</h3>
        </div>
        <div className="bandplan-disclaimer">
          No local weather station configured — set a brand and address in Settings → Station Identity to see live
          conditions here. This is separate from the NWS forecast below, which only needs a grid square.
        </div>
      </div>
    );
  }

  const feelsLike =
    obs.temperature_f !== null ? feelsLikeF(obs.temperature_f, obs.humidity_pct, obs.wind_speed_mph) : null;
  const showFeelsLike = feelsLike !== null && obs.temperature_f !== null && Math.abs(feelsLike - obs.temperature_f) >= 1;

  return (
    <div className="sync-section">
      <div className="sync-section-head">
        <h3>Current Conditions</h3>
      </div>
      <div className="bandplan-disclaimer">
        Source: {BRAND_LABELS[obs.source] ?? obs.source}, polled directly over your LAN.{" "}
        {obs.fetched_at && <Freshness fetchedAt={obs.fetched_at} agingAfterSeconds={5 * 60} staleAfterSeconds={15 * 60} />}
      </div>
      <div className="alert-card">
        <div className="alert-header">
          <span>Local Station</span>
          {obs.temperature_f !== null && <span className="resource-chip">{obs.temperature_f.toFixed(1)}°F</span>}
        </div>
        {showFeelsLike && <div className="alert-area">Feels like {Math.round(feelsLike)}°F</div>}
        <div className="alert-area">
          {obs.humidity_pct !== null && `Humidity ${obs.humidity_pct.toFixed(0)}%`}
          {obs.wind_speed_mph !== null && ` · Wind ${obs.wind_speed_mph.toFixed(1)} mph`}
          {obs.wind_gust_mph !== null && ` (gust ${obs.wind_gust_mph.toFixed(1)})`}
          {obs.wind_direction_deg !== null && ` @ ${obs.wind_direction_deg.toFixed(0)}°`}
        </div>
        <div className="alert-area">
          {obs.pressure_inhg !== null && `Pressure ${obs.pressure_inhg.toFixed(2)} inHg`}
          {obs.rain_rate_in_hr !== null && ` · Rain rate ${obs.rain_rate_in_hr.toFixed(2)} in/hr`}
        </div>
        {obs.source === "davis_weatherlink_live" && obs.rain_rate_in_hr !== null && (
          <div className="field-hint">Rain rate assumes a standard 0.01in tipping bucket — verify for your specific collector.</div>
        )}
      </div>
    </div>
  );
}

function DayStrip({ periods }: { periods: ForecastPeriod[] }) {
  const days = buildDayStrip(periods);
  if (days.length === 0) return null;
  return (
    <div className="weather-day-strip">
      {days.map((d, i) => (
        <div key={i} className="weather-day-card">
          <div className="weather-day-label">{d.label}</div>
          {d.icon ? (
            <img src={d.icon} alt={d.shortForecast ?? ""} className="weather-day-icon" />
          ) : (
            <div className="weather-day-icon-fallback">—</div>
          )}
          <div className="weather-day-temps">
            {d.highF !== null && <span className="weather-day-high">{Math.round(d.highF)}°</span>}
            {d.lowF !== null && <span className="weather-day-low">{Math.round(d.lowF)}°</span>}
          </div>
          {d.precipPct !== null && d.precipPct > 0 && <div className="weather-day-precip">💧{d.precipPct}%</div>}
        </div>
      ))}
    </div>
  );
}

function AlertsSummaryCard({ alerts, onViewAll }: { alerts: AlertSummary[] | null; onViewAll: () => void }) {
  if (alerts === null) return null;
  const sorted = [...alerts].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const top = sorted.slice(0, 3);

  return (
    <div className="sync-section">
      <div className="sync-section-head">
        <h3>Weather Alerts</h3>
        <button type="button" className="weather-link-btn" onClick={onViewAll}>
          View All ({alerts.length})
        </button>
      </div>
      {top.length === 0 ? (
        <div className="panel-alerts-empty">No active alerts for your area.</div>
      ) : (
        top.map((a) => (
          <div key={a.id} className={`alert-card severity-${a.severity.toLowerCase()}`}>
            <div className="alert-header">
              <span className="alert-event">{a.event}</span>
              <span className="alert-severity">{a.severity}</span>
            </div>
            {a.area_desc && <div className="alert-area">{a.area_desc}</div>}
          </div>
        ))
      )}
    </div>
  );
}

function ForecastExcerptCard({ periods, onViewFull }: { periods: ForecastPeriod[]; onViewFull: () => void }) {
  const upcoming = periods.slice(0, 2);
  return (
    <div className="sync-section">
      <div className="sync-section-head">
        <h3>NWS Forecast</h3>
        <button type="button" className="weather-link-btn" onClick={onViewFull}>
          View Full Forecast
        </button>
      </div>
      {upcoming.length === 0 ? (
        <div className="panel-alerts-empty">
          No forecast yet — set this station's grid square (Settings → Station Identity) to pull one from NWS.
        </div>
      ) : (
        upcoming.map((p) => (
          <div key={p.id} className="alert-card">
            <div className="alert-header">
              <span>{p.name}</span>
              {p.temperature !== null && (
                <span className="resource-chip">
                  {p.temperature}°{p.temperature_unit ?? ""}
                </span>
              )}
            </div>
            <div className="alert-headline">{p.short_forecast ?? "—"}</div>
          </div>
        ))
      )}
    </div>
  );
}

function OverviewTab({
  obs,
  periods,
  alerts,
  goTo,
}: {
  obs: LocalWeatherObservation | null;
  periods: ForecastPeriod[];
  alerts: AlertSummary[] | null;
  goTo: (t: Tab) => void;
}) {
  return (
    <div className="weather-overview-grid">
      <CurrentConditionsCard obs={obs} />
      {periods.length > 0 && (
        <div className="sync-section">
          <div className="sync-section-head">
            <h3>7-Day Forecast</h3>
          </div>
          <DayStrip periods={periods} />
        </div>
      )}
      <AlertsSummaryCard alerts={alerts} onViewAll={() => goTo("Alerts")} />
      <ForecastExcerptCard periods={periods} onViewFull={() => goTo("NWS Forecast")} />
    </div>
  );
}

function NwsForecastTab({ periods }: { periods: ForecastPeriod[] }) {
  if (periods.length === 0) {
    return (
      <div className="panel-alerts-empty">
        No forecast yet — set this station's grid square (Settings → Station Identity) to pull one from NWS.
      </div>
    );
  }
  return (
    <div className="panel-alerts">
      <div className="bandplan-disclaimer">
        Source: api.weather.gov, forecast for this station's grid square.{" "}
        <Freshness fetchedAt={periods[0].fetched_at} agingAfterSeconds={60 * 60} staleAfterSeconds={6 * 60 * 60} />
      </div>
      {periods.map((p) => (
        <div key={p.id} className="alert-card">
          <div className="alert-header">
            <span>{p.name}</span>
            {p.temperature !== null && (
              <span className="resource-chip">
                {p.temperature}°{p.temperature_unit ?? ""}
              </span>
            )}
          </div>
          <div className="alert-headline">{p.short_forecast ?? "—"}</div>
          <div className="alert-area">
            {p.wind_speed && `Wind ${p.wind_speed}${p.wind_direction ? ` ${p.wind_direction}` : ""}`}
            {p.probability_of_precip !== null && ` · ${p.probability_of_precip}% precip`}
          </div>
          {p.detailed_forecast && <div className="alert-area">{p.detailed_forecast}</div>}
        </div>
      ))}
    </div>
  );
}

function StationsTab({ obs }: { obs: LocalWeatherObservation | null }) {
  return (
    <div>
      <div className="bandplan-disclaimer">
        One physical weather station is supported today, configured in Settings → Station Identity. Tracking
        several named stations at once (a ranch console, a portable unit, etc.) is real future work, not built yet.
      </div>
      <CurrentConditionsCard obs={obs} />
    </div>
  );
}

const RADAR_FRAME_INTERVAL_MS = 500;

/** Lightweight reuse of the Tactical Map's own citadel/online style
 * resolution and RainViewer overlay -- deliberately not a second radar
 * integration, no incident markers or pin tools, just a base map plus
 * the same live composite radar layer, now animated over RainViewer's
 * own recent-frame history instead of showing only the single latest one. */
function RadarTab() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [tileSource, setTileSource] = useState<"citadel" | "online" | null>(null);
  const [radarError, setRadarError] = useState<string | null>(null);
  const [frames, setFrames] = useState<RadarFrame[] | null>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    async function init() {
      const profile = await invoke<{ citadel_map_host: string | null }>("get_station_profile");
      const base = citadelBase(profile.citadel_map_host);
      const useLocal = await probeReachable(`${base}/tiles/comms_base.pmtiles`);
      if (cancelled || !containerRef.current) return;

      const style = useLocal ? (await citadelStyle(base)).style : ONLINE_STYLE;
      if (cancelled || !containerRef.current) return;
      setTileSource(useLocal ? "citadel" : "online");

      const map = new maplibregl.Map({ container: containerRef.current, style, center: [-98.5, 39.8], zoom: 4 });
      mapRef.current = map;

      map.on("load", async () => {
        const seq = await fetchRadarFrames();
        if (cancelled || !mapRef.current) return;
        if (!seq) {
          setRadarError("Could not reach RainViewer for radar imagery — this needs internet, no offline fallback.");
          return;
        }
        const lastIndex = seq.length - 1;
        setFrames(seq);
        setFrameIndex(lastIndex);
        map.addSource(RADAR_SOURCE_ID, { type: "raster", tiles: [seq[lastIndex].tileTemplate], tileSize: 256 });
        map.addLayer({ id: RADAR_LAYER_ID, type: "raster", source: RADAR_SOURCE_ID, paint: { "raster-opacity": 0.7 } });
      });
    }

    init();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Advance through the fetched frame sequence while playing.
  useEffect(() => {
    if (!playing || !frames || frames.length < 2) return;
    const id = setInterval(() => {
      setFrameIndex((i) => (i + 1) % frames.length);
    }, RADAR_FRAME_INTERVAL_MS);
    return () => clearInterval(id);
  }, [playing, frames]);

  // Push whichever frame is current onto the map's existing raster source --
  // same setTiles-based refresh technique as Cloud9's own live radar layer.
  useEffect(() => {
    if (!frames) return;
    const source = mapRef.current?.getSource(RADAR_SOURCE_ID) as maplibregl.RasterTileSource | undefined;
    source?.setTiles([frames[frameIndex].tileTemplate]);
  }, [frames, frameIndex]);

  const currentFrameTime =
    frames && frames[frameIndex]
      ? new Date(frames[frameIndex].time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : null;

  return (
    <div>
      <div className="bandplan-disclaimer">
        Live composite radar from RainViewer (free, no key) — an animated loop over its real recent-frame history
        (typically the last ~2 hours). This is RainViewer's own radar mosaic, not a direct NWS NEXRAD feed. Needs
        internet; there's no offline radar source.
      </div>
      {radarError && <div className="panel-alerts-empty tactical-map-error">{radarError}</div>}
      <div ref={containerRef} className="tactical-map-canvas weather-radar-canvas" />
      {frames && frames.length > 1 && (
        <div className="weather-radar-controls">
          <button type="button" className="weather-link-btn" onClick={() => setPlaying((p) => !p)}>
            {playing ? "Pause" : "Play"}
          </button>
          <input
            type="range"
            min={0}
            max={frames.length - 1}
            value={frameIndex}
            onChange={(e) => {
              setPlaying(false);
              setFrameIndex(Number(e.target.value));
            }}
            className="weather-radar-scrubber"
          />
          {currentFrameTime && <span className="tactical-map-source">{currentFrameTime}</span>}
        </div>
      )}
      {tileSource && <div className="tactical-map-source">Base tiles: {tileSource === "citadel" ? "Citadel (local)" : "OpenFreeMap (online)"}</div>}
    </div>
  );
}

function WeatherPanel() {
  const [tab, setTab] = useState<Tab>("Overview");
  const obs = useLocalObservation();
  const periods = useForecast();
  const alerts = useAlertSummaries();

  if (periods === null) {
    return <div className="panel-alerts">Loading...</div>;
  }

  return (
    <div className="panel-weather">
      <p className="sync-lede">
        Three-tier weather picture: online (NWS forecast + alerts, RainViewer radar) and local (a physical
        weather-station console on your own LAN). RF-received weather (NOAA weather radio, SAME alerts) needs a
        real receiver/decoder this station doesn't have yet — deliberately not shown here rather than faked.
      </p>

      <div className="panel-tabs">
        {TABS.map((t) => (
          <button key={t} type="button" className={t === tab ? "panel-tab-btn active" : "panel-tab-btn"} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      <div className="panel-tab-content">
        {tab === "Overview" && <OverviewTab obs={obs} periods={periods} alerts={alerts} goTo={setTab} />}
        {tab === "NWS Forecast" && <NwsForecastTab periods={periods} />}
        {tab === "Alerts" && <AlertsPanel />}
        {tab === "Radar" && <RadarTab />}
        {tab === "Stations" && <StationsTab obs={obs} />}
      </div>
    </div>
  );
}

export default WeatherPanel;
