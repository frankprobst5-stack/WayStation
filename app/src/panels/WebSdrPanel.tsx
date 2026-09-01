import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

interface WebSdrStation {
  id: number;
  label: string;
  url: string;
  location: string | null;
  notes: string | null;
  updated_at: string;
}

interface ShareableStation {
  label: string;
  url: string;
  location: string | null;
  notes: string | null;
}

function WebSdrPanel() {
  const [stations, setStations] = useState<WebSdrStation[]>([]);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);

  const [shareOpen, setShareOpen] = useState(false);
  const [exportText, setExportText] = useState("");
  const [importText, setImportText] = useState("");
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  async function refresh() {
    setStations(await invoke<WebSdrStation[]>("get_websdr_stations"));
  }

  useEffect(() => {
    refresh();
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim() || !url.trim()) return;
    await invoke("upsert_websdr_station", {
      id: editingId,
      label,
      url,
      location: location || null,
      notes: notes || null,
    });
    setLabel("");
    setUrl("");
    setLocation("");
    setNotes("");
    setEditingId(null);
    refresh();
  }

  function edit(s: WebSdrStation) {
    setEditingId(s.id);
    setLabel(s.label);
    setUrl(s.url);
    setLocation(s.location ?? "");
    setNotes(s.notes ?? "");
  }

  async function remove(id: number) {
    await invoke("delete_websdr_station", { id });
    if (editingId === id) {
      setEditingId(null);
      setLabel("");
      setUrl("");
      setLocation("");
      setNotes("");
    }
    refresh();
  }

  function openShare() {
    const shareable: ShareableStation[] = stations.map((s) => ({
      label: s.label,
      url: s.url,
      location: s.location,
      notes: s.notes,
    }));
    setExportText(JSON.stringify(shareable, null, 2));
    setImportText("");
    setImportStatus(null);
    setCopyState("idle");
    setShareOpen(true);
  }

  async function copyExport() {
    try {
      await navigator.clipboard.writeText(exportText);
      setCopyState("copied");
    } catch {
      // Clipboard API can be unavailable — the textarea itself is the fallback (click to select-all).
    }
  }

  async function doImport() {
    setImportStatus(null);
    let parsed: ShareableStation[];
    try {
      parsed = JSON.parse(importText);
      if (!Array.isArray(parsed)) throw new Error("not an array");
    } catch {
      setImportStatus("That doesn't look like a valid exported WebSDR list.");
      return;
    }

    let count = 0;
    for (const s of parsed) {
      if (!s.label || !s.url) continue;
      await invoke("upsert_websdr_station", {
        id: null,
        label: s.label,
        url: s.url,
        location: s.location ?? null,
        notes: s.notes ?? null,
      });
      count++;
    }
    setImportStatus(`Imported ${count} station(s). Duplicates aren't merged — remove any manually if needed.`);
    setImportText("");
    refresh();
  }

  return (
    <div className="panel-channels">
      <div className="bandplan-disclaimer">
        Operator-curated bookmarks, not a live aggregator — public WebSDR directories like websdr.org gate
        their receiver list against automated re-use, so this stays a list you build and share by hand.
      </div>
      <form className="resource-form channel-form" onSubmit={save}>
        <input value={label} onChange={(e) => setLabel(e.currentTarget.value)} placeholder="Label (e.g. Twente WebSDR)" />
        <input value={url} onChange={(e) => setUrl(e.currentTarget.value)} placeholder="URL (e.g. http://websdr.ewi.utwente.nl:8901/)" />
        <input value={location} onChange={(e) => setLocation(e.currentTarget.value)} placeholder="Location (optional)" />
        <button type="submit">{editingId !== null ? "Update" : "Add"}</button>
      </form>
      <input
        className="channel-notes-input"
        value={notes}
        onChange={(e) => setNotes(e.currentTarget.value)}
        placeholder="Notes (optional, e.g. band coverage)"
      />

      {stations.length === 0 ? (
        <div className="panel-alerts-empty">No WebSDR stations saved yet.</div>
      ) : (
        <div className="resource-list">
          {stations.map((s) => (
            <div key={s.id} className="resource-row">
              <div className="resource-header">
                <span className="resource-label">{s.label}</span>
                <button type="button" onClick={() => openUrl(s.url)}>
                  Open
                </button>
              </div>
              {(s.location || s.notes) && (
                <div className="resource-tokens">
                  {s.location && <span className="resource-chip">{s.location}</span>}
                  {s.notes && <span className="resource-chip">{s.notes}</span>}
                </div>
              )}
              <div className="resource-actions">
                <button type="button" onClick={() => edit(s)}>
                  Edit
                </button>
                <button type="button" onClick={() => remove(s.id)}>
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <button type="button" className="net-clear-button" onClick={shareOpen ? () => setShareOpen(false) : openShare}>
        {shareOpen ? "Close Share" : "Share / Import List"}
      </button>

      {shareOpen && (
        <div className="ics309-export">
          <span className="sw-label">Export — copy this and send it to another operator</span>
          <textarea readOnly value={exportText} rows={5} onClick={(e) => e.currentTarget.select()} />
          <button type="button" onClick={copyExport}>
            {copyState === "copied" ? "Copied" : "Copy to clipboard"}
          </button>

          <span className="sw-label">Import — paste a list someone shared with you</span>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.currentTarget.value)}
            rows={5}
            placeholder="Paste exported JSON here"
          />
          <button type="button" onClick={doImport} disabled={!importText.trim()}>
            Import
          </button>
          {importStatus && <div className="bandplan-disclaimer">{importStatus}</div>}
        </div>
      )}
    </div>
  );
}

export default WebSdrPanel;
