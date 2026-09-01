import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Freshness from "../staleness/Freshness";

interface PskSpot {
  id: number;
  fetched_at: string;
  heard_by_call: string;
  heard_by_grid: string | null;
  freq_mhz: number | null;
  mode: string | null;
  snr: number | null;
  distance_km: number | null;
  bearing_deg: number | null;
  heard_at: string;
}

function timeAgoLabel(heardAt: string): string {
  const ms = Date.now() - new Date(heardAt).getTime();
  if (ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

function PskReporterPanel() {
  const [spots, setSpots] = useState<PskSpot[] | null>(null);
  const [hasCallsign, setHasCallsign] = useState<boolean | null>(null);

  async function refresh() {
    const [spotList, profile] = await Promise.all([
      invoke<PskSpot[]>("get_psk_spots"),
      invoke<{ callsign: string | null }>("get_station_profile"),
    ]);
    setSpots(spotList);
    setHasCallsign(!!profile.callsign);
  }

  useEffect(() => {
    refresh();
    let unlisten: (() => void) | undefined;
    listen("psk-spots-changed", refresh).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  if (spots === null || hasCallsign === null) {
    return <div className="panel-alerts">Loading...</div>;
  }

  if (!hasCallsign) {
    return (
      <div className="panel-alerts panel-alerts-empty">
        Set your station's callsign (Station panel) to see who's hearing you on PSKReporter.
      </div>
    );
  }

  if (spots.length === 0) {
    return <div className="panel-alerts panel-alerts-empty">No reception reports yet — waiting on the next poll, or no digital activity in the last 24 hours.</div>;
  }

  return (
    <div className="panel-alerts">
      <div className="bandplan-disclaimer">
        Source: PSKReporter (pskreporter.info), last 24 hours. Requires calling CQ or transmitting FT8/FT4/other
        supported digital modes to generate reports.
      </div>
      {spots.map((s) => (
        <div key={s.id} className="alert-card">
          <div className="alert-header">
            <span>{s.heard_by_call}</span>
            {s.mode && <span className="resource-chip">{s.mode}</span>}
          </div>
          <div className="alert-area">
            {s.heard_by_grid ?? "—"}
            {s.distance_km !== null && ` · ${Math.round(s.distance_km)} km`}
            {s.bearing_deg !== null && ` · ${s.bearing_deg}°`}
            {s.freq_mhz !== null && ` · ${s.freq_mhz.toFixed(3)} MHz`}
            {s.snr !== null && ` · ${s.snr} dB SNR`}
          </div>
          <div className="alert-footer">
            <span>{timeAgoLabel(s.heard_at)}</span>
            <Freshness fetchedAt={s.fetched_at} agingAfterSeconds={30 * 60} staleAfterSeconds={2 * 3600} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default PskReporterPanel;
