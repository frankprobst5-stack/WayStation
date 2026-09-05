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
        Three-tier weather picture: this page is the online tier (NWS forecast; live radar is on the Tactical Map's
        "Show Radar" toggle). Active alerts are already covered elsewhere in EmComm. RF-received weather (NOAA
        weather radio, satellite imagery) and a local weather-station console are planned next — see ROADMAP.md.
      </p>

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
