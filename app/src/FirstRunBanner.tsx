import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Nudges a brand-new install toward the two fields (callsign, grid
// square) that most panels quietly depend on -- without this, a first-time
// user just sees empty/loading panels with no hint why. Dismissible for
// the current session (someone mid-way through setup doesn't need it
// pinned), but not persisted across restarts: it should keep showing up
// on every launch until the profile is actually filled in, since that's
// the exact gap this exists to close.
interface StationProfile {
  callsign: string | null;
}

function FirstRunBanner({ onGoToSettings }: { onGoToSettings: () => void }) {
  const [needsSetup, setNeedsSetup] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    invoke<StationProfile>("get_station_profile").then((p) => {
      setNeedsSetup(!p.callsign || !p.callsign.trim());
    });
  }, []);

  if (!needsSetup || dismissed) return null;

  return (
    <div className="first-run-banner">
      <span>
        <strong>Welcome to Waystation.</strong> Set your callsign and grid square in Settings to
        unlock most panels — a few (alerts, DX cluster, reception reports) do nothing without it.
      </span>
      <div className="first-run-banner-actions">
        <button
          type="button"
          onClick={() => {
            onGoToSettings();
            setDismissed(true);
          }}
        >
          Go to Settings
        </button>
        <button type="button" className="first-run-banner-dismiss" onClick={() => setDismissed(true)}>
          Dismiss for now
        </button>
      </div>
    </div>
  );
}

export default FirstRunBanner;
