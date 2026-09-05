import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Freshness from "../staleness/Freshness";

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

const BRAND_LABELS: Record<string, string> = {
  ecowitt: "Ecowitt (Fine Offset)",
  davis_weatherlink_live: "Davis WeatherLink Live",
};

function LocalWeatherSection() {
  const [obs, setObs] = useState<LocalWeatherObservation | null>(null);

  async function refresh() {
    setObs(await invoke<LocalWeatherObservation>("get_local_weather_observation"));
  }

  useEffect(() => {
    refresh();
    let unlisten: (() => void) | undefined;
    listen("local-weather-changed", refresh).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  if (!obs) return null;

  if (!obs.source) {
    return (
      <div className="sync-section">
        <div className="sync-section-head">
          <h3>Local Weather Station</h3>
        </div>
        <div className="field-hint">
          Not configured — set a brand and address in Settings → Station Identity. Polls the console directly
          over your LAN, no internet or Citadel involved, so this keeps working when the internet doesn't.
        </div>
      </div>
    );
  }

  return (
    <div className="sync-section">
      <div className="sync-section-head">
        <h3>Local Weather Station</h3>
      </div>
      <div className="bandplan-disclaimer">
        Source: {BRAND_LABELS[obs.source] ?? obs.source}, polled directly over your LAN.{" "}
        {obs.fetched_at && <Freshness fetchedAt={obs.fetched_at} agingAfterSeconds={5 * 60} staleAfterSeconds={15 * 60} />}
      </div>
      <div className="alert-card">
        <div className="alert-header">
          <span>Current Conditions</span>
          {obs.temperature_f !== null && <span className="resource-chip">{obs.temperature_f.toFixed(1)}°F</span>}
        </div>
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

function WeatherPanel() {
  const [periods, setPeriods] = useState<ForecastPeriod[] | null>(null);

  async function refresh() {
    setPeriods(await invoke<ForecastPeriod[]>("get_forecast_periods"));
  }

  useEffect(() => {
    refresh();
    let unlisten: (() => void) | undefined;
    listen("forecast-changed", refresh).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  if (periods === null) {
    return <div className="panel-alerts">Loading...</div>;
  }

  return (
    <div className="panel-alerts">
      <p className="sync-lede">
        Three-tier weather picture: this page covers the online tier (NWS forecast; live radar is on the Tactical
        Map's "Show Radar" toggle) and the local tier (a physical weather-station console on your own LAN, below).
        Active alerts are already covered elsewhere in EmComm. RF-received weather (NOAA weather radio, satellite
        imagery) is still planned — see ROADMAP.md.
      </p>

      <LocalWeatherSection />

      {periods.length === 0 ? (
        <div className="panel-alerts-empty">
          No forecast yet — set this station's grid square (Settings → Station Identity) to pull one from NWS.
        </div>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}

export default WeatherPanel;
