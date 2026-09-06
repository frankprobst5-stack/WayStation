import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { gridSquareToLatLon } from "../lib/maidenhead";

interface StationProfile {
  callsign: string | null;
  grid_square: string | null;
  operator_name: string | null;
  repeaterbook_token: string | null;
  mesh_host: string | null;
  rigctld_host: string | null;
  rig_enabled: boolean;
  rotctld_host: string | null;
  rotator_enabled: boolean;
  citadel_map_host: string | null;
  local_weather_brand: string | null;
  local_weather_host: string | null;
  citadel_kiwix_host: string | null;
  updated_at: string | null;
}

// Anything that isn't this machine means rig control is crossing a
// network, which is where the rigctld exposure warning becomes relevant.
function isRemoteHost(value: string): boolean {
  const host = value.trim().split(":")[0].toLowerCase();
  if (host === "") return false;
  return !["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
}

const GRID_SQUARE_PATTERN = /^[A-Ra-r]{2}[0-9]{2}([A-Xa-x]{2})?$/;

function StationIdentityPanel() {
  const [profile, setProfile] = useState<StationProfile | null>(null);
  const [callsign, setCallsign] = useState("");
  const [gridSquare, setGridSquare] = useState("");
  const [operatorName, setOperatorName] = useState("");
  const [repeaterbookToken, setRepeaterbookToken] = useState("");
  const [meshHost, setMeshHost] = useState("");
  const [rigctldHost, setRigctldHost] = useState("");
  const [rigEnabled, setRigEnabled] = useState(true);
  const [rotctldHost, setRotctldHost] = useState("");
  const [rotatorEnabled, setRotatorEnabled] = useState(true);
  const [citadelMapHost, setCitadelMapHost] = useState("");
  const [localWeatherBrand, setLocalWeatherBrand] = useState("");
  const [localWeatherHost, setLocalWeatherHost] = useState("");
  const [citadelKiwixHost, setCitadelKiwixHost] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  useEffect(() => {
    invoke<StationProfile>("get_station_profile").then((p) => {
      setProfile(p);
      setCallsign(p.callsign ?? "");
      setGridSquare(p.grid_square ?? "");
      setOperatorName(p.operator_name ?? "");
      setRepeaterbookToken(p.repeaterbook_token ?? "");
      setMeshHost(p.mesh_host ?? "");
      setRigctldHost(p.rigctld_host ?? "");
      setRigEnabled(p.rig_enabled);
      setRotctldHost(p.rotctld_host ?? "");
      setRotatorEnabled(p.rotator_enabled);
      setCitadelMapHost(p.citadel_map_host ?? "");
      setLocalWeatherBrand(p.local_weather_brand ?? "");
      setLocalWeatherHost(p.local_weather_host ?? "");
      setCitadelKiwixHost(p.citadel_kiwix_host ?? "");
    });
  }, []);

  const gridValid = gridSquare === "" || GRID_SQUARE_PATTERN.test(gridSquare);
  const resolvedGrid = gridValid ? gridSquareToLatLon(gridSquare) : null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!gridValid) return;
    setSaveState("saving");
    const updated = await invoke<StationProfile>("save_station_profile", {
      callsign: callsign || null,
      gridSquare: gridSquare || null,
      operatorName: operatorName || null,
      repeaterbookToken: repeaterbookToken || null,
      meshHost: meshHost.trim() || null,
      rigctldHost: rigctldHost.trim() || null,
      rigEnabled,
      rotctldHost: rotctldHost.trim() || null,
      rotatorEnabled,
      citadelMapHost: citadelMapHost.trim() || null,
      localWeatherBrand: localWeatherBrand || null,
      localWeatherHost: localWeatherHost.trim() || null,
      citadelKiwixHost: citadelKiwixHost.trim() || null,
    });
    setProfile(updated);
    setSaveState("saved");
    setTimeout(() => setSaveState("idle"), 1500);
  }

  if (!profile) {
    return <div className="panel-station-identity">Loading...</div>;
  }

  return (
    <form className="panel-station-identity" onSubmit={save}>
      <label>
        Callsign
        <input
          value={callsign}
          onChange={(e) => setCallsign(e.currentTarget.value.toUpperCase())}
          placeholder="e.g. KJ4ESQ"
          autoCapitalize="characters"
        />
      </label>
      <label>
        Grid square
        <input
          value={gridSquare}
          onChange={(e) => setGridSquare(e.currentTarget.value.toUpperCase())}
          placeholder="e.g. EM12ab"
          aria-invalid={!gridValid}
        />
        {!gridValid && <span className="field-error">Not a valid Maidenhead grid square</span>}
        {gridValid && gridSquare.trim() !== "" && resolvedGrid && (
          <span className="field-hint">
            Resolves to approximately {resolvedGrid.lat.toFixed(3)}, {resolvedGrid.lon.toFixed(3)}.
          </span>
        )}
        {gridValid && gridSquare.trim().length === 4 && (
          <span className="field-warning">
            <strong>This is a 4-character grid — not precise enough for local alerts.</strong> A
            4-character square covers roughly 111 × 180 km, so weather/emergency alerts (chosen by
            this location) can land in a neighboring county instead of yours. Add two more characters
            (e.g. EM12<strong>ab</strong>) to narrow it to about 5 × 5 km.
          </span>
        )}
      </label>
      <label>
        Operator name
        <input value={operatorName} onChange={(e) => setOperatorName(e.currentTarget.value)} />
      </label>
      <label>
        RepeaterBook API token
        <input
          value={repeaterbookToken}
          onChange={(e) => setRepeaterbookToken(e.currentTarget.value)}
          placeholder="Request one at repeaterbook.com/api/token_request.php"
        />
      </label>
      <label>
        Meshtastic host
        <input
          value={meshHost}
          onChange={(e) => setMeshHost(e.currentTarget.value)}
          placeholder="127.0.0.1:4403"
        />
        <span className="field-hint">
          A node's IP on your network, or blank for a local one. Port defaults to 4403. Use
          Reconnect on the Mesh panel to apply a change.
        </span>
      </label>
      <label className="checkbox-label">
        <input type="checkbox" checked={rigEnabled} onChange={(e) => setRigEnabled(e.currentTarget.checked)} />
        Rig control enabled
        <span className="field-hint">
          Off means Waystation never connects to rigctld and stops polling entirely — worth turning
          off with no radio attached, or to leave the serial port to another program.
        </span>
      </label>
      <label>
        Rig control host (rigctld)
        <input
          value={rigctldHost}
          onChange={(e) => setRigctldHost(e.currentTarget.value)}
          placeholder="127.0.0.1:4532"
          disabled={!rigEnabled}
        />
        <span className="field-hint">
          Where rigctld is listening. Blank uses this computer. Waystation connects to a rigctld you
          are already running — it never starts one, since only one program can hold the radio's
          serial port.
        </span>
        {/* Shown at the moment the operator opts into crossing a network,
            which is when the risk becomes real and the advice is actionable. */}
        {rigEnabled && isRemoteHost(rigctldHost) && (
          <span className="field-warning">
            <strong>This reaches a radio over the network.</strong> rigctld has no password and no
            authentication of any kind — anyone who can reach that port can key your transmitter
            under your callsign. Only expose it through a VPN or an SSH tunnel, never directly. On
            the radio's machine, bind rigctld to loopback so nothing else can reach it:
            <code className="rig-cmd">rigctld -m &lt;model&gt; -r &lt;device&gt; -T 127.0.0.1</code>
            Turning this switch off stops <em>Waystation</em> connecting, but does not stop rigctld
            listening — only its own flags or your firewall can do that.
          </span>
        )}
      </label>
      <label className="checkbox-label">
        <input type="checkbox" checked={rotatorEnabled} onChange={(e) => setRotatorEnabled(e.currentTarget.checked)} />
        Rotator control enabled
        <span className="field-hint">
          Off means Waystation never connects to rotctld and stops polling entirely — same reasoning
          as the rig switch above.
        </span>
      </label>
      <label>
        Rotator control host (rotctld)
        <input
          value={rotctldHost}
          onChange={(e) => setRotctldHost(e.currentTarget.value)}
          placeholder="127.0.0.1:4533"
          disabled={!rotatorEnabled}
        />
        <span className="field-hint">
          Where rotctld is listening. Blank uses this computer.
        </span>
        {rotatorEnabled && isRemoteHost(rotctldHost) && (
          <span className="field-warning">
            <strong>This reaches a rotator over the network.</strong> rotctld has the same
            no-authentication exposure as rigctld — anyone who can reach that port can move your
            antenna. Only expose it through a VPN or an SSH tunnel, never directly.
            <code className="rig-cmd">rotctld -m &lt;model&gt; -r &lt;device&gt; -T 127.0.0.1</code>
          </span>
        )}
      </label>
      <label>
        Citadel map server
        <input
          value={citadelMapHost}
          onChange={(e) => setCitadelMapHost(e.currentTarget.value)}
          placeholder="127.0.0.1:8085"
        />
        <span className="field-hint">
          Where Citadel's map tile server is reachable (its own nginx serving local map tiles).
          Blank uses this computer's default. If unreachable, the Tactical Map falls back to
          OpenFreeMap online tiles — see the User Manual for running your own tile server without
          Citadel.
        </span>
      </label>
      <label>
        Local weather station
        <select value={localWeatherBrand} onChange={(e) => setLocalWeatherBrand(e.currentTarget.value)}>
          <option value="">None configured</option>
          <option value="ecowitt">Ecowitt (or other Fine Offset-compatible gateway)</option>
          <option value="davis_weatherlink_live">Davis WeatherLink Live</option>
        </select>
        {localWeatherBrand && (
          <input
            value={localWeatherHost}
            onChange={(e) => setLocalWeatherHost(e.currentTarget.value)}
            placeholder="192.168.1.50"
          />
        )}
        <span className="field-hint">
          The console/gateway's own address on your local network — WayStation polls it directly, no
          Citadel or internet involved. Port defaults to 80 for both brands. See the Weather panel for
          the current reading.
        </span>
      </label>
      <label>
        Citadel field-reference library (Kiwix)
        <input
          value={citadelKiwixHost}
          onChange={(e) => setCitadelKiwixHost(e.currentTarget.value)}
          placeholder="127.0.0.1:8095"
        />
        <span className="field-hint">
          Where Citadel's Kiwix server is reachable -- lets Field Reference (Reference tab) search
          your offline library (Ready.gov, field manuals, etc.) by keyword. Blank uses this
          computer's default. Not AI or semantic search -- real keyword matches from your own
          local library, with excerpts.
        </span>
      </label>
      <button type="submit" disabled={!gridValid || saveState === "saving"}>
        {saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving..." : "Save"}
      </button>
    </form>
  );
}

export default StationIdentityPanel;
