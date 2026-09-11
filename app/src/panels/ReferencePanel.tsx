import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import SpectrumReferencePanel from "./SpectrumReferencePanel";
import BandPlanPanel from "./BandPlanPanel";
import RepeaterLookupPanel from "./RepeaterLookupPanel";
import WebSdrPanel from "./WebSdrPanel";
import ChannelDirectoryPanel from "./ChannelDirectoryPanel";
import FieldReferencePanel from "./FieldReferencePanel";

// Consolidates six panels that used to each show up as their own separate
// stacked tile under the "reference" category into one tabbed page,
// matching the Reference mockup. Every tab embeds the real existing panel
// component unchanged.
//
// "Reference Docs" from the mockup doesn't exist -- confirmed by grep
// before writing this. It would mean operator-uploaded documents stored
// locally, distinct from Field Library's Kiwix search (which is real, but
// only searches whatever's already loaded on Citadel, not something an
// operator can add to from here). "Bookmarks" isn't a separate feature
// either -- WebSDR and Channel Directory are themselves operator-curated
// bookmark lists already, which is what that mockup tab most likely meant.
// A Reference-specific Settings tab isn't built either; real settings
// (Citadel host for Field Library) already live on Station Identity.

const TABS = ["Overview", "Frequencies", "Repeaters", "WebSDR", "Channel Directory", "Field Library"] as const;
type Tab = (typeof TABS)[number];

interface WebSdrStation { id: number }
interface Channel { id: number }
interface KiwixBook { id: string }

function useCount<T>(command: string) {
  const [items, setItems] = useState<T[] | null>(null);
  useEffect(() => {
    invoke<T[]>(command).then(setItems).catch(() => setItems([]));
  }, [command]);
  return items;
}

function SummaryCard({ title, onView, children }: { title: string; onView: () => void; children: React.ReactNode }) {
  return (
    <div className="sync-section">
      <div className="sync-section-head">
        <h3>{title}</h3>
        <button type="button" className="weather-link-btn" onClick={onView}>
          Open
        </button>
      </div>
      {children}
    </div>
  );
}

function OverviewTab({ goTo }: { goTo: (t: Tab) => void }) {
  const websdr = useCount<WebSdrStation>("get_websdr_stations");
  const channels = useCount<Channel>("get_channels");
  const books = useCount<KiwixBook>("list_kiwix_books");

  return (
    <div className="weather-overview-grid">
      <SummaryCard title="Frequencies" onView={() => goTo("Frequencies")}>
        <div className="alert-card">
          <div className="alert-area">VHF/UHF simplex, MURS, GMRS, NOAA weather radio, the full US amateur band plan, and NATO phonetics/Morse.</div>
        </div>
      </SummaryCard>

      <SummaryCard title="Repeaters" onView={() => goTo("Repeaters")}>
        <div className="alert-card">
          <div className="alert-area">Live search against RepeaterBook by state/city/callsign.</div>
        </div>
      </SummaryCard>

      <SummaryCard title="WebSDR" onView={() => goTo("WebSDR")}>
        <div className="alert-card">
          <div className="alert-area">{websdr === null ? "Loading..." : `${websdr.length} saved station${websdr.length === 1 ? "" : "s"}`}</div>
        </div>
      </SummaryCard>

      <SummaryCard title="Channel Directory" onView={() => goTo("Channel Directory")}>
        <div className="alert-card">
          <div className="alert-area">{channels === null ? "Loading..." : `${channels.length} saved channel${channels.length === 1 ? "" : "s"}`}</div>
        </div>
      </SummaryCard>

      <SummaryCard title="Field Library" onView={() => goTo("Field Library")}>
        <div className="alert-card">
          <div className="alert-area">{books === null ? "Loading..." : books.length === 0 ? "Citadel reachable, no books loaded yet." : `${books.length} book${books.length === 1 ? "" : "s"} available on Citadel`}</div>
        </div>
      </SummaryCard>

      <div className="sync-section">
        <div className="sync-section-head">
          <h3>Not built yet</h3>
        </div>
        <div className="bandplan-disclaimer">
          "Reference Docs" from the mockup would mean operator-uploaded documents stored locally -- doesn't exist;
          Field Library only searches what's already loaded on Citadel's Kiwix, nothing can be added to it from
          here. "Bookmarks" isn't separate either -- WebSDR and Channel Directory are themselves operator-curated
          bookmark lists already.
        </div>
      </div>
    </div>
  );
}

function ReferencePanel() {
  const [tab, setTab] = useState<Tab>("Overview");

  return (
    <div className="panel-weather">
      <p className="sync-lede">
        The knowledge layer behind Waystation — frequencies, repeaters, and field references that stay useful
        offline.
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
        {tab === "Frequencies" && (
          <div className="weather-overview-grid">
            <div className="sync-section">
              <div className="sync-section-head"><h3>Spectrum Reference</h3></div>
              <SpectrumReferencePanel />
            </div>
            <div className="sync-section">
              <div className="sync-section-head"><h3>Band Plan (Amateur Radio)</h3></div>
              <BandPlanPanel />
            </div>
          </div>
        )}
        {tab === "Repeaters" && <RepeaterLookupPanel />}
        {tab === "WebSDR" && <WebSdrPanel />}
        {tab === "Channel Directory" && <ChannelDirectoryPanel />}
        {tab === "Field Library" && <FieldReferencePanel />}
      </div>
    </div>
  );
}

export default ReferencePanel;
