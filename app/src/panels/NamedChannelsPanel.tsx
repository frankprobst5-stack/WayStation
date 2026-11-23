import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Mirrors db::NamedChannel. Closes Messaging's own "Not built yet" gap,
// half 1: an operator-given name like "Field Team Alpha" that resolves
// to whichever per-transport value actually applies -- Meshtastic's
// numbered channel (0-7), and/or a Winlink/JS8Call callsign, since those
// two transports already address a destination by callsign and need no
// translation of their own. Any binding can be left blank.
interface NamedChannel {
  id: number;
  name: string;
  meshtastic_channel: number | null;
  winlink_callsign: string | null;
  js8call_callsign: string | null;
  notes: string | null;
  updated_at: string;
}

const MESH_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7];

function NamedChannelsPanel() {
  const [channels, setChannels] = useState<NamedChannel[]>([]);
  const [name, setName] = useState("");
  const [meshChannel, setMeshChannel] = useState("");
  const [winlink, setWinlink] = useState("");
  const [js8call, setJs8call] = useState("");
  const [notes, setNotes] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setChannels(await invoke<NamedChannel[]>("get_named_channels"));
    } catch (err) {
      console.error("get_named_channels failed:", err);
      setError(String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function resetForm() {
    setEditingId(null);
    setName("");
    setMeshChannel("");
    setWinlink("");
    setJs8call("");
    setNotes("");
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await invoke("upsert_named_channel", {
        id: editingId,
        name: name.trim(),
        meshtasticChannel: meshChannel === "" ? null : Number(meshChannel),
        winlinkCallsign: winlink.trim() || null,
        js8callCallsign: js8call.trim() || null,
        notes: notes.trim() || null,
      });
      setError(null);
      resetForm();
      await refresh();
    } catch (err) {
      console.error("upsert_named_channel failed:", err);
      setError(String(err));
    }
  }

  function edit(c: NamedChannel) {
    setEditingId(c.id);
    setName(c.name);
    setMeshChannel(c.meshtastic_channel === null ? "" : String(c.meshtastic_channel));
    setWinlink(c.winlink_callsign ?? "");
    setJs8call(c.js8call_callsign ?? "");
    setNotes(c.notes ?? "");
  }

  async function remove(id: number) {
    try {
      await invoke("delete_named_channel", { id });
      setError(null);
      if (editingId === id) resetForm();
      await refresh();
    } catch (err) {
      console.error("delete_named_channel failed:", err);
      setError(String(err));
    }
  }

  return (
    <div className="panel-channels">
      <p className="sync-lede">
        Give a group a real name once -- "Pine Ridge Incident", "Field Team Alpha" -- and reuse it across whichever
        transport you're actually on, instead of remembering that it's mesh channel 4 and also W1AW on Winlink.
        Only Meshtastic has a numbered channel to bind; Winlink and JS8Call already address a destination by
        callsign, so those fields are just a reusable address book entry for this name.
      </p>

      <form className="resource-form channel-form" onSubmit={save}>
        <input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Name (e.g. Field Team Alpha)" />
        <select value={meshChannel} onChange={(e) => setMeshChannel(e.currentTarget.value)}>
          <option value="">No mesh channel</option>
          {MESH_CHANNELS.map((c) => (
            <option key={c} value={c}>
              Mesh ch{c}
            </option>
          ))}
        </select>
        <input value={winlink} onChange={(e) => setWinlink(e.currentTarget.value)} placeholder="Winlink callsign (optional)" />
        <input value={js8call} onChange={(e) => setJs8call(e.currentTarget.value)} placeholder="JS8Call callsign (optional)" />
        <button type="submit">{editingId !== null ? "Update" : "Add"}</button>
      </form>

      {error && <div className="panel-alerts-empty">{error}</div>}
      <input
        className="channel-notes-input"
        value={notes}
        onChange={(e) => setNotes(e.currentTarget.value)}
        placeholder="Notes (optional)"
      />

      {channels.length === 0 ? (
        <div className="panel-alerts-empty">No named channels yet.</div>
      ) : (
        <div className="resource-list">
          {channels.map((c) => (
            <div key={c.id} className="resource-row">
              <div className="resource-header">
                <span className="resource-label">{c.name}</span>
              </div>
              <div className="resource-tokens">
                {c.meshtastic_channel !== null && <span className="resource-chip">Mesh ch{c.meshtastic_channel}</span>}
                {c.winlink_callsign && <span className="resource-chip">Winlink {c.winlink_callsign}</span>}
                {c.js8call_callsign && <span className="resource-chip">JS8Call {c.js8call_callsign}</span>}
                {c.notes && <span className="resource-chip">{c.notes}</span>}
              </div>
              <div className="resource-actions">
                <button type="button" onClick={() => edit(c)}>
                  Edit
                </button>
                <button type="button" onClick={() => remove(c.id)}>
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default NamedChannelsPanel;
