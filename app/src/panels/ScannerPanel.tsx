import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Mirrors citadel_scanner::ScannerTranscript / ScannerStatus.
interface ScannerTranscript {
  talkgroup: string | null;
  frequency_mhz: number | null;
  started_at: string | null;
  duration_sec: number | null;
  transcript_text: string | null;
}

interface ScannerStatus {
  status: string;
  updated_at: string | null;
  detail: string | null;
  transcripts: ScannerTranscript[];
}

// Mirrors citadel_scanner::ScannerConfigResponse.
interface ScannerConfigResponse {
  configured: boolean;
  config?: {
    sources: { center: number; rate: number; gain: number; driver: string; device?: string; ppm?: number }[];
    systems: { shortName: string; control_channels: number[] }[];
  };
  talkgroups_csv?: string;
}

type StatusState = { kind: "loading" } | { kind: "ready"; status: ScannerStatus } | { kind: "unreachable"; message: string };

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "done" } | { kind: "error"; message: string };

const STATUS_COLORS: Record<string, string> = { no_data: "#888", listening: "#39d97a", ok: "#39d97a", error: "#e64d4d" };

function ScannerPanel() {
  const [statusState, setStatusState] = useState<StatusState>({ kind: "loading" });
  const [shortName, setShortName] = useState("");
  const [driver, setDriver] = useState("osmosdr");
  const [device, setDevice] = useState("rtl=0");
  const [centerMhz, setCenterMhz] = useState("857.0");
  const [rateMhz, setRateMhz] = useState("8.0");
  const [gain, setGain] = useState("40");
  const [ppm, setPpm] = useState("");
  const [controlChannelsMhz, setControlChannelsMhz] = useState("");
  const [talkgroupsCsv, setTalkgroupsCsv] = useState("");
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const [configuredOnCitadel, setConfiguredOnCitadel] = useState(false);

  async function refreshStatus() {
    try {
      const status = await invoke<ScannerStatus>("get_citadel_scanner_status");
      setStatusState({ kind: "ready", status });
    } catch (err) {
      setStatusState({ kind: "unreachable", message: String(err) });
    }
  }

  async function loadExistingConfig() {
    try {
      const resp = await invoke<ScannerConfigResponse>("get_citadel_scanner_config");
      setConfiguredOnCitadel(resp.configured);
      if (resp.configured && resp.config) {
        const source = resp.config.sources[0];
        const system = resp.config.systems[0];
        setDriver(source.driver);
        setDevice(source.device ?? "");
        setCenterMhz((source.center / 1_000_000).toString());
        setRateMhz((source.rate / 1_000_000).toString());
        setGain(source.gain.toString());
        setPpm(source.ppm !== undefined ? source.ppm.toString() : "");
        setShortName(system.shortName);
        setControlChannelsMhz(system.control_channels.map((hz) => (hz / 1_000_000).toString()).join(", "));
        setTalkgroupsCsv(resp.talkgroups_csv ?? "");
      }
    } catch {
      // Citadel unreachable -- refreshStatus already surfaces that; the
      // form just starts blank, which is the right default anyway.
    }
  }

  useEffect(() => {
    refreshStatus();
    loadExistingConfig();
  }, []);

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setTalkgroupsCsv(await file.text());
  }

  async function saveConfig(e: React.FormEvent) {
    e.preventDefault();
    setSaveState({ kind: "saving" });
    try {
      const controlChannelsHz = controlChannelsMhz
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => Math.round(parseFloat(s) * 1_000_000));
      await invoke("save_citadel_scanner_config", {
        request: {
          short_name: shortName.trim(),
          driver,
          device: device.trim() || null,
          center_hz: parseFloat(centerMhz) * 1_000_000,
          rate_hz: parseFloat(rateMhz) * 1_000_000,
          gain: parseFloat(gain),
          control_channels_hz: controlChannelsHz,
          ppm: ppm.trim() ? parseFloat(ppm) : null,
          talkgroups_csv: talkgroupsCsv,
        },
      });
      setSaveState({ kind: "done" });
      setConfiguredOnCitadel(true);
      setTimeout(() => setSaveState({ kind: "idle" }), 3000);
    } catch (err) {
      setSaveState({ kind: "error", message: String(err) });
    }
  }

  return (
    <div className="panel-sync">
      <p className="sync-lede">
        Trunked-radio scanner (P25) status and setup. Citadel is the hardware side — the RTL-SDR dongle and the{" "}
        <code>trunk-recorder</code> decoder both run there — this panel is where you configure it and see what it
        hears, so all comms and emergency traffic stay in one place.
      </p>

      <div className="sync-section">
        <div className="sync-section-head">
          <h3>Live Status</h3>
        </div>
        {statusState.kind === "loading" && <div className="field-hint">Checking Citadel…</div>}
        {statusState.kind === "unreachable" && (
          <div className="sync-result sync-result-error">Could not reach Citadel: {statusState.message}</div>
        )}
        {statusState.kind === "ready" && (
          <>
            <div className="sync-result">
              <span style={{ color: STATUS_COLORS[statusState.status.status] ?? "#888", fontWeight: "bold" }}>
                {statusState.status.status.toUpperCase().replace("_", " ")}
              </span>
              {statusState.status.updated_at && <span className="field-hint"> — last update {statusState.status.updated_at}</span>}
              {statusState.status.detail && <div className="field-hint">{statusState.status.detail}</div>}
            </div>
            {statusState.status.transcripts.length > 0 && (
              <div className="sync-peer-list">
                {statusState.status.transcripts.map((t, i) => (
                  <div key={i} className="sync-peer-row">
                    <span className="sync-peer-callsign">{t.talkgroup ?? "Unknown talkgroup"}</span>
                    <span className="sync-peer-notes">
                      {t.frequency_mhz !== null ? `${t.frequency_mhz} MHz` : ""} {t.started_at ?? ""}
                      {t.transcript_text ? ` — ${t.transcript_text}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="sync-section">
        <div className="sync-section-head">
          <h3>Setup</h3>
        </div>
        <p className="field-hint">
          Trunked systems are local — every county runs different frequencies and talkgroups, so this can't be
          filled in automatically. You don't need a paid account anywhere: RadioReference's system and talkgroup
          pages are free to browse and copy by hand (a subscription only adds bulk CSV export and their API), and{" "}
          <a href="https://digitalfrequencysearch.com/P25" target="_blank" rel="noreferrer">
            digitalfrequencysearch.com
          </a>{" "}
          gives frequencies straight from FCC license filings with no account at all. Whatever you paste below —
          hand-typed, downloaded from RadioReference, or shared on OpenMHz — is accepted as long as it has{" "}
          <code>Decimal</code>, <code>Mode</code>, and <code>Description</code> columns.
        </p>
        {configuredOnCitadel && <div className="sync-result sync-result-ok">A scanner config already exists on Citadel — loaded below.</div>}
        <form className="sync-peer-form" onSubmit={saveConfig} style={{ flexDirection: "column", alignItems: "stretch" }}>
          <label className="field-hint">System name (short)</label>
          <input value={shortName} onChange={(e) => setShortName(e.currentTarget.value)} placeholder="e.g. cofire" maxLength={6} required />

          <label className="field-hint">SDR driver / device</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={driver} onChange={(e) => setDriver(e.currentTarget.value)} placeholder="osmosdr" />
            <input value={device} onChange={(e) => setDevice(e.currentTarget.value)} placeholder="rtl=0" />
          </div>

          <label className="field-hint">Center frequency (MHz) / sample rate (MHz) / gain / PPM (optional)</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={centerMhz} onChange={(e) => setCenterMhz(e.currentTarget.value)} placeholder="857.0" />
            <input value={rateMhz} onChange={(e) => setRateMhz(e.currentTarget.value)} placeholder="8.0" />
            <input value={gain} onChange={(e) => setGain(e.currentTarget.value)} placeholder="40" />
            <input value={ppm} onChange={(e) => setPpm(e.currentTarget.value)} placeholder="ppm" />
          </div>

          <label className="field-hint">Control channel frequencies (MHz, comma-separated)</label>
          <input
            value={controlChannelsMhz}
            onChange={(e) => setControlChannelsMhz(e.currentTarget.value)}
            placeholder="855.4625, 855.7375"
            required
          />

          <label className="field-hint">Talkgroups CSV (paste, or upload a file)</label>
          <input type="file" accept=".csv,text/csv" onChange={handleFileUpload} />
          <textarea
            value={talkgroupsCsv}
            onChange={(e) => setTalkgroupsCsv(e.currentTarget.value)}
            placeholder="Decimal,Mode,Description,Alpha Tag,Priority&#10;101,D,01 Dispatch,DCFD 01 Disp,1"
            rows={6}
            style={{ fontFamily: "monospace" }}
            required
          />

          <button type="submit" disabled={saveState.kind === "saving"}>
            {saveState.kind === "saving" ? "Saving…" : "Save to Citadel"}
          </button>
        </form>
        {saveState.kind === "done" && <div className="sync-result sync-result-ok">Saved — Citadel wrote a real trunk-recorder config.</div>}
        {saveState.kind === "error" && <div className="sync-result sync-result-error">{saveState.message}</div>}
      </div>
    </div>
  );
}

export default ScannerPanel;
