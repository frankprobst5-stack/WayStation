import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import SpaceWeatherPanel from "./SpaceWeatherPanel";
import PotaPanel from "./PotaPanel";
import SatellitePanel from "./SatellitePanel";
import PskReporterPanel from "./PskReporterPanel";
import QsoLogPanel from "./QsoLogPanel";

// Consolidates five panels that used to each show up as their own separate
// stacked tile under the "Activity" sidebar category into one tabbed page,
// matching the Radio Activity mockup ("what can I work right now"). Same
// treatment WeatherPanel already got. Every tab embeds the real existing
// panel component unchanged; this file only adds the tab shell and an
// Overview that summarizes each one.
//
// DX Cluster and Contest Calendar deliberately stay OUT of this page --
// see the comment above their registration in index.ts: they're
// hobbyist-flagged for Tactical Mode filtering, which only works at the
// top-level panel registry, not for tabs living inside another panel.

const TABS = ["Overview", "Space Weather", "POTA Spots", "Satellite Passes", "Reception Reports", "QSO Log"] as const;
type Tab = (typeof TABS)[number];

interface PotaSpot { activator: string; reference: string; park_name: string | null }
interface PskSpot { heard_by_call: string; snr: number | null }
interface SatelliteTle { name: string }
interface QsoLogEntry { call: string; qso_date: string }

function useCount<T>(command: string) {
  const [items, setItems] = useState<T[] | null>(null);
  useEffect(() => {
    invoke<T[]>(command).then(setItems);
  }, [command]);
  return items;
}

function SummaryCard({ title, onView, children }: { title: string; onView: () => void; children: React.ReactNode }) {
  return (
    <div className="sync-section">
      <div className="sync-section-head">
        <h3>{title}</h3>
        <button type="button" className="weather-link-btn" onClick={onView}>
          View Full
        </button>
      </div>
      {children}
    </div>
  );
}

function OverviewTab({ goTo }: { goTo: (t: Tab) => void }) {
  const pota = useCount<PotaSpot>("get_pota_spots");
  const psk = useCount<PskSpot>("get_psk_spots");
  const sats = useCount<SatelliteTle>("get_satellite_tles");
  const qsos = useCount<QsoLogEntry>("get_qso_log");

  return (
    <div className="weather-overview-grid">
      <SpaceWeatherPanel />

      <SummaryCard title="POTA Spots" onView={() => goTo("POTA Spots")}>
        {pota === null ? <div className="panel-alerts-empty">Loading...</div> : pota.length === 0 ? (
          <div className="panel-alerts-empty">No active spots right now.</div>
        ) : (
          <div className="alert-card">
            <div className="alert-header"><span>{pota[0].activator} @ {pota[0].reference}</span></div>
            {pota[0].park_name && <div className="alert-headline">{pota[0].park_name}</div>}
            <div className="alert-area">{pota.length} active spot{pota.length === 1 ? "" : "s"} total</div>
          </div>
        )}
      </SummaryCard>

      <SummaryCard title="Reception Reports" onView={() => goTo("Reception Reports")}>
        {psk === null ? <div className="panel-alerts-empty">Loading...</div> : psk.length === 0 ? (
          <div className="panel-alerts-empty">No reception reports yet.</div>
        ) : (
          <div className="alert-card">
            <div className="alert-header"><span>Heard by {psk[0].heard_by_call}</span>{psk[0].snr !== null && <span className="resource-chip">{psk[0].snr} dB</span>}</div>
            <div className="alert-area">{psk.length} report{psk.length === 1 ? "" : "s"} in the last 24h</div>
          </div>
        )}
      </SummaryCard>

      <SummaryCard title="Satellite Passes" onView={() => goTo("Satellite Passes")}>
        {sats === null ? <div className="panel-alerts-empty">Loading...</div> : sats.length === 0 ? (
          <div className="panel-alerts-empty">No satellite data yet.</div>
        ) : (
          <div className="alert-card">
            <div className="alert-area">Tracking {sats.length} satellite{sats.length === 1 ? "" : "s"} — open the tab for live az/el and pass predictions.</div>
          </div>
        )}
      </SummaryCard>

      <SummaryCard title="QSO Log" onView={() => goTo("QSO Log")}>
        {qsos === null ? <div className="panel-alerts-empty">Loading...</div> : qsos.length === 0 ? (
          <div className="panel-alerts-empty">No QSOs logged yet.</div>
        ) : (
          <div className="alert-card">
            <div className="alert-header"><span>Most recent: {qsos[0].call}</span></div>
            <div className="alert-area">{qsos.length} contact{qsos.length === 1 ? "" : "s"} logged total</div>
          </div>
        )}
      </SummaryCard>
    </div>
  );
}

function ActivityPanel() {
  const [tab, setTab] = useState<Tab>("Overview");

  return (
    <div className="panel-weather">
      <p className="sync-lede">
        Ham-radio operations intelligence — space weather, propagation, POTA spots, reception reports, satellite
        passes, and your QSO log together, because they all answer the same question: what can I work right now?
        (DX Cluster and Contest Calendar stay on their own separate tiles — Tactical Mode can hide those, but not
        a tab living inside this page.)
      </p>

      <div className="panel-tabs">
        {TABS.map((t) => (
          <button key={t} type="button" className={t === tab ? "panel-tab-btn active" : "panel-tab-btn"} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      <div className="panel-tab-content">
        {tab === "Overview" && <OverviewTab goTo={setTab} />}
        {tab === "Space Weather" && <SpaceWeatherPanel />}
        {tab === "POTA Spots" && <PotaPanel />}
        {tab === "Satellite Passes" && <SatellitePanel />}
        {tab === "Reception Reports" && <PskReporterPanel />}
        {tab === "QSO Log" && <QsoLogPanel />}
      </div>
    </div>
  );
}

export default ActivityPanel;
