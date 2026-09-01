import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Freshness from "../staleness/Freshness";

interface PotaSpot {
  id: number;
  fetched_at: string;
  activator: string;
  frequency_mhz: number | null;
  mode: string | null;
  reference: string;
  park_name: string | null;
  location_desc: string | null;
  grid: string | null;
  latitude: number | null;
  longitude: number | null;
  spot_time: string;
  comments: string | null;
}

function timeAgoLabel(spotTime: string): string {
  const ms = Date.now() - new Date(spotTime).getTime();
  if (ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

function PotaPanel() {
  const [spots, setSpots] = useState<PotaSpot[] | null>(null);

  async function refresh() {
    setSpots(await invoke<PotaSpot[]>("get_pota_spots"));
  }

  useEffect(() => {
    refresh();
    let unlisten: (() => void) | undefined;
    listen("pota-spots-changed", refresh).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  if (spots === null) {
    return <div className="panel-alerts">Loading...</div>;
  }

  if (spots.length === 0) {
    return <div className="panel-alerts panel-alerts-empty">No active POTA spots right now.</div>;
  }

  return (
    <div className="panel-alerts">
      <div className="bandplan-disclaimer">Source: api.pota.app, live activator spots worldwide.</div>
      {spots.map((s) => (
        <div key={s.id} className="alert-card">
          <div className="alert-header">
            <span>
              {s.activator} @ {s.reference}
            </span>
            {s.mode && <span className="resource-chip">{s.mode}</span>}
          </div>
          {s.park_name && <div className="alert-headline">{s.park_name}</div>}
          <div className="alert-area">
            {s.location_desc ?? "—"}
            {s.grid && ` · ${s.grid}`}
            {s.frequency_mhz !== null && ` · ${s.frequency_mhz.toFixed(3)} MHz`}
          </div>
          {s.comments && <div className="alert-area">{s.comments}</div>}
          <div className="alert-footer">
            <span>{timeAgoLabel(s.spot_time)}</span>
            <Freshness fetchedAt={s.fetched_at} agingAfterSeconds={10 * 60} staleAfterSeconds={30 * 60} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default PotaPanel;
