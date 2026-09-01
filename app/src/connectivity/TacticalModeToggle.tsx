import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Hides/shows panels flagged `hobbyist` in panels/types.ts (Contest
 * Calendar, DX Cluster) — decided 2026-08-29 from a hybrid-architecture
 * review, applying "build for us first": those panels are real estate
 * nobody in the family/Citadel deployment group would use. A visibility
 * toggle rather than deleting the panels — they stay fully built, just
 * hidden by default.
 */
function TacticalModeToggle({ onChange }: { onChange: (tacticalMode: boolean) => void }) {
  const [tacticalMode, setTacticalMode] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invoke<{ tactical_mode: boolean }>("get_station_profile").then((p) => {
      setTacticalMode(p.tactical_mode);
      onChange(p.tactical_mode);
    });
    // Only ever run once on mount -- onChange is a stable setter from the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggle() {
    if (tacticalMode === null || busy) return;
    setBusy(true);
    const next = !tacticalMode;
    try {
      await invoke("set_tactical_mode", { enabled: next });
      setTacticalMode(next);
      onChange(next);
    } finally {
      setBusy(false);
    }
  }

  if (tacticalMode === null) return null;

  return (
    <button
      type="button"
      className={`tactical-mode-toggle ${tacticalMode ? "tactical-mode-tactical" : "tactical-mode-hobbyist"}`}
      onClick={toggle}
      disabled={busy}
      aria-pressed={tacticalMode}
      title={
        tacticalMode
          ? "Tactical Mode: hobbyist panels (Contest Calendar, DX Cluster) are hidden. Click for Hobbyist Mode."
          : "Hobbyist Mode: every panel is shown, including Contest Calendar and DX Cluster. Click for Tactical Mode."
      }
    >
      {tacticalMode ? "TACTICAL" : "HOBBYIST"}
    </button>
  );
}

export default TacticalModeToggle;
