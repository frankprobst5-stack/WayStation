import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Light = "green" | "amber" | "red" | "off";

interface Alert {
  severity: string;
}

function alertsLight(alerts: Alert[]): Light {
  if (alerts.some((a) => a.severity === "Extreme" || a.severity === "Severe")) return "red";
  if (alerts.some((a) => a.severity === "Moderate")) return "amber";
  return "green";
}

/** Always-visible status light row under the time bar — a glance before
 * switching tabs, per Frank's original ask. Each light polls its own
 * source independently, same pattern as ConnectivityBadge. */
function StatusLights() {
  const [alertsState, setAlertsState] = useState<Light>("off");
  const [winlinkState, setWinlinkState] = useState<Light>("off");
  const [js8callState, setJs8callState] = useState<Light>("off");

  useEffect(() => {
    async function refreshAlerts() {
      const alerts = await invoke<Alert[]>("get_alerts");
      setAlertsState(alertsLight(alerts));
    }
    refreshAlerts();
    let unlisten: (() => void) | undefined;
    listen("alerts-changed", refreshAlerts).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    async function refreshWinlink() {
      const status = await invoke<{ api_reachable: boolean }>("get_winlink_status");
      if (!status.api_reachable) {
        setWinlinkState("off");
        return;
      }
      const inbox = await invoke<unknown[]>("get_winlink_inbox");
      setWinlinkState(inbox.length > 0 ? "amber" : "green");
    }
    refreshWinlink();
    const id = setInterval(refreshWinlink, 15_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    async function refreshJs8call() {
      const status = await invoke<{ reachable: boolean }>("get_js8call_status");
      if (!status.reachable) {
        setJs8callState("off");
        return;
      }
      const inbox = await invoke<unknown[]>("get_js8call_inbox");
      setJs8callState(inbox.length > 0 ? "amber" : "green");
    }
    refreshJs8call();
    const id = setInterval(refreshJs8call, 15_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="status-lights">
      <span className="status-light-item">
        <span className={`status-dot status-${alertsState}`} />
        ALERTS
      </span>
      <span className="status-light-item">
        <span className={`status-dot status-${winlinkState}`} />
        WINLINK
      </span>
      <span className="status-light-item">
        <span className={`status-dot status-${js8callState}`} />
        JS8CALL
      </span>
    </div>
  );
}

export default StatusLights;
