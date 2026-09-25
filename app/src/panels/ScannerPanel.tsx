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

// Mirrors citadel_scanner::ScannerSystem/ScannerActiveCall/ScannerRecorder/
// ScannerDecodeRate -- real trunk-recorder statusServer data via
// scanner_bridge.py, added 2026-09-06. Every field is a string because
// that's genuinely how trunk-recorder's own documented JSON sends them.
interface ScannerSystem {
  id: string | null;
  name: string | null;
  system_type: string | null;
  sysid: string | null;
  wacn: string | null;
  nac: string | null;
}

interface ScannerActiveCall {
  id: string | null;
  freq: string | null;
  system: string | null;
  talkgroup: string | null;
  talkgroup_tag: string | null;
  elapsed: string | null;
  length: string | null;
  state: string | null;
  encrypted: string | null;
  emergency: string | null;
  analog: string | null;
}

interface ScannerRecorder {
  id: string | null;
  recorder_type: string | null;
  src_num: string | null;
  rec_num: string | null;
  count: string | null;
  duration: string | null;
  state: string | null;
}

interface ScannerDecodeRate {
  id: string | null;
  decode_rate: string | null;
}

interface ScannerStatus {
  status: string;
  updated_at: string | null;
  detail: string | null;
  transcripts: ScannerTranscript[];
  systems: ScannerSystem[];
  active_calls: ScannerActiveCall[];
  recorders: ScannerRecorder[];
  decode_rates: ScannerDecodeRate[];
}

// Mirrors transcription::ScannerRecording.
interface ScannerRecording {
  filename: string;
  size_bytes: number;
  modified_at: number;
}

// Mirrors db::Incident, trimmed to the fields this panel actually uses.
interface IncidentSummary {
  uuid: string;
  name: string;
  status: "active" | "closed";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Mirrors citadel_scanner::ScannerConfigResponse.
interface ScannerConfigResponse {
  configured: boolean;
  config?: {
    sources: { center: number; rate: number; gain: number; driver: string; device?: string; ppm?: number }[];
    systems: { shortName: string; type: string; control_channels?: number[]; squelch?: number }[];
  };
  csv_data?: string;
}

// Mirrors citadel_scanner::ScannerProfile / ScannerProfilesResponse.
interface ScannerProfile {
  id: string;
  name: string;
  system_type: string;
  short_name: string;
  driver: string;
  device: string | null;
  center_hz: number;
  rate_hz: number;
  gain: number;
  control_channels_hz: number[];
  squelch: number;
  ppm: number | null;
  csv_data: string;
}

interface ScannerProfilesResponse {
  profiles: ScannerProfile[];
  active_profile_id: string | null;
}

const SYSTEM_TYPE_LABEL: Record<string, string> = {
  trunked: "Trunked P25",
  conventional: "Conventional (analog)",
  conventionalP25: "Conventional P25",
};

type SystemType = "trunked" | "conventional" | "conventionalP25";

type StatusState = { kind: "loading" } | { kind: "ready"; status: ScannerStatus } | { kind: "unreachable"; message: string };

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "done" } | { kind: "error"; message: string };

// Which `.scan-pill-*`/`.scan-tile-value-*` tier a raw status string reads
// as. "listening"/"ok" are the only real "good" values trunk-recorder or
// the bridge itself ever sends -- everything unrecognized reads as off
// rather than guessed-good, same honesty rule as the rest of the app.
function statusTier(status: string): "good" | "bad" | "off" {
  if (status === "listening" || status === "ok") return "good";
  if (status === "error") return "bad";
  return "off";
}

function ScannerPanel() {
  const [statusState, setStatusState] = useState<StatusState>({ kind: "loading" });
  const [systemType, setSystemType] = useState<SystemType>("trunked");
  const [shortName, setShortName] = useState("");
  const [driver, setDriver] = useState("osmosdr");
  const [device, setDevice] = useState("rtl=0");
  const [centerMhz, setCenterMhz] = useState("857.0");
  const [rateMhz, setRateMhz] = useState("8.0");
  const [gain, setGain] = useState("40");
  const [ppm, setPpm] = useState("");
  const [squelch, setSquelch] = useState("-50");
  const [controlChannelsMhz, setControlChannelsMhz] = useState("");
  const [talkgroupsCsv, setTalkgroupsCsv] = useState("");
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const [configuredOnCitadel, setConfiguredOnCitadel] = useState(false);

  const [recordings, setRecordings] = useState<ScannerRecording[]>([]);
  const [recordingsError, setRecordingsError] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<Record<string, string>>({});
  const [transcribeErrors, setTranscribeErrors] = useState<Record<string, string>>({});
  const [incidents, setIncidents] = useState<IncidentSummary[]>([]);
  const [incidentPicks, setIncidentPicks] = useState<Record<string, string>>({});
  const [loggedFilenames, setLoggedFilenames] = useState<Set<string>>(new Set());

  // Saved scanner profiles -- "like a Uniden BearCat," flip between a
  // trunked county system and a conventional Fire/EMS list without
  // re-filling the setup form each time. Real field request, 2026-09-16
  // (WayStation's own ROADMAP.md), built 2026-09-24.
  const [profiles, setProfiles] = useState<ScannerProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [busyProfileId, setBusyProfileId] = useState<string | null>(null);
  const [newProfileName, setNewProfileName] = useState("");
  const [profileSaveState, setProfileSaveState] = useState<SaveState>({ kind: "idle" });

  async function refreshRecordings() {
    try {
      setRecordings(await invoke<ScannerRecording[]>("get_scanner_recordings"));
      setRecordingsError(null);
    } catch (err) {
      setRecordingsError(String(err));
    }
  }

  async function loadIncidents() {
    try {
      setIncidents(await invoke<IncidentSummary[]>("get_incidents"));
    } catch {
      // Recordings still list/transcribe fine without this -- it only
      // disables the "log to incident timeline" step below.
    }
  }

  async function transcribe(filename: string) {
    setTranscribing(filename);
    try {
      const text = await invoke<string>("transcribe_recording", { filename });
      setTranscripts((prev) => ({ ...prev, [filename]: text }));
      setTranscribeErrors((prev) => {
        const next = { ...prev };
        delete next[filename];
        return next;
      });
    } catch (err) {
      setTranscribeErrors((prev) => ({ ...prev, [filename]: String(err) }));
    } finally {
      setTranscribing(null);
    }
  }

  async function logToIncident(filename: string) {
    const incidentId = incidentPicks[filename];
    const text = transcripts[filename];
    if (!incidentId || !text) return;
    await invoke("log_transcript_to_incident", { incidentId, filename, text });
    setLoggedFilenames((prev) => new Set(prev).add(filename));
  }

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
        setSystemType(system.type === "conventional" || system.type === "conventionalP25" ? system.type : "trunked");
        setControlChannelsMhz((system.control_channels ?? []).map((hz) => (hz / 1_000_000).toString()).join(", "));
        if (system.squelch !== undefined) setSquelch(system.squelch.toString());
        setTalkgroupsCsv(resp.csv_data ?? "");
      }
    } catch {
      // Citadel unreachable -- refreshStatus already surfaces that; the
      // form just starts blank, which is the right default anyway.
    }
  }

  async function refreshProfiles() {
    try {
      const resp = await invoke<ScannerProfilesResponse>("list_citadel_scanner_profiles");
      setProfiles(resp.profiles);
      setActiveProfileId(resp.active_profile_id);
      setProfilesError(null);
    } catch (err) {
      setProfilesError(String(err));
    }
  }

  useEffect(() => {
    refreshStatus();
    loadExistingConfig();
    refreshRecordings();
    loadIncidents();
    refreshProfiles();
  }, []);

  function loadProfileIntoForm(p: ScannerProfile) {
    setSystemType(p.system_type as SystemType);
    setShortName(p.short_name);
    setDriver(p.driver);
    setDevice(p.device ?? "");
    setCenterMhz((p.center_hz / 1_000_000).toString());
    setRateMhz((p.rate_hz / 1_000_000).toString());
    setGain(p.gain.toString());
    setPpm(p.ppm !== null ? p.ppm.toString() : "");
    setSquelch(p.squelch.toString());
    setControlChannelsMhz(p.control_channels_hz.map((hz) => (hz / 1_000_000).toString()).join(", "));
    setTalkgroupsCsv(p.csv_data);
  }

  async function activateProfile(id: string) {
    setBusyProfileId(id);
    try {
      await invoke("activate_citadel_scanner_profile", { profileId: id });
      const activated = profiles.find((p) => p.id === id);
      if (activated) loadProfileIntoForm(activated);
      setConfiguredOnCitadel(true);
      await refreshProfiles();
    } catch (err) {
      setProfilesError(String(err));
    } finally {
      setBusyProfileId(null);
    }
  }

  async function deleteProfile(id: string) {
    setBusyProfileId(id);
    try {
      await invoke("delete_citadel_scanner_profile", { profileId: id });
      await refreshProfiles();
    } catch (err) {
      setProfilesError(String(err));
    } finally {
      setBusyProfileId(null);
    }
  }

  async function saveCurrentAsProfile(e: React.FormEvent) {
    e.preventDefault();
    setProfileSaveState({ kind: "saving" });
    try {
      const controlChannelsHz = controlChannelsMhz
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => Math.round(parseFloat(s) * 1_000_000));
      await invoke("save_citadel_scanner_profile", {
        request: {
          name: newProfileName.trim(),
          system_type: systemType,
          short_name: shortName.trim(),
          driver,
          device: device.trim() || null,
          center_hz: parseFloat(centerMhz) * 1_000_000,
          rate_hz: parseFloat(rateMhz) * 1_000_000,
          gain: parseFloat(gain),
          control_channels_hz: controlChannelsHz,
          squelch: parseFloat(squelch),
          ppm: ppm.trim() ? parseFloat(ppm) : null,
          csv_data: talkgroupsCsv,
        },
      });
      setProfileSaveState({ kind: "done" });
      setNewProfileName("");
      await refreshProfiles();
      setTimeout(() => setProfileSaveState({ kind: "idle" }), 3000);
    } catch (err) {
      setProfileSaveState({ kind: "error", message: String(err) });
    }
  }

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
          system_type: systemType,
          short_name: shortName.trim(),
          driver,
          device: device.trim() || null,
          center_hz: parseFloat(centerMhz) * 1_000_000,
          rate_hz: parseFloat(rateMhz) * 1_000_000,
          gain: parseFloat(gain),
          control_channels_hz: controlChannelsHz,
          squelch: parseFloat(squelch),
          ppm: ppm.trim() ? parseFloat(ppm) : null,
          csv_data: talkgroupsCsv,
        },
      });
      setSaveState({ kind: "done" });
      setConfiguredOnCitadel(true);
      setTimeout(() => setSaveState({ kind: "idle" }), 3000);
    } catch (err) {
      setSaveState({ kind: "error", message: String(err) });
    }
  }

  const status = statusState.kind === "ready" ? statusState.status : null;
  const tier = status ? statusTier(status.status) : "off";

  return (
    <div className="scan-root">
      <div className="scan-header">
        <div className="scan-header-icon">📡</div>
        <div className="scan-header-text">
          <div className="scan-header-title">Scanner</div>
          <div className="scan-header-tagline">Trunked &amp; conventional P25 · live status from Citadel's trunk-recorder</div>
        </div>
      </div>

      <p className="scan-lede">
        Trunked-radio scanner (P25) status and setup. Citadel is the hardware side — the RTL-SDR dongle and the{" "}
        <code>trunk-recorder</code> decoder both run there — this panel is where you configure it and see what it
        hears, so all comms and emergency traffic stay in one place.
      </p>

      <div className="scan-status-row">
        <div className="scan-status-left">
          <span className={`scan-pill scan-pill-${tier}`}>
            <span className="scan-dot" />
            {status ? status.status.toUpperCase().replace("_", " ") : statusState.kind === "loading" ? "CHECKING…" : "UNREACHABLE"}
          </span>
          <span className="scan-status-name">TRUNK-RECORDER</span>
        </div>
        {status?.updated_at && <span className="scan-status-detail">last update {status.updated_at}</span>}
      </div>

      {statusState.kind === "unreachable" && (
        <div className="scan-result scan-result-error">Could not reach Citadel: {statusState.message}</div>
      )}

      {status && (
        <>
          {status.detail && <div className="scan-hint">{status.detail}</div>}

          <div className="scan-tiles">
            <div className="scan-tile">
              <span className="scan-tile-label">Systems</span>
              <span className="scan-tile-value">{status.systems.length}</span>
            </div>
            <div className="scan-tile">
              <span className="scan-tile-label">Active Talkgroups</span>
              <span className={`scan-tile-value ${status.active_calls.length > 0 ? "scan-tile-value-good" : ""}`}>
                {status.active_calls.length}
              </span>
            </div>
            <div className="scan-tile">
              <span className="scan-tile-label">Recorders</span>
              <span className="scan-tile-value">{status.recorders.length}</span>
            </div>
          </div>

          {status.transcripts.length > 0 && (
            <div className="scan-section">
              <div className="scan-section-head">
                <h3>Recent Transcripts</h3>
              </div>
              <div className="scan-table-wrap">
                <table className="scan-table">
                  <thead>
                    <tr>
                      <th>Talkgroup</th>
                      <th>Freq</th>
                      <th>Started</th>
                      <th>Transcript</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.transcripts.map((t, i) => (
                      <tr key={i}>
                        <td>{t.talkgroup ?? "Unknown talkgroup"}</td>
                        <td className="mono">{t.frequency_mhz !== null ? `${t.frequency_mhz} MHz` : "—"}</td>
                        <td className="mono">{t.started_at ?? "—"}</td>
                        <td>{t.transcript_text ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {status.systems.length > 0 && (
            <div className="scan-section">
              <div className="scan-section-head">
                <h3>Systems</h3>
              </div>
              <div className="scan-table-wrap">
                <table className="scan-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Sys ID</th>
                      <th>WACN</th>
                      <th>NAC</th>
                      <th>Active TGs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.systems.map((s, i) => (
                      <tr key={i}>
                        <td>{s.name ?? "—"}</td>
                        <td>{s.system_type ?? "—"}</td>
                        <td className="mono">{s.sysid ?? "—"}</td>
                        <td className="mono">{s.wacn ?? "—"}</td>
                        <td className="mono">{s.nac ?? "—"}</td>
                        <td className="mono">{status.active_calls.filter((c) => c.system === s.name).length}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="scan-section">
            <div className="scan-section-head">
              <h3>Active Talkgroups (Live)</h3>
            </div>
            {status.active_calls.length === 0 ? (
              <div className="scan-empty">No active calls right now.</div>
            ) : (
              <div className="scan-table-wrap">
                <table className="scan-table">
                  <thead>
                    <tr>
                      <th>System</th>
                      <th>TGID</th>
                      <th>Tag</th>
                      <th>Freq (Hz)</th>
                      <th>Elapsed (s)</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.active_calls.map((c, i) => (
                      <tr key={i}>
                        <td>{c.system ?? "—"}</td>
                        <td className="mono">{c.talkgroup ?? "—"}</td>
                        <td>{c.talkgroup_tag ?? "—"}</td>
                        <td className="mono">{c.freq ?? "—"}</td>
                        <td className="mono">{c.elapsed ?? "—"}</td>
                        <td>
                          {c.emergency === "1" && <span className="scan-emergency">EMERGENCY </span>}
                          {c.encrypted === "1" ? "Encrypted" : c.state ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {status.recorders.length > 0 && (
            <div className="scan-section">
              <div className="scan-section-head">
                <h3>Recorder Health</h3>
              </div>
              <div className="scan-table-wrap">
                <table className="scan-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Type</th>
                      <th>State</th>
                      <th>Recordings</th>
                      <th>Last Duration (s)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.recorders.map((r, i) => (
                      <tr key={i}>
                        <td className="mono">{r.id ?? "—"}</td>
                        <td>{r.recorder_type ?? "—"}</td>
                        <td>{r.state ?? "—"}</td>
                        <td className="mono">{r.count ?? "—"}</td>
                        <td className="mono">{r.duration ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {status.systems.length === 0 && status.status === "no_data" && (
            <div className="scan-hint">
              Nothing has connected yet. Once trunk-recorder is running with a real config (see Setup below) and
              its <code>statusServer</code> is reachable, real systems, live talkgroup activity, and recorder
              health will show up here automatically.
            </div>
          )}
        </>
      )}

      <div className="scan-section">
        <div className="scan-section-head">
          <h3>Recordings</h3>
        </div>
        <p className="scan-hint">
          Real call audio trunk-recorder has captured, transcribed on Citadel by a real local Whisper.cpp
          model — nothing leaves this network. Empty until a real RTL-SDR dongle has actually captured
          something.
        </p>
        {recordingsError && <div className="scan-result scan-result-error">Could not reach Citadel: {recordingsError}</div>}
        {!recordingsError && recordings.length === 0 && <div className="scan-empty">No recordings captured yet.</div>}
        {recordings.length > 0 && (
          <div className="scan-table-wrap">
            <table className="scan-table">
              <thead>
                <tr>
                  <th>Filename</th>
                  <th>Size</th>
                  <th>Captured</th>
                  <th>Transcript</th>
                </tr>
              </thead>
              <tbody>
                {recordings.map((r) => {
                  const activeIncidents = incidents.filter((i) => i.status === "active");
                  return (
                    <tr key={r.filename}>
                      <td className="mono">{r.filename}</td>
                      <td className="mono">{formatBytes(r.size_bytes)}</td>
                      <td className="mono">{new Date(r.modified_at * 1000).toLocaleString()}</td>
                      <td>
                        {transcripts[r.filename] ? (
                          <div>
                            <div>{transcripts[r.filename]}</div>
                            {loggedFilenames.has(r.filename) ? (
                              <span className="scan-hint">Logged to timeline.</span>
                            ) : (
                              activeIncidents.length > 0 && (
                                <div className="scan-form-row" style={{ marginTop: "0.3rem" }}>
                                  <select
                                    value={incidentPicks[r.filename] ?? ""}
                                    onChange={(e) => setIncidentPicks((prev) => ({ ...prev, [r.filename]: e.currentTarget.value }))}
                                  >
                                    <option value="">Log to incident…</option>
                                    {activeIncidents.map((i) => (
                                      <option key={i.uuid} value={i.uuid}>
                                        {i.name}
                                      </option>
                                    ))}
                                  </select>
                                  <button type="button" onClick={() => logToIncident(r.filename)} disabled={!incidentPicks[r.filename]}>
                                    Log
                                  </button>
                                </div>
                              )
                            )}
                          </div>
                        ) : transcribeErrors[r.filename] ? (
                          <div>
                            <span className="scan-emergency">{transcribeErrors[r.filename]}</span>{" "}
                            <button type="button" onClick={() => transcribe(r.filename)} disabled={transcribing === r.filename}>
                              Retry
                            </button>
                          </div>
                        ) : (
                          <button type="button" onClick={() => transcribe(r.filename)} disabled={transcribing === r.filename}>
                            {transcribing === r.filename ? "Transcribing…" : "Transcribe"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="scan-section">
        <div className="scan-section-head">
          <h3>Saved Profiles</h3>
        </div>
        <p className="scan-hint">
          Save several complete scanner setups — a trunked county system and a conventional Fire/EMS list, say — and
          switch between them with one tap, instead of re-filling the whole Setup form each time. Activating a
          profile makes it the live config on Citadel, exactly like Save to Citadel below.
        </p>
        {profilesError && <div className="scan-result scan-result-error">Could not reach Citadel: {profilesError}</div>}
        {profiles.length === 0 && !profilesError && <div className="scan-empty">No saved profiles yet — fill out Setup below, then save it as one.</div>}
        {profiles.length > 0 && (
          <div className="scan-table-wrap">
            <table className="scan-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.name}
                      {p.id === activeProfileId && <span className="scan-pill scan-pill-good" style={{ marginLeft: "0.5rem" }}>ACTIVE</span>}
                    </td>
                    <td>{SYSTEM_TYPE_LABEL[p.system_type] ?? p.system_type}</td>
                    <td>
                      <div className="scan-form-row">
                        <button type="button" onClick={() => activateProfile(p.id)} disabled={busyProfileId === p.id || p.id === activeProfileId}>
                          {busyProfileId === p.id ? "Activating…" : p.id === activeProfileId ? "Active" : "Activate"}
                        </button>
                        <button type="button" onClick={() => deleteProfile(p.id)} disabled={busyProfileId === p.id}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form className="scan-form-row" onSubmit={saveCurrentAsProfile} style={{ marginTop: "0.75rem" }}>
          <input
            value={newProfileName}
            onChange={(e) => setNewProfileName(e.currentTarget.value)}
            placeholder="Name this setup, e.g. PANCOM Fire/EMS"
            required
          />
          <button type="submit" disabled={profileSaveState.kind === "saving"}>
            {profileSaveState.kind === "saving" ? "Saving…" : "Save Setup Below As Profile"}
          </button>
        </form>
        {profileSaveState.kind === "done" && <div className="scan-result scan-result-ok">Profile saved.</div>}
        {profileSaveState.kind === "error" && <div className="scan-result scan-result-error">{profileSaveState.message}</div>}
      </div>

      <div className="scan-section">
        <div className="scan-section-head">
          <h3>Setup</h3>
        </div>
        <p className="scan-hint">
          Trunked systems (single control channel, many talkgroups) and conventional systems (each channel on its
          own fixed frequency — typical for county Sheriff/Fire/EMS dispatch) are both real, different shapes;
          pick the one that matches what you actually have. Local systems are never automatic — every county
          runs different frequencies. You don't need a paid account anywhere: RadioReference's system and
          talkgroup pages are free to browse and copy by hand (a subscription only adds bulk CSV export and their
          API), and{" "}
          <a href="https://digitalfrequencysearch.com/P25" target="_blank" rel="noreferrer">
            digitalfrequencysearch.com
          </a>{" "}
          gives frequencies straight from FCC license filings with no account at all.
        </p>
        {configuredOnCitadel && <div className="scan-result scan-result-ok">A scanner config already exists on Citadel — loaded below.</div>}
        <form className="scan-form" onSubmit={saveConfig}>
          <label>System type</label>
          <select value={systemType} onChange={(e) => setSystemType(e.currentTarget.value as SystemType)}>
            <option value="trunked">Trunked (P25) — one control channel, many talkgroups</option>
            <option value="conventional">Conventional — fixed-frequency channels, analog</option>
            <option value="conventionalP25">Conventional — fixed-frequency channels, P25 digital</option>
          </select>

          <label>System name (short)</label>
          <input value={shortName} onChange={(e) => setShortName(e.currentTarget.value)} placeholder="e.g. cofire" maxLength={6} required />

          <label>SDR driver / device</label>
          <div className="scan-form-row">
            <input value={driver} onChange={(e) => setDriver(e.currentTarget.value)} placeholder="osmosdr" />
            <input value={device} onChange={(e) => setDevice(e.currentTarget.value)} placeholder="rtl=0" />
          </div>

          <label>Center frequency (MHz) / sample rate (MHz) / gain / PPM (optional)</label>
          <div className="scan-form-row">
            <input value={centerMhz} onChange={(e) => setCenterMhz(e.currentTarget.value)} placeholder="857.0" />
            <input value={rateMhz} onChange={(e) => setRateMhz(e.currentTarget.value)} placeholder="8.0" />
            <input value={gain} onChange={(e) => setGain(e.currentTarget.value)} placeholder="40" />
            <input value={ppm} onChange={(e) => setPpm(e.currentTarget.value)} placeholder="ppm" />
          </div>

          {systemType === "trunked" ? (
            <>
              <label>Control channel frequencies (MHz, comma-separated)</label>
              <input
                value={controlChannelsMhz}
                onChange={(e) => setControlChannelsMhz(e.currentTarget.value)}
                placeholder="855.4625, 855.7375"
                required
              />

              <label>Talkgroups CSV (paste, or upload a file)</label>
              <input type="file" accept=".csv,text/csv" onChange={handleFileUpload} />
              <textarea
                value={talkgroupsCsv}
                onChange={(e) => setTalkgroupsCsv(e.currentTarget.value)}
                placeholder="Decimal,Mode,Description,Alpha Tag,Priority&#10;101,D,01 Dispatch,DCFD 01 Disp,1"
                rows={6}
                required
              />
            </>
          ) : (
            <>
              <label>Squelch (dB)</label>
              <input value={squelch} onChange={(e) => setSquelch(e.currentTarget.value)} placeholder="-50" required />

              <label>Channel list CSV (paste, or upload a file)</label>
              <p className="scan-hint">
                <code>TG Number</code> must be the first column (any whole number — these frequencies don't have
                real talkgroup numbers, just make one up per row) and <code>Frequency</code> is required.{" "}
                <code>Tone</code> (CTCSS, analog only), <code>Alpha Tag</code>, and <code>Description</code> are
                optional but make the setup easier to read later.
              </p>
              <input type="file" accept=".csv,text/csv" onChange={handleFileUpload} />
              <textarea
                value={talkgroupsCsv}
                onChange={(e) => setTalkgroupsCsv(e.currentTarget.value)}
                placeholder={
                  "TG Number,Frequency,Tone,Alpha Tag,Description\n1,155.7750,114.8,Sheriff Disp,County Sheriff Dispatch"
                }
                rows={6}
                required
              />
            </>
          )}

          <button className="scan-submit-btn" type="submit" disabled={saveState.kind === "saving"}>
            {saveState.kind === "saving" ? "Saving…" : "Save to Citadel"}
          </button>
        </form>
        {saveState.kind === "done" && <div className="scan-result scan-result-ok">Saved — Citadel wrote a real trunk-recorder config.</div>}
        {saveState.kind === "error" && <div className="scan-result scan-result-error">{saveState.message}</div>}
      </div>
    </div>
  );
}

export default ScannerPanel;
