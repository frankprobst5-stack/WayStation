import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { ConnectivitySnapshot, OverallState } from "../connectivity/useConnectivity";

interface Alert {
  id: string;
  event: string;
  severity: string;
  headline: string | null;
}

// Only the two severities worth interrupting someone for. Moderate/Minor
// still show up in the Active Alerts panel, just without a notification.
const NOTIFY_SEVERITIES = new Set(["Extreme", "Severe"]);

const CONNECTIVITY_LABEL: Record<OverallState, string> = {
  online: "🟢 Back online",
  degraded: "🟡 Connectivity degraded",
  rf_only: "🔴 RF-ONLY — internet lost",
  offline_manual: "⏸️ Offline — switched off by you",
};

const seenAlertIds = new Set<string>();
let previousConnectivityState: OverallState | null = null;
let started = false;
let seeded = false;

async function ensureNotificationPermission(): Promise<boolean> {
  let granted = await isPermissionGranted();
  if (!granted) {
    granted = (await requestPermission()) === "granted";
  }
  return granted;
}

async function checkAlerts() {
  if (!seeded) return; // haven't finished seeding yet — the next change event will re-run this
  const alerts = await invoke<Alert[]>("get_alerts");
  for (const alert of alerts) {
    if (seenAlertIds.has(alert.id)) continue;
    seenAlertIds.add(alert.id);
    if (!NOTIFY_SEVERITIES.has(alert.severity)) continue;

    if (await ensureNotificationPermission()) {
      sendNotification({ title: `${alert.severity.toUpperCase()}: ${alert.event}`, body: alert.headline ?? "" });
    }
    // Audio alerting (synthesized speech) is deferred: WebKitGTK's
    // speechSynthesis triggered a WebKitWebProcess segfault (signal 11,
    // confirmed via /var/crash) during testing on Linux. Desktop
    // notifications go through a separate, more reliable path (the OS
    // notification daemon via D-Bus) and aren't affected.
  }
}

async function handleConnectivityChange(snapshot: ConnectivitySnapshot) {
  const prev = previousConnectivityState;
  previousConnectivityState = snapshot.overall;
  // Never interrupt someone to tell them about a switch they just flipped,
  // in either direction. Notifications are for things that happened *to*
  // the station, not things the operator did on purpose.
  if (snapshot.overall === "offline_manual" || prev === "offline_manual") return;
  // First reading just seeds state — don't notify for whatever connectivity
  // happened to be on app launch, only for changes after that.
  if (prev === null || prev === snapshot.overall) return;

  if (await ensureNotificationPermission()) {
    sendNotification({ title: "Waystation connectivity", body: CONNECTIVITY_LABEL[snapshot.overall] });
  }
}

/** Call once at app startup. Idempotent. */
export function startRulesEngine() {
  if (started) return;
  started = true;

  listen("alerts-changed", checkAlerts);
  listen<ConnectivitySnapshot>("connectivity-changed", (event) => handleConnectivityChange(event.payload));

  // Seed with whatever's already active *before* any change event is acted
  // on, so an alert that existed before this session began is never
  // mistaken for new. checkAlerts() no-ops until this resolves.
  invoke<Alert[]>("get_alerts").then((alerts) => {
    for (const a of alerts) seenAlertIds.add(a.id);
    seeded = true;
  });
}
