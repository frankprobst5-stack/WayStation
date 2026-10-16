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

  // Real bug found live 2026-10-09: none of these three effects caught a
  // failed invoke(). Worse than WeatherPanel/FlightTrackingPanel's "stuck
  // on Loading" bug (same session, same root cause) -- these lights don't
  // gate on null, they just stop updating entirely on a failure and keep
  // showing whatever they last successfully computed. A WINLINK light
  // that silently froze on "green" because the health check itself has
  // been failing for the last hour is exactly the kind of falsely-
  // reassuring status a safety-critical indicator can't afford. Falling
  // back to "off" on any failure -- the same state already used for "API
  // confirmed reachable but genuinely not configured" -- so a light that
  // can't currently confirm its own status never keeps showing a stale
  // green/amber from before the failure.
  useEffect(() => {
    async function refreshAlerts() {
      try {
        const alerts = await invoke<Alert[]>("get_alerts");
        setAlertsState(alertsLight(alerts));
      } catch (err) {
        console.error("get_alerts failed:", err);
        setAlertsState("off");
      }
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
      try {
        const status = await invoke<{ api_reachable: boolean }>("get_winlink_status");
        if (!status.api_reachable) {
          setWinlinkState("off");
          return;
        }
        const inbox = await invoke<unknown[]>("get_winlink_inbox");
        setWinlinkState(inbox.length > 0 ? "amber" : "green");
      } catch (err) {
        console.error("winlink status check failed:", err);
        setWinlinkState("off");
      }
    }
    refreshWinlink();
    const id = setInterval(refreshWinlink, 15_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    async function refreshJs8call() {
      try {
        const status = await invoke<{ reachable: boolean }>("get_js8call_status");
        if (!status.reachable) {
          setJs8callState("off");
          return;
        }
        const inbox = await invoke<unknown[]>("get_js8call_inbox");
        setJs8callState(inbox.length > 0 ? "amber" : "green");
      } catch (err) {
        console.error("js8call status check failed:", err);
        setJs8callState("off");
      }
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
