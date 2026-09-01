import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface RotatorStatus {
  reachable: boolean;
  enabled: boolean;
  remote_target: boolean;
  target: string;
  azimuth_deg: number | null;
  elevation_deg: number | null;
  detail: string | null;
}

const POLL_MS = 2000;

function RotatorControlPanel() {
  const [status, setStatus] = useState<RotatorStatus | null>(null);
  const [azInput, setAzInput] = useState("");
  const [elInput, setElInput] = useState("0");
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setStatus(await invoke<RotatorStatus>("get_rotator_status"));
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, []);

  async function setPosition(e: React.FormEvent) {
    e.preventDefault();
    const az = Number(azInput);
    const el = Number(elInput);
    if (!Number.isFinite(az) || az < 0 || az > 360) {
      setError("Azimuth must be 0-360°");
      return;
    }
    if (!Number.isFinite(el) || el < -90 || el > 90) {
      setError("Elevation must be -90-90°");
      return;
    }
    setError(null);
    try {
      await invoke("set_rotator_position", { azimuthDeg: az, elevationDeg: el });
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
          <span>Rotator control is off</span>
        </div>
        <div className="rig-hint">
          Waystation isn't connecting to a rotator. Turn it on in <strong>Settings → Station</strong>.
        </div>
      </div>
    );
  }

  if (!status.reachable) {
    return (
      <div className="panel-rig">
        <div className="alert-header">
          <span>No rotator connected</span>
          <span className="resource-chip">{status.target}</span>
        </div>
        <div className="rig-hint">
          Waystation talks to your rotator through <strong>rotctld</strong> (part of Hamlib), which
          it does not start for you — you may already be sharing it with other software.
          <code className="rig-cmd">rotctld -m &lt;model&gt; -r /dev/ttyUSB0</code>
          Run <code>rotctl --list</code> to find your model number. Model 1 is a dummy rotator for
          trying this out with no hardware at all.
        </div>
      </div>
    );
  }

  return (
    <div className="panel-rig">
      <div className="alert-header">
        <span>Connected</span>
        <span className="mesh-header-right">
          <span className="resource-chip">{status.target}</span>
        </span>
      </div>

      {status.detail && <div className="winlink-warning">{status.detail}</div>}

      {status.remote_target && (
        <div className="winlink-warning">
          Controlling a rotator across the network. rotctld has no authentication — make sure this
          only travels over a VPN or SSH tunnel.
        </div>
      )}

      <div className="rig-readout">
        <div className="rig-freq">
          {status.azimuth_deg !== null ? status.azimuth_deg.toFixed(1) : "—"}
          <span className="rig-unit">° AZ</span>
        </div>
        <div className="rig-chips">
          {status.elevation_deg !== null && (
            <span className="resource-chip">{status.elevation_deg.toFixed(1)}° EL</span>
          )}
        </div>
      </div>

      <form className="mesh-form" onSubmit={setPosition}>
        <div className="mesh-form-row">
          <input
            value={azInput}
            onChange={(e) => setAzInput(e.currentTarget.value)}
            placeholder="Azimuth 0-360°"
            inputMode="decimal"
          />
          <input
            value={elInput}
            onChange={(e) => setElInput(e.currentTarget.value)}
            placeholder="Elevation -90-90°"
            inputMode="decimal"
          />
          <button type="submit">Set</button>
        </div>
      </form>

      {error && <div className="panel-alerts-empty">{error}</div>}
    </div>
  );
}

export default RotatorControlPanel;
