import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface QsoLogEntry {
  id: number;
  call: string;
  qso_date: string;
  time_on: string;
  band: string | null;
  freq_mhz: number | null;
  mode: string;
  rst_sent: string | null;
  rst_rcvd: string | null;
  name: string | null;
  gridsquare: string | null;
  comment: string | null;
  updated_at: string;
}

const BANDS = ["160m", "80m", "60m", "40m", "30m", "20m", "17m", "15m", "12m", "10m", "6m", "2m", "1.25m", "70cm", "33cm", "23cm"];

function nowDateTime(): { date: string; time: string } {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  return { date, time };
}

function QsoLogPanel() {
  const [entries, setEntries] = useState<QsoLogEntry[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);

  const [call, setCall] = useState("");
  const [qsoDate, setQsoDate] = useState("");
  const [timeOn, setTimeOn] = useState("");
  const [band, setBand] = useState("20m");
  const [freqMhz, setFreqMhz] = useState("");
  const [mode, setMode] = useState("SSB");
  const [rstSent, setRstSent] = useState("");
  const [rstRcvd, setRstRcvd] = useState("");
  const [name, setName] = useState("");
  const [gridsquare, setGridsquare] = useState("");
  const [comment, setComment] = useState("");

  const [exportOpen, setExportOpen] = useState(false);
  const [exportText, setExportText] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  async function refresh() {
    setEntries(await invoke<QsoLogEntry[]>("get_qso_log"));
  }

  useEffect(() => {
    refresh();
    const { date, time } = nowDateTime();
    setQsoDate(date);
    setTimeOn(time);
  }, []);

  function resetForm() {
    setEditingId(null);
    setCall("");
    const { date, time } = nowDateTime();
    setQsoDate(date);
    setTimeOn(time);
    setBand("20m");
    setFreqMhz("");
    setMode("SSB");
    setRstSent("");
    setRstRcvd("");
    setName("");
    setGridsquare("");
    setComment("");
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!call.trim() || !qsoDate.trim() || !timeOn.trim() || !mode.trim()) return;
    await invoke("upsert_qso_log_entry", {
      id: editingId,
      call: call.toUpperCase(),
      qsoDate,
      timeOn,
      band: band || null,
      freqMhz: freqMhz ? Number(freqMhz) : null,
      mode,
      rstSent: rstSent || null,
      rstRcvd: rstRcvd || null,
      name: name || null,
      gridsquare: gridsquare || null,
      comment: comment || null,
    });
    resetForm();
    refresh();
  }

  function edit(q: QsoLogEntry) {
    setEditingId(q.id);
    setCall(q.call);
    setQsoDate(q.qso_date);
    setTimeOn(q.time_on);
    setBand(q.band ?? "20m");
    setFreqMhz(q.freq_mhz !== null ? String(q.freq_mhz) : "");
    setMode(q.mode);
    setRstSent(q.rst_sent ?? "");
    setRstRcvd(q.rst_rcvd ?? "");
    setName(q.name ?? "");
    setGridsquare(q.gridsquare ?? "");
    setComment(q.comment ?? "");
  }

  async function remove(id: number) {
    await invoke("delete_qso_log_entry", { id });
    if (editingId === id) resetForm();
    refresh();
  }

  async function openExport() {
    setExportText(await invoke<string>("export_qso_log_adif"));
    setCopyState("idle");
    setExportOpen(true);
  }

  async function copyExport() {
    try {
      await navigator.clipboard.writeText(exportText);
      setCopyState("copied");
    } catch {
      // Clipboard API can be unavailable — the textarea itself is the fallback (click to select-all).
    }
  }

  // Same call worked on the same band and mode already — the standard
  // dupe definition in ham radio logging/contesting. A warning, not a
  // block: repeat contacts are sometimes intentional (different day,
  // QSL confirmation, etc.), so this never prevents logging.
  const dupes =
    call.trim().length > 0
      ? entries.filter(
          (q) =>
            q.id !== editingId &&
            q.call.toUpperCase() === call.trim().toUpperCase() &&
            (q.band ?? "") === band &&
            q.mode.toUpperCase() === mode.trim().toUpperCase(),
        )
      : [];

  return (
    <div className="panel-channels">
      <form className="resource-form channel-form" onSubmit={save}>
        <input value={call} onChange={(e) => setCall(e.currentTarget.value)} placeholder="Callsign" />
        <input value={qsoDate} onChange={(e) => setQsoDate(e.currentTarget.value)} placeholder="Date (YYYYMMDD)" />
        <input value={timeOn} onChange={(e) => setTimeOn(e.currentTarget.value)} placeholder="Time (HHMMSS, UTC)" />
        <select value={band} onChange={(e) => setBand(e.currentTarget.value)}>
          {BANDS.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <input value={mode} onChange={(e) => setMode(e.currentTarget.value)} placeholder="Mode (SSB, CW, FT8...)" />
        <button type="submit">{editingId !== null ? "Update" : "Log QSO"}</button>
      </form>
      <div className="resource-form channel-form">
        <input value={freqMhz} onChange={(e) => setFreqMhz(e.currentTarget.value)} placeholder="Freq MHz (optional)" />
        <input value={rstSent} onChange={(e) => setRstSent(e.currentTarget.value)} placeholder="RST sent" />
        <input value={rstRcvd} onChange={(e) => setRstRcvd(e.currentTarget.value)} placeholder="RST rcvd" />
        <input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Name (optional)" />
        <input value={gridsquare} onChange={(e) => setGridsquare(e.currentTarget.value)} placeholder="Grid (optional)" />
      </div>
      <input
        className="channel-notes-input"
        value={comment}
        onChange={(e) => setComment(e.currentTarget.value)}
        placeholder="Comment (optional)"
      />

      {dupes.length > 0 && (
        <div className="qso-dupe-warning">
          Possible dupe: {call.toUpperCase()} already worked on {band || "(no band)"}/{mode} — {dupes.length} prior
          contact{dupes.length > 1 ? "s" : ""}, most recent {dupes[0].qso_date} {dupes[0].time_on}Z. Logging again is
          still allowed.
        </div>
      )}

      {entries.length === 0 ? (
        <div className="panel-alerts-empty">No QSOs logged yet.</div>
      ) : (
        <div className="resource-list">
          {entries.map((q) => (
            <div key={q.id} className="resource-row">
              <div className="resource-header">
                <span className="resource-label">{q.call}</span>
                <span>
                  {q.qso_date} {q.time_on}Z
                </span>
              </div>
              <div className="resource-tokens">
                {q.band && <span className="resource-chip">{q.band}</span>}
                <span className="resource-chip">{q.mode}</span>
                {q.rst_sent && <span className="resource-chip">TX {q.rst_sent}</span>}
                {q.rst_rcvd && <span className="resource-chip">RX {q.rst_rcvd}</span>}
                {q.name && <span className="resource-chip">{q.name}</span>}
                {q.gridsquare && <span className="resource-chip">{q.gridsquare}</span>}
              </div>
              <div className="resource-actions">
                <button type="button" onClick={() => edit(q)}>
                  Edit
                </button>
                <button type="button" onClick={() => remove(q.id)}>
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <button type="button" className="net-clear-button" onClick={exportOpen ? () => setExportOpen(false) : openExport}>
        {exportOpen ? "Close Export" : "Export ADIF"}
      </button>

      {exportOpen && (
        <div className="ics309-export">
          <span className="sw-label">ADIF export — paste into your logging program, or save as a .adi file</span>
          <textarea readOnly value={exportText} rows={8} onClick={(e) => e.currentTarget.select()} />
          <button type="button" onClick={copyExport}>
            {copyState === "copied" ? "Copied" : "Copy to clipboard"}
          </button>
        </div>
      )}
    </div>
  );
}

export default QsoLogPanel;
