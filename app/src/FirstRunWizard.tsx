import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { gridSquareToLatLon } from "./lib/maidenhead";

// Replaces the old one-line FirstRunBanner. That banner just pointed at
// Settings and hoped -- it didn't explain why grid square precision
// matters, didn't mention Citadel is optional, and didn't confirm
// anything actually got saved. This walks the same essential setup
// (station identity is the one real hard requirement; everything else
// is skippable) as an explicit sequence, and shows the dashboard behind
// it the whole time -- not a blocked screen, just a guided one, since
// someone might need a panel *right now* before finishing setup.
//
// Every field this wizard doesn't touch (repeaterbook token, mesh/rig/
// rotator hosts) gets carried through unchanged on every save --
// save_station_profile is a full replace, not a partial merge, so
// skipping that would silently wipe out anything already configured
// there.
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
  updated_at: string | null;
}

const GRID_SQUARE_PATTERN = /^[A-Ra-r]{2}[0-9]{2}([A-Xa-x]{2})?$/;

const STEPS = ["welcome", "identity", "citadel", "hardware", "done"] as const;
type Step = (typeof STEPS)[number];

function FirstRunWizard({ onFinished }: { onFinished: () => void }) {
  const [visible, setVisible] = useState(false);
  const [profile, setProfile] = useState<StationProfile | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [saving, setSaving] = useState(false);

  const [callsign, setCallsign] = useState("");
  const [gridSquare, setGridSquare] = useState("");
  const [operatorName, setOperatorName] = useState("");
  const [citadelMapHost, setCitadelMapHost] = useState("");

  useEffect(() => {
    invoke<StationProfile>("get_station_profile").then((p) => {
      setProfile(p);
      setVisible(!p.callsign || !p.callsign.trim());
      setCallsign(p.callsign ?? "");
      setGridSquare(p.grid_square ?? "");
      setOperatorName(p.operator_name ?? "");
      setCitadelMapHost(p.citadel_map_host ?? "");
    });
  }, []);

  if (!visible || !profile) return null;

  const step: Step = STEPS[stepIndex];
  const gridValid = gridSquare === "" || GRID_SQUARE_PATTERN.test(gridSquare);
  const resolvedGrid = gridValid ? gridSquareToLatLon(gridSquare) : null;
  const canLeaveIdentity = callsign.trim() !== "" && gridValid;

  async function persist(overrides: Partial<StationProfile>) {
    setSaving(true);
    try {
      const merged = { ...profile, ...overrides } as StationProfile;
      const updated = await invoke<StationProfile>("save_station_profile", {
        callsign: merged.callsign || null,
        gridSquare: merged.grid_square || null,
        operatorName: merged.operator_name || null,
        repeaterbookToken: merged.repeaterbook_token || null,
        meshHost: merged.mesh_host || null,
        rigctldHost: merged.rigctld_host || null,
        rigEnabled: merged.rig_enabled,
        rotctldHost: merged.rotctld_host || null,
        rotatorEnabled: merged.rotator_enabled,
        citadelMapHost: merged.citadel_map_host || null,
      });
      setProfile(updated);
      return updated;
    } finally {
      setSaving(false);
    }
  }

  async function next() {
    if (step === "identity") {
      if (!canLeaveIdentity) return;
      await persist({ callsign: callsign.trim().toUpperCase(), grid_square: gridSquare.trim().toUpperCase(), operator_name: operatorName.trim() || null });
    } else if (step === "citadel") {
      await persist({ citadel_map_host: citadelMapHost.trim() || null });
    }
    setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
  }

  function back() {
    setStepIndex((i) => Math.max(i - 1, 0));
  }

  // "Skip for now" closes the wizard, but shouldn't discard anything
  // already typed on the current step -- someone who fills in a
  // callsign then reflexively hits Skip instead of Next shouldn't lose
  // it. Only persists fields that are actually valid right now.
  async function skip() {
    if (step === "identity" && (callsign.trim() !== "" || gridSquare.trim() !== "") && gridValid) {
      await persist({ callsign: callsign.trim().toUpperCase() || null, grid_square: gridSquare.trim().toUpperCase() || null, operator_name: operatorName.trim() || null });
    } else if (step === "citadel" && citadelMapHost.trim() !== "") {
      await persist({ citadel_map_host: citadelMapHost.trim() });
    }
    setVisible(false);
    onFinished();
  }

  function finish() {
    setVisible(false);
    onFinished();
  }

  return (
    <div className="wizard-overlay">
      <div className="wizard-modal" role="dialog" aria-modal="true" aria-label="First-time setup">
        <div className="wizard-progress">
          {STEPS.slice(0, -1).map((s, i) => (
            <span key={s} className={`wizard-progress-dot ${i <= stepIndex ? "wizard-progress-dot-done" : ""}`} />
          ))}
        </div>

        {step === "welcome" && (
          <>
            <h2>Welcome to WayStation</h2>
            <p>
              WayStation is your station's offline-first comms and field-ops dashboard — it works fine online, and
              keeps working when the grid doesn't. This short setup takes about two minutes. Only one thing is
              actually required (your callsign and grid square); everything else here is skippable and can always
              be changed later in Settings → Station.
            </p>
            <div className="wizard-actions">
              <button type="button" className="wizard-skip" onClick={skip}>
                Skip for now
              </button>
              <button type="button" onClick={next}>
                Get Started
              </button>
            </div>
          </>
        )}

        {step === "identity" && (
          <>
            <h2>Station Identity</h2>
            <p>Most panels — alerts, DX cluster, reception reports, the tactical map's own position — depend on this.</p>
            <label>
              Callsign
              <input
                value={callsign}
                onChange={(e) => setCallsign(e.currentTarget.value.toUpperCase())}
                placeholder="e.g. KJ4ESQ"
                autoCapitalize="characters"
                autoFocus
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
                  <strong>This is a 4-character grid — not precise enough for local alerts.</strong> It covers
                  roughly 111 × 180 km, so weather/emergency alerts can land in a neighboring county instead of
                  yours. Add two more characters (e.g. EM12<strong>ab</strong>) to narrow it to about 5 × 5 km — you
                  can always come back and fix this in Settings later.
                </span>
              )}
            </label>
            <label>
              Operator name (optional)
              <input value={operatorName} onChange={(e) => setOperatorName(e.currentTarget.value)} />
            </label>
            <div className="wizard-actions">
              <button type="button" className="wizard-skip" onClick={skip}>
                Skip for now
              </button>
              <button type="button" onClick={back}>
                Back
              </button>
              <button type="button" onClick={next} disabled={!canLeaveIdentity || saving}>
                {saving ? "Saving…" : "Next"}
              </button>
            </div>
          </>
        )}

        {step === "citadel" && (
          <>
            <h2>Citadel Integration (optional)</h2>
            <p>
              If this station also runs Citadel, WayStation can pull its local map tiles instead of needing internet
              for the Tactical Map. Leave this blank if you don't run Citadel, or aren't sure — the map falls back
              to online tiles automatically either way.
            </p>
            <label>
              Citadel map server
              <input
                value={citadelMapHost}
                onChange={(e) => setCitadelMapHost(e.currentTarget.value)}
                placeholder="127.0.0.1:8085"
              />
              <span className="field-hint">Blank uses this computer's default.</span>
            </label>
            <div className="wizard-actions">
              <button type="button" className="wizard-skip" onClick={skip}>
                Skip for now
              </button>
              <button type="button" onClick={back}>
                Back
              </button>
              <button type="button" onClick={next} disabled={saving}>
                {saving ? "Saving…" : "Next"}
              </button>
            </div>
          </>
        )}

        {step === "hardware" && (
          <>
            <h2>Radio &amp; Mesh Hardware</h2>
            <p>
              If you have a Meshtastic node, a rig connected via <code>rigctld</code>, or an antenna rotator via{" "}
              <code>rotctld</code>, those are set up in <strong>Settings → Station</strong> whenever the hardware is
              actually connected — nothing to do here now. Winlink and JS8Call are separate programs WayStation
              connects to, not something it starts for you; the User Manual's <strong>Start Here</strong> page walks
              through all of this the first time you actually need it.
            </p>
            <div className="wizard-actions">
              <button type="button" className="wizard-skip" onClick={skip}>
                Skip for now
              </button>
              <button type="button" onClick={back}>
                Back
              </button>
              <button type="button" onClick={next}>
                Next
              </button>
            </div>
          </>
        )}

        {step === "done" && (
          <>
            <h2>You're set up</h2>
            <p>
              {callsign ? (
                <>
                  Station identity saved for <strong>{callsign}</strong>. You can change any of this later in{" "}
                  <strong>Settings → Station</strong>.
                </>
              ) : (
                <>
                  Setup skipped for now — you can fill in station identity any time in{" "}
                  <strong>Settings → Station</strong>. Some panels won't work until you do.
                </>
              )}
            </p>
            <p>
              Before an actual emergency, read the <strong>User Manual → Start Here</strong> tab with everyone
              who'll need to use this — it's written for someone who's never touched WayStation before.
            </p>
            <div className="wizard-actions">
              <button type="button" onClick={finish}>
                Go to Dashboard
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default FirstRunWizard;
