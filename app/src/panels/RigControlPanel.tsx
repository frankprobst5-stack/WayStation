import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface RigStatus {
  reachable: boolean;
  enabled: boolean;
  remote_target: boolean;
  target: string;
  frequency_hz: number | null;
  mode: string | null;
  passband_hz: number | null;
  split: boolean | null;
  sat_mode: boolean | null;
  strength_db: number | null;
  detail: string | null;
}

// Fast enough to feel live while tuning, slow enough to stay polite on a
// serial link shared with other software.
const POLL_MS = 2000;

const MODES = ["USB", "LSB", "CW", "CWR", "AM", "FM", "RTTY", "PKTUSB", "PKTLSB"];

// Amateur bands by lower/upper bound in Hz. Only used for a label, so
// region-specific edges aren't worth encoding here — the Band Plan panel
// is the authority.
const BANDS: [number, number, string][] = [
  [1_800_000, 2_000_000, "160m"],
  [3_500_000, 4_000_000, "80m"],
  [5_330_000, 5_410_000, "60m"],
  [7_000_000, 7_300_000, "40m"],
  [10_100_000, 10_150_000, "30m"],
  [14_000_000, 14_350_000, "20m"],
  [18_068_000, 18_168_000, "17m"],
  [21_000_000, 21_450_000, "15m"],
  [24_890_000, 24_990_000, "12m"],
  [28_000_000, 29_700_000, "10m"],
  [50_000_000, 54_000_000, "6m"],
  [144_000_000, 148_000_000, "2m"],
  [222_000_000, 225_000_000, "1.25m"],
  [420_000_000, 450_000_000, "70cm"],
];

function bandFor(hz: number): string | null {
  return BANDS.find(([lo, hi]) => hz >= lo && hz <= hi)?.[2] ?? null;
}

function formatFreq(hz: number): string {
  return (hz / 1_000_000).toFixed(6);
}

// Hamlib reports strength in dB relative to S9. Hams read S-units, so
// convert: S9 is 0 dB and each S-unit below it is 6 dB down.
function formatStrength(db: number): string {
  if (db >= 0) return `S9+${db} dB`;
  const s = Math.max(0, Math.floor(9 + db / 6));
  return `S${s}`;
}

function RigControlPanel() {
  const [status, setStatus] = useState<RigStatus | null>(null);
  const [freqInput, setFreqInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setStatus(await invoke<RigStatus>("get_rig_status"));
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, []);

  async function tune(e: React.FormEvent) {
    e.preventDefault();
    const mhz = Number(freqInput);
    if (!Number.isFinite(mhz) || mhz <= 0) {
      setError("Enter a frequency in MHz, e.g. 14.074");
      return;
    }
    setError(null);
    try {
      await invoke("set_rig_frequency", { hz: Math.round(mhz * 1_000_000) });
      setFreqInput("");
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  async function changeMode(mode: string) {
    setError(null);
    try {
      // 0 tells Hamlib to use the rig's default passband for the mode,
      // rather than us inventing a width the radio may not accept.
      await invoke("set_rig_mode", { mode, passbandHz: 0 });
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  if (!status) {
    return <div className="panel-rig">Loading...</div>;
  }

  if (!status.enabled) {
    return (
      <div className="panel-rig">
        <div className="alert-header">
          <span>Rig control is off</span>
        </div>
        <div className="rig-hint">
          Waystation isn't connecting to a radio. Turn it on in <strong>Settings → Station</strong>.
        </div>
      </div>
    );
  }

  if (!status.reachable) {
    return (
      <div className="panel-rig">
        <div className="alert-header">
          <span>No radio connected</span>
          <span className="resource-chip">{status.target}</span>
        </div>
        <div className="rig-hint">
          Waystation talks to your radio through <strong>rigctld</strong> (part of Hamlib), which it
          does not start for you — a radio's serial port can only be opened by one program at a
          time, and you may already be sharing it with WSJT-X or a logger.
          <code className="rig-cmd">rigctld -m &lt;model&gt; -r /dev/ttyUSB0</code>
          Run <code>rigctl --list</code> to find your model number. Model 1 is a dummy rig for
          trying this out with no hardware at all.
        </div>
      </div>
    );
  }

  const band = status.frequency_hz ? bandFor(status.frequency_hz) : null;

  return (
    <div className="panel-rig">
      <div className="alert-header">
        <span>Connected</span>
        <span className="mesh-header-right">
          {status.split && <span className="resource-chip">SPLIT</span>}
          {status.sat_mode && <span className="resource-chip">SAT</span>}
          <span className="resource-chip">{status.target}</span>
        </span>
      </div>

      {status.detail && <div className="winlink-warning">{status.detail}</div>}

      {status.remote_target && (
        <div className="winlink-warning">
          Controlling a radio across the network. rigctld has no authentication — make sure this
          only travels over a VPN or SSH tunnel.
        </div>
      )}

      <div className="rig-readout">
        <div className="rig-freq">
          {status.frequency_hz !== null ? formatFreq(status.frequency_hz) : "—"}
          <span className="rig-unit">MHz</span>
        </div>
        <div className="rig-chips">
          {band && <span className="resource-chip">{band}</span>}
          {status.mode && <span className="resource-chip">{status.mode}</span>}
          {status.passband_hz ? <span className="resource-chip">{status.passband_hz} Hz</span> : null}
          {status.strength_db !== null && (
            <span className="resource-chip">{formatStrength(status.strength_db)}</span>
          )}
        </div>
      </div>

      <form className="mesh-form" onSubmit={tune}>
        <div className="mesh-form-row">
          <input
            value={freqInput}
            onChange={(e) => setFreqInput(e.currentTarget.value)}
            placeholder="Tune to MHz, e.g. 14.074"
            inputMode="decimal"
          />
          <button type="submit">Set</button>
        </div>
        <div className="rig-modes">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={status.mode === m ? "rig-mode-active" : ""}
              onClick={() => changeMode(m)}
            >
              {m}
            </button>
          ))}
        </div>
      </form>

      {error && <div className="panel-alerts-empty">{error}</div>}

      {/* Transmit is deliberately absent. Keying a radio should never be a
          stray click in a dashboard, and unattended transmission carries
          real regulatory weight. */}
      <div className="rig-note">Frequency and mode only — Waystation will not key your transmitter.</div>
    </div>
  );
}

export default RigControlPanel;
