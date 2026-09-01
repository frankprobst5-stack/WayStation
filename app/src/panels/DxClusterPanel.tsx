import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Freshness from "../staleness/Freshness";

interface DxSpot {
  id: number;
  fetched_at: string;
  spotter: string;
  dx_call: string;
  freq_mhz: number;
  comment: string | null;
  spot_time: string;
}

function DxClusterPanel() {
  const [spots, setSpots] = useState<DxSpot[] | null>(null);
  const [hasCallsign, setHasCallsign] = useState<boolean | null>(null);

  async function refresh() {
    const [spotList, profile] = await Promise.all([
      invoke<DxSpot[]>("get_dx_spots"),
      invoke<{ callsign: string | null }>("get_station_profile"),
    ]);
    setSpots(spotList);
    setHasCallsign(!!profile.callsign);
  }

  useEffect(() => {
    refresh();
    let unlisten: (() => void) | undefined;
    listen("dx-spots-changed", refresh).then((fn) => {
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
        Set your station's callsign (Station panel) to log in to the DX cluster.
      </div>
    );
  }

  if (spots.length === 0) {
    return <div className="panel-alerts panel-alerts-empty">No spots yet — waiting on the live feed.</div>;
  }

  return (
    <div className="panel-alerts">
      <div className="bandplan-disclaimer">
        Source: dxc.nc7j.com (AR-Cluster), live telnet feed. Spot times are UTC as reported by the cluster.
      </div>
      {spots.map((s) => (
        <div key={s.id} className="alert-card">
          <div className="alert-header">
            <span>{s.dx_call}</span>
            <span className="resource-chip">{s.freq_mhz.toFixed(3)} MHz</span>
          </div>
          <div className="alert-area">
            de {s.spotter}
            {s.comment && ` · ${s.comment}`}
          </div>
          <div className="alert-footer">
            <span>{s.spot_time}Z</span>
            <Freshness fetchedAt={s.fetched_at} agingAfterSeconds={5 * 60} staleAfterSeconds={20 * 60} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default DxClusterPanel;
