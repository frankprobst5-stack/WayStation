import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Freshness from "../staleness/Freshness";

// Mirrors db::AircraftTrack.
interface AircraftTrack {
  id: number;
  fetched_at: string;
  icao24: string;
  callsign: string | null;
  origin_country: string | null;
  latitude: number | null;
  longitude: number | null;
  altitude_m: number | null;
  on_ground: boolean;
  velocity_ms: number | null;
  true_track: number | null;
  vertical_rate_ms: number | null;
  squawk: string | null;
  last_contact: number;
}

function metersToFeet(m: number): number {
  return Math.round(m * 3.28084);
}

function msToKnots(ms: number): number {
  return Math.round(ms * 1.94384);
}

function lastContactLabel(unixSeconds: number): string {
  const ms = Date.now() - unixSeconds * 1000;
  if (ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

function FlightTrackingPanel() {
  const [tracks, setTracks] = useState<AircraftTrack[] | null>(null);

  async function refresh() {
    setTracks(await invoke<AircraftTrack[]>("get_aircraft_tracks"));
  }

  useEffect(() => {
    refresh();
    let unlisten: (() => void) | undefined;
    listen("aircraft-tracks-changed", refresh).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  if (tracks === null) {
    return <div className="panel-alerts">Loading...</div>;
  }

  if (tracks.length === 0) {
    return (
      <div className="panel-alerts panel-alerts-empty">
        No aircraft currently reported nearby — either a quiet sky, or this station's grid square isn't set yet
        (Settings → Station Identity), which is required to know what "nearby" means.
      </div>
    );
  }

  return (
    <div className="panel-alerts">
      <div className="bandplan-disclaimer">
        Source: OpenSky Network, live ADS-B within ~135mi of this station's grid square. Online only — no local
        SDR fallback yet, so this goes silent the same moment the internet does.
      </div>
      {tracks.map((t) => (
        <div key={t.id} className="alert-card">
          <div className="alert-header">
            <span>{t.callsign ?? t.icao24}</span>
            {t.on_ground && <span className="resource-chip">On ground</span>}
            {t.squawk && <span className="resource-chip">Squawk {t.squawk}</span>}
          </div>
          <div className="alert-area">
            {t.altitude_m !== null ? `${metersToFeet(t.altitude_m).toLocaleString()} ft` : "altitude unknown"}
            {t.velocity_ms !== null && ` · ${msToKnots(t.velocity_ms)} kt`}
            {t.true_track !== null && ` · heading ${Math.round(t.true_track)}°`}
          </div>
          <div className="alert-area">
            {t.origin_country ?? "—"}
            {t.latitude !== null && t.longitude !== null && ` · ${t.latitude.toFixed(2)}, ${t.longitude.toFixed(2)}`}
          </div>
          <div className="alert-footer">
            <span>{lastContactLabel(t.last_contact)}</span>
            <Freshness fetchedAt={t.fetched_at} agingAfterSeconds={5 * 60} staleAfterSeconds={15 * 60} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default FlightTrackingPanel;
