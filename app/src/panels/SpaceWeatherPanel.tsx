import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Freshness from "../staleness/Freshness";
import GaugeDial from "../components/GaugeDial";
import type { GaugeTier } from "../components/GaugeDial";

interface SpaceWeather {
  fetched_at: string | null;
  updated_label: string | null;
  solar_flux: number | null;
  a_index: number | null;
  k_index: number | null;
  sunspots: number | null;
  xray: string | null;
  proton_flux: number | null;
  electron_flux: number | null;
  aurora: number | null;
  solar_wind: number | null;
  magnetic_field: number | null;
  geomag_field: string | null;
  signal_noise: string | null;
  band_conditions: string | null;
  r_scale: number | null;
  r_text: string | null;
  s_scale: number | null;
  s_text: string | null;
  g_scale: number | null;
  g_text: string | null;
}

interface BandCondition {
  name: string;
  time: string;
  condition: string;
}

const BAND_ORDER = ["80m-40m", "30m-20m", "17m-15m", "12m-10m"];

function conditionTier(condition: string): GaugeTier {
  const c = condition.toLowerCase();
  if (c === "good") return "quiet";
  if (c === "fair") return "unsettled";
  if (c === "poor") return "storm";
  return null;
}

function scaleTier(scale: number | null): GaugeTier {
  if (scale === null) return null;
  if (scale === 0) return "quiet";
  if (scale <= 2) return "unsettled";
  return "storm";
}

function kIndexTier(k: number | null): GaugeTier {
  if (k === null) return null;
  if (k <= 3) return "quiet";
  if (k === 4) return "unsettled";
  return "storm";
}

function aIndexTier(a: number | null): GaugeTier {
  if (a === null) return null;
  if (a <= 7) return "quiet";
  if (a <= 15) return "unsettled";
  return "storm";
}

function bzTier(bz: number | null): GaugeTier {
  if (bz === null) return null;
  if (bz <= -10) return "storm";
  if (bz <= -5) return "unsettled";
  return "quiet";
}

function windTier(wind: number | null): GaugeTier {
  if (wind === null) return null;
  if (wind >= 600) return "storm";
  if (wind >= 400) return "unsettled";
  return "quiet";
}

function xrayTier(xray: string | null): string {
  if (!xray) return "";
  const cls = xray.charAt(0).toUpperCase();
  if (cls === "M" || cls === "X") return "sw-storm";
  if (cls === "C") return "sw-unsettled";
  return "sw-quiet";
}

function SpaceWeatherPanel() {
  const [sw, setSw] = useState<SpaceWeather | null>(null);

  async function refresh() {
    setSw(await invoke<SpaceWeather>("get_space_weather"));
  }

  useEffect(() => {
    refresh();
    let unlisten: (() => void) | undefined;
    listen("space-weather-changed", refresh).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  if (!sw) {
    return <div className="panel-space-weather">Loading...</div>;
  }

  if (sw.fetched_at === null) {
    return <div className="panel-space-weather panel-alerts-empty">No data yet.</div>;
  }

  const bandConditions: BandCondition[] = sw.band_conditions ? JSON.parse(sw.band_conditions) : [];

  return (
    <div className="panel-space-weather">
      <div className="gauge-grid">
        <GaugeDial label="SFI" value={sw.solar_flux} min={60} max={300} />
        <GaugeDial label="Sunspots" value={sw.sunspots} min={0} max={300} />
        <GaugeDial label="K-index" value={sw.k_index} min={0} max={9} tier={kIndexTier(sw.k_index)} />
        <GaugeDial label="A-index" value={sw.a_index} min={0} max={100} tier={aIndexTier(sw.a_index)} />
        <GaugeDial label="Solar Wind" value={sw.solar_wind} min={200} max={800} unit=" km/s" tier={windTier(sw.solar_wind)} />
        <GaugeDial label="Bz" value={sw.magnetic_field} min={-20} max={20} unit=" nT" decimals={1} tier={bzTier(sw.magnetic_field)} />
      </div>

      <div className="sw-grid">
        <div className={`sw-tile ${xrayTier(sw.xray)}`}>
          <span className="sw-label">X-ray</span>
          <span className="sw-value">{sw.xray ?? "—"}</span>
        </div>
        <div className="sw-tile">
          <span className="sw-label">Aurora</span>
          <span className="sw-value">{sw.aurora ?? "—"}</span>
        </div>
        <div className={`sw-tile sw-${scaleTier(sw.r_scale) ?? "unknown"}`}>
          <span className="sw-label">R (radio blackout)</span>
          <span className="sw-value">{sw.r_scale !== null ? `R${sw.r_scale}` : "—"}</span>
        </div>
        <div className={`sw-tile sw-${scaleTier(sw.s_scale) ?? "unknown"}`}>
          <span className="sw-label">S (radiation storm)</span>
          <span className="sw-value">{sw.s_scale !== null ? `S${sw.s_scale}` : "—"}</span>
        </div>
        <div className={`sw-tile sw-${scaleTier(sw.g_scale) ?? "unknown"}`}>
          <span className="sw-label">G (geomagnetic storm)</span>
          <span className="sw-value">{sw.g_scale !== null ? `G${sw.g_scale}` : "—"}</span>
        </div>
      </div>

      {sw.band_conditions && (
        <div className="band-condition-table">
          <div className="band-condition-row band-condition-header">
            <span></span>
            <span>Day</span>
            <span>Night</span>
          </div>
          {BAND_ORDER.map((name) => {
            const day = bandConditions.find((c) => c.name === name && c.time === "day");
            const night = bandConditions.find((c) => c.name === name && c.time === "night");
            return (
              <div className="band-condition-row" key={name}>
                <span className="sw-label">{name}</span>
                <span className={`band-condition-cell sw-${conditionTier(day?.condition ?? "") ?? "unknown"}`}>
                  {day?.condition ?? "—"}
                </span>
                <span className={`band-condition-cell sw-${conditionTier(night?.condition ?? "") ?? "unknown"}`}>
                  {night?.condition ?? "—"}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="sw-footer">
        <span>{sw.geomag_field}</span>
        <Freshness fetchedAt={sw.fetched_at} agingAfterSeconds={3600 * 4} staleAfterSeconds={3600 * 12} />
      </div>
    </div>
  );
}

export default SpaceWeatherPanel;
