import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import SpectrumReferencePanel from "./SpectrumReferencePanel";
import BandPlanPanel from "./BandPlanPanel";
import RepeaterLookupPanel from "./RepeaterLookupPanel";
import WebSdrPanel from "./WebSdrPanel";
import ChannelDirectoryPanel from "./ChannelDirectoryPanel";
import FieldReferencePanel from "./FieldReferencePanel";

// Consolidates seven panels that used to each show up as their own
// separate stacked tile under the "reference" category into one tabbed
// page, matching the Reference mockup. Every tab embeds the real existing
// panel component unchanged.
//
// "Reference Docs" is real now (2026-11-23): operator-uploaded documents
// copied into this app's own data directory and listed here, distinct
// from Field Library's Kiwix search (which only ever searches whatever's
// already loaded on Citadel, nothing could be added to it from here).
// "Bookmarks" still isn't a separate feature -- WebSDR and Channel
// Directory are themselves operator-curated bookmark lists already, which
// is what that mockup tab most likely meant. A Reference-specific
// Settings tab isn't built either; real settings (Citadel host for Field
// Library) already live on Station Identity.

const TABS = ["Overview", "Frequencies", "Repeaters", "WebSDR", "Channel Directory", "Field Library", "Reference Docs"] as const;
type Tab = (typeof TABS)[number];

interface WebSdrStation { id: number }
interface Channel { id: number }
interface KiwixBook { id: string }

// Mirrors reference_docs::ReferenceDoc.
interface ReferenceDoc {
  id: number;
  filename: string;
  title: string;
  size_bytes: number;
  added_at: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

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
  const docs = useCount<ReferenceDoc>("get_reference_docs");

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

      <SummaryCard title="Reference Docs" onView={() => goTo("Reference Docs")}>
        <div className="alert-card">
          <div className="alert-area">{docs === null ? "Loading..." : `${docs.length} document${docs.length === 1 ? "" : "s"} uploaded`}</div>
        </div>
      </SummaryCard>

      <div className="sync-section">
        <div className="sync-section-head">
          <h3>Not built yet</h3>
        </div>
        <div className="bandplan-disclaimer">
          "Bookmarks" from the mockup isn't a separate feature -- WebSDR and Channel Directory are themselves
          operator-curated bookmark lists already.
        </div>
      </div>
    </div>
  );
}

function ReferenceDocsTab() {
  const [docs, setDocs] = useState<ReferenceDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function refresh() {
    try {
      setDocs(await invoke<ReferenceDoc[]>("get_reference_docs"));
    } catch (err) {
      console.error("get_reference_docs failed:", err);
      setError(String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function uploadDoc() {
    const path = await open({ multiple: false });
    if (!path) return; // cancelled
    setUploading(true);
    setError(null);
    try {
      await invoke("add_reference_doc", { sourcePath: path, title: null });
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setUploading(false);
    }
  }

  async function openDoc(id: number) {
    try {
      const path = await invoke<string>("get_reference_doc_path", { id });
      await openPath(path);
    } catch (err) {
      setError(String(err));
    }
  }

  async function deleteDoc(id: number) {
    try {
      await invoke("delete_reference_doc", { id });
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  if (error) {
    return <div className="panel-alerts panel-alerts-empty">{error}</div>;
  }
  if (docs === null) {
    return <div className="panel-alerts">Loading...</div>;
  }

  return (
    <div className="panel-sync">
      <p className="sync-lede">
        Your own documents, copied into WayStation's own data directory so they're still here on a future launch
        regardless of where the original file lives. Opens with whatever application your system already uses for
        that file type — there's no in-app viewer.
      </p>
      <button type="button" className="action-btn" onClick={uploadDoc} disabled={uploading}>
        {uploading ? "Uploading..." : "+ Upload Document"}
      </button>

      {docs.length === 0 ? (
        <div className="panel-alerts-empty" style={{ marginTop: "0.8rem" }}>
          Nothing uploaded yet.
        </div>
      ) : (
        <table style={{ marginTop: "0.8rem" }}>
          <thead>
            <tr>
              <th>Title</th>
              <th>Size</th>
              <th>Added</th>
              <th style={{ width: "140px" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id}>
                <td>{d.title}</td>
                <td>{formatBytes(d.size_bytes)}</td>
                <td>{new Date(d.added_at).toLocaleString()}</td>
                <td style={{ display: "flex", gap: "0.4rem" }}>
                  <button type="button" className="action-btn" onClick={() => openDoc(d.id)}>
                    Open
                  </button>
                  <button type="button" className="action-btn" onClick={() => deleteDoc(d.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ReferencePanel() {
  const [tab, setTab] = useState<Tab>("Overview");

  return (
    <div className="panel-weather">
      <p className="sync-lede">
        The knowledge layer behind WayStation — frequencies, repeaters, and field references that stay useful
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
        {tab === "Reference Docs" && <ReferenceDocsTab />}
      </div>
    </div>
  );
}

export default ReferencePanel;
