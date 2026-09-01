import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Channel {
  id: number;
  label: string;
  frequency: string;
  tone_offset: string | null;
  notes: string | null;
  updated_at: string;
}

interface ShareableChannel {
  label: string;
  frequency: string;
  tone_offset: string | null;
  notes: string | null;
}

function ChannelDirectoryPanel() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [label, setLabel] = useState("");
  const [frequency, setFrequency] = useState("");
  const [toneOffset, setToneOffset] = useState("");
  const [notes, setNotes] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);

  const [shareOpen, setShareOpen] = useState(false);
  const [exportText, setExportText] = useState("");
  const [importText, setImportText] = useState("");
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  async function refresh() {
    setChannels(await invoke<Channel[]>("get_channels"));
  }

  useEffect(() => {
    refresh();
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim() || !frequency.trim()) return;
    await invoke("upsert_channel", {
      id: editingId,
      label,
      frequency,
      toneOffset: toneOffset || null,
      notes: notes || null,
    });
    setLabel("");
    setFrequency("");
    setToneOffset("");
    setNotes("");
    setEditingId(null);
    refresh();
  }

  function edit(c: Channel) {
    setEditingId(c.id);
    setLabel(c.label);
    setFrequency(c.frequency);
    setToneOffset(c.tone_offset ?? "");
    setNotes(c.notes ?? "");
  }

  async function remove(id: number) {
    await invoke("delete_channel", { id });
    if (editingId === id) {
      setEditingId(null);
      setLabel("");
      setFrequency("");
      setToneOffset("");
      setNotes("");
    }
    refresh();
  }

  function openShare() {
    const shareable: ShareableChannel[] = channels.map((c) => ({
      label: c.label,
      frequency: c.frequency,
      tone_offset: c.tone_offset,
      notes: c.notes,
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
    let parsed: ShareableChannel[];
    try {
      parsed = JSON.parse(importText);
      if (!Array.isArray(parsed)) throw new Error("not an array");
    } catch {
      setImportStatus("That doesn't look like a valid exported channel list.");
      return;
    }

    let count = 0;
    for (const c of parsed) {
      if (!c.label || !c.frequency) continue;
      await invoke("upsert_channel", {
        id: null,
        label: c.label,
        frequency: c.frequency,
        toneOffset: c.tone_offset ?? null,
        notes: c.notes ?? null,
      });
      count++;
    }
    setImportStatus(`Imported ${count} channel(s). Duplicates aren't merged — remove any manually if needed.`);
    setImportText("");
    refresh();
  }

  return (
    <div className="panel-channels">
      <form className="resource-form channel-form" onSubmit={save}>
        <input value={label} onChange={(e) => setLabel(e.currentTarget.value)} placeholder="Label (e.g. Donley Co ARES)" />
        <input value={frequency} onChange={(e) => setFrequency(e.currentTarget.value)} placeholder="Frequency (e.g. 146.940-)" />
        <input value={toneOffset} onChange={(e) => setToneOffset(e.currentTarget.value)} placeholder="Tone/offset (optional)" />
        <button type="submit">{editingId !== null ? "Update" : "Add"}</button>
      </form>
      <input
        className="channel-notes-input"
        value={notes}
        onChange={(e) => setNotes(e.currentTarget.value)}
        placeholder="Notes (optional)"
      />

      {channels.length === 0 ? (
        <div className="panel-alerts-empty">No channels logged yet.</div>
      ) : (
        <div className="resource-list">
          {channels.map((c) => (
            <div key={c.id} className="resource-row">
              <div className="resource-header">
                <span className="resource-label">{c.label}</span>
                <span>{c.frequency}</span>
              </div>
              {(c.tone_offset || c.notes) && (
                <div className="resource-tokens">
                  {c.tone_offset && <span className="resource-chip">{c.tone_offset}</span>}
                  {c.notes && <span className="resource-chip">{c.notes}</span>}
                </div>
              )}
              <div className="resource-actions">
                <button type="button" onClick={() => edit(c)}>
                  Edit
                </button>
                <button type="button" onClick={() => remove(c.id)}>
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

export default ChannelDirectoryPanel;
