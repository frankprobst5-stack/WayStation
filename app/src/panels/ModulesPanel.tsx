import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Ecosystem-wide module-manifest convention, resolved 2026-09-25 (see the
 * Citadel Ecosystem ARCHITECTURE.md's "Module conventions" section): every
 * module in every project (Citadel, WayStation, Muster) describes itself
 * with the same shared core -- id/title/icon/description/requires_hardware
 * -- regardless of how each system actually enables/disables it
 * underneath. WayStation's own mechanism, decided the same day: compile-
 * time code, runtime toggle -- every module's code already ships in this
 * binary, this panel only ever flips a `station_profile` column, never
 * loads or unloads any code. `command` is a WayStation-specific extension
 * field (not part of the shared core), naming which `set_*_enabled`
 * command actually persists this module's toggle. */
interface ModuleManifest {
  id: string;
  title: string;
  icon: string;
  description: string;
  requiresHardware: boolean;
  profileField: keyof StationProfileModuleFields;
  command: string;
}

interface StationProfileModuleFields {
  mesh_enabled: boolean;
  rig_enabled: boolean;
  rotator_enabled: boolean;
}

const MODULE_CATALOG: ModuleManifest[] = [
  {
    id: "mesh",
    title: "Mesh (Meshtastic)",
    icon: "📡",
    description: "Off-grid text chat and node tracking over a Meshtastic node's TCP API. Off means Waystation never connects and never polls.",
    requiresHardware: true,
    profileField: "mesh_enabled",
    command: "set_mesh_enabled",
  },
  {
    id: "rig",
    title: "Rig Control",
    icon: "🎛",
    description: "Frequency/mode control and S-meter readout via rigctld (Hamlib). Off means Waystation opens no connection, leaving the serial port free for another program.",
    requiresHardware: true,
    profileField: "rig_enabled",
    command: "set_rig_enabled",
  },
  {
    id: "rotator",
    title: "Rotator Control",
    icon: "🧭",
    description: "Antenna bearing control and readout via rotctld (Hamlib). Off means Waystation opens no connection and does no polling.",
    requiresHardware: true,
    profileField: "rotator_enabled",
    command: "set_rotator_enabled",
  },
];

function ModuleRow({ manifest, enabled, onToggle }: { manifest: ModuleManifest; enabled: boolean; onToggle: (next: boolean) => void }) {
  const [busy, setBusy] = useState(false);

  async function flip() {
    if (busy) return;
    setBusy(true);
    const next = !enabled;
    try {
      await invoke(manifest.command, { enabled: next });
      onToggle(next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sync-peer-row module-row">
      <div className="module-row-icon">{manifest.icon}</div>
      <div className="module-row-text">
        <div className="module-row-title">
          {manifest.title}
          {manifest.requiresHardware && <span className="resource-chip module-row-badge">hardware</span>}
        </div>
        <div className="field-hint">{manifest.description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        className={`module-toggle ${enabled ? "module-toggle-on" : ""}`}
        onClick={flip}
        disabled={busy}
      >
        <span className="module-toggle-knob" />
      </button>
    </div>
  );
}

function ModulesPanel() {
  const [profile, setProfile] = useState<StationProfileModuleFields | null>(null);

  useEffect(() => {
    invoke<StationProfileModuleFields>("get_station_profile").then(setProfile);
  }, []);

  if (!profile) {
    return <div className="panel-alerts">Loading...</div>;
  }

  return (
    <div className="panel-alerts">
      <p className="sync-lede">
        Pick only the capability this station actually needs — the same idea Citadel's own Settings → Modules and
        Muster's panel picker already use, applied here to WayStation's local-hardware integrations. Every module's
        code already ships in this build; a toggle only decides whether it ever opens a connection. No app restart
        needed either way — Rig and Rotator apply within seconds since neither holds a persistent connection to
        interrupt. Mesh applies immediately to any new connection attempt, but an already-connected mesh session
        stays up until it naturally reconnects or you hit Reconnect on Messaging → Mesh — the same explicit-action
        model already used when changing the Mesh host, so a Settings change never silently drops a live link.
      </p>
      <div className="sync-peer-list">
        {MODULE_CATALOG.map((m) => (
          <ModuleRow
            key={m.id}
            manifest={m}
            enabled={profile[m.profileField]}
            onToggle={(next) => setProfile((p) => (p ? { ...p, [m.profileField]: next } : p))}
          />
        ))}
      </div>
      <div className="bandplan-disclaimer">
        Winlink, JS8Call, and Packet (APRS/Direwolf) don't have their own toggle here yet — each manages a real
        subprocess (a mailbox daemon, an audio capture device), so turning one off should also stop that process
        cleanly, not just skip a status poll. That's real, distinct follow-up work, not done in this first pass.
      </div>
    </div>
  );
}

export default ModulesPanel;
