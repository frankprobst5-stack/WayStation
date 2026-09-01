import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Freshness from "../staleness/Freshness";

interface Alert {
  id: string;
  fetched_at: string;
  event: string;
  severity: string;
  headline: string | null;
  description: string | null;
  area_desc: string | null;
  effective: string | null;
  expires: string | null;
}

const SEVERITY_ORDER = ["Extreme", "Severe", "Moderate", "Minor", "Unknown"];

function severityClass(severity: string): string {
  return `severity-${severity.toLowerCase()}`;
}

function expiryLabel(expires: string | null): string {
  if (!expires) return "";
  const ms = new Date(expires).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours > 0) return `expires in ${hours}h ${minutes}m`;
  return `expires in ${minutes}m`;
}

function AlertsPanel() {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [hasGridSquare, setHasGridSquare] = useState<boolean | null>(null);

  async function refresh() {
    const [alertList, profile] = await Promise.all([
      invoke<Alert[]>("get_alerts"),
      invoke<{ grid_square: string | null }>("get_station_profile"),
    ]);
    setAlerts(alertList);
    setHasGridSquare(!!profile.grid_square);
  }

  useEffect(() => {
    refresh();
    let unlisten: (() => void) | undefined;
    listen("alerts-changed", refresh).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  if (alerts === null || hasGridSquare === null) {
    return <div className="panel-alerts">Loading...</div>;
  }

  if (!hasGridSquare) {
    return (
      <div className="panel-alerts panel-alerts-empty">
        Set your station's grid square (Station panel) to see local NWS alerts.
      </div>
    );
  }

  if (alerts.length === 0) {
    return <div className="panel-alerts panel-alerts-empty">No active alerts for your area.</div>;
  }

  const sorted = [...alerts].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );

  return (
    <div className="panel-alerts">
      {sorted.map((a) => (
        <div key={a.id} className={`alert-card ${severityClass(a.severity)}`}>
          <div className="alert-header">
            <span className="alert-event">{a.event}</span>
            <span className="alert-severity">{a.severity}</span>
          </div>
          {a.headline && <div className="alert-headline">{a.headline}</div>}
          {a.area_desc && <div className="alert-area">{a.area_desc}</div>}
          <div className="alert-footer">
            <span>{expiryLabel(a.expires)}</span>
            <Freshness fetchedAt={a.fetched_at} agingAfterSeconds={600} staleAfterSeconds={1800} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default AlertsPanel;
