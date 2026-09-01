import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type OverallState = "online" | "degraded" | "rf_only" | "offline_manual";

export interface SourceHealth {
  source_id: string;
  label: string;
  status: "healthy" | "degraded" | "down" | "unknown";
  via: "internet" | "mesh" | "rf" | "manual";
  last_success_at: string | null;
  last_attempt_at: string | null;
  detail: string | null;
}

export interface ConnectivitySnapshot {
  overall: OverallState;
  sources: SourceHealth[];
}

export function useConnectivity(): ConnectivitySnapshot | null {
  const [snapshot, setSnapshot] = useState<ConnectivitySnapshot | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    invoke<ConnectivitySnapshot>("get_connectivity_state").then((snap) => {
      if (!cancelled) setSnapshot(snap);
    });

    listen<ConnectivitySnapshot>("connectivity-changed", (event) => {
      setSnapshot(event.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return snapshot;
}
