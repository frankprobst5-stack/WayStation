import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Theme = "dark" | "light" | "red";

const THEMES: { value: Theme; label: string; description: string }[] = [
  { value: "dark", label: "Dark Tactical", description: "The default command-center look." },
  { value: "light", label: "Light (Day Ops)", description: "For bright environments where the dark theme washes out." },
  { value: "red", label: "Red (Low-Light)", description: "Genuine night-vision preservation — every color shifts to red, not just the background." },
];

/** Applies immediately, everywhere the app is rendered -- exported so
 * App.tsx can call this once on startup with the saved value, without
 * duplicating the logic. */
export function applyTheme(theme: string) {
  document.documentElement.setAttribute("data-theme", theme);
}

function AppearancePanel() {
  const [theme, setThemeState] = useState<Theme>("dark");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Real bug found live 2026-10-09 (same file-wide sweep): no catch --
    // low severity (just keeps the "dark" default), but worth logging.
    invoke<{ theme: string }>("get_station_profile")
      .then((p) => {
        setThemeState((p.theme as Theme) ?? "dark");
      })
      .catch((err) => console.error("get_station_profile failed:", err));
  }, []);

  async function choose(next: Theme) {
    setSaving(true);
    applyTheme(next); // instant feedback, don't wait on the round trip
    // Real bug found live 2026-10-09: `finally` with no `catch` meant a
    // failed save left the radio button showing the OLD selection even
    // though the visible theme had already changed (applyTheme above) --
    // a real state mismatch between what's shown and what's saved, with
    // no explanation why.
    try {
      await invoke("set_theme", { theme: next });
      setError(null);
      setThemeState(next);
    } catch (err) {
      console.error("set_theme failed:", err);
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="panel-alerts">
      <p className="sync-lede">
        Display theme. Applies immediately and persists across restarts. Red is a real night-vision-preservation
        mode, not a cosmetic option — everything shifts to shades of red, never another hue.
      </p>
      {error && <div className="panel-alerts-empty">{error}</div>}
      <div className="sync-peer-list">
        {THEMES.map((t) => (
          <div key={t.value} className="sync-peer-row">
            <label style={{ display: "flex", alignItems: "center", gap: "0.6em", cursor: "pointer" }}>
              <input type="radio" name="theme" checked={theme === t.value} disabled={saving} onChange={() => choose(t.value)} />
              <span>
                <span className="sync-peer-callsign">{t.label}</span>
                <span className="sync-peer-notes"> — {t.description}</span>
              </span>
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}

export default AppearancePanel;
