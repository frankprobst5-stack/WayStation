import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Takes Waystation off the internet without taking the computer off it.
 *
 * Scoped to internet sources only. Mesh, Winlink, JS8Call and rig control
 * keep running — "offline" for a ham dashboard means the internet is gone,
 * not that communication has stopped, which is the entire premise of the
 * app.
 */
function OfflineToggle() {
  const [offline, setOffline] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invoke<boolean>("get_manual_offline").then(setOffline);
  }, []);

  async function toggle() {
    if (offline === null || busy) return;
    setBusy(true);
    const next = !offline;
    try {
      await invoke("set_manual_offline", { offline: next });
      setOffline(next);
    } finally {
      setBusy(false);
    }
  }

  if (offline === null) return null;

  return (
    <button
      type="button"
      className={`offline-toggle ${offline ? "offline-toggle-off" : "offline-toggle-on"}`}
      onClick={toggle}
      disabled={busy}
      aria-pressed={offline}
      title={
        offline
          ? "Waystation is not using the internet. Mesh, Winlink, JS8Call and rig control are unaffected. Click to reconnect."
          : "Stop Waystation using the internet, without taking this computer offline. Mesh and RF keep working."
      }
    >
      <span className="offline-toggle-track">
        <span className="offline-toggle-knob" />
      </span>
      <span className="offline-toggle-label">{offline ? "OFFLINE" : "CONNECTED"}</span>
    </button>
  );
}

export default OfflineToggle;
