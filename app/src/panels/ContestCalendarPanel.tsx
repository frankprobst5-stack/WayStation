import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import Freshness from "../staleness/Freshness";

interface Contest {
  id: string;
  fetched_at: string;
  label: string;
  starts_at: string;
  ends_at: string | null;
  detail_url: string | null;
}

function statusLabel(startsAt: string, endsAt: string | null): string {
  const now = Date.now();
  const start = new Date(startsAt).getTime();
  const end = endsAt ? new Date(endsAt).getTime() : null;

  if (end !== null && now >= start && now < end) return "in progress";
  if (now >= start) return "recently started";

  const ms = start - now;
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  if (days > 0) return `starts in ${days}d ${hours}h`;
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `starts in ${hours}h ${minutes}m`;
}

function ContestCalendarPanel() {
  const [contests, setContests] = useState<Contest[] | null>(null);

  async function refresh() {
    setContests(await invoke<Contest[]>("get_contests"));
  }

  useEffect(() => {
    refresh();
    let unlisten: (() => void) | undefined;
    listen("contests-changed", refresh).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  if (contests === null) {
    return <div className="panel-alerts">Loading...</div>;
  }

  if (contests.length === 0) {
    return <div className="panel-alerts panel-alerts-empty">No upcoming contests fetched yet.</div>;
  }

  return (
    <div className="panel-alerts">
      <div className="bandplan-disclaimer">
        Source: WA7BNM Contest Calendar (contestcalendar.com), 8-day rolling window.
      </div>
      {contests.map((c) => (
        <div key={c.id} className="alert-card">
          <div className="alert-header">
            <span>{c.label}</span>
            {c.detail_url && (
              <button type="button" onClick={() => openUrl(c.detail_url!)}>
                Details
              </button>
            )}
          </div>
          <div className="alert-area">{new Date(c.starts_at).toLocaleString()}</div>
          <div className="alert-footer">
            <span>{statusLabel(c.starts_at, c.ends_at)}</span>
            <Freshness fetchedAt={c.fetched_at} agingAfterSeconds={12 * 3600} staleAfterSeconds={24 * 3600} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default ContestCalendarPanel;
