import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { parseTokens } from "../lib/bracketTokens";
import { formatAge } from "../staleness/format";

interface Resource {
  id: number;
  label: string;
  raw_tokens: string;
  updated_at: string;
  grid_square: string | null;
  latitude: number | null;
  longitude: number | null;
}

function elapsed(iso: string): string {
  return formatAge((Date.now() - new Date(iso).getTime()) / 1000);
}

function ResourcesPanel() {
  const [resources, setResources] = useState<Resource[]>([]);
  const [label, setLabel] = useState("");
  const [tokens, setTokens] = useState("");
  const [gridSquare, setGridSquare] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setResources(await invoke<Resource[]>("get_resources"));
    } catch (err) {
      // Real bug found live 2026-10-09: no catch here meant a failed
      // fetch left `resources` at whatever it last was with zero
      // indication anything went wrong -- same honest-failure gap as
      // this whole file's other two unguarded calls below, just without
      // a loading-gate hang since this one already initializes to [].
      console.error("get_resources failed:", err);
      setError(String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim() || !tokens.trim()) return;
    // Real bug found live 2026-10-09: no catch meant a failed save
    // silently did nothing -- the form didn't clear, nothing was added
    // to the list, and the user had no idea why clicking "Add"/"Update"
    // appeared to do nothing.
    try {
      await invoke("upsert_resource", { id: editingId, label, rawTokens: tokens, gridSquare: gridSquare || null });
      setError(null);
      setLabel("");
      setTokens("");
      setGridSquare("");
      setEditingId(null);
      refresh();
    } catch (err) {
      console.error("upsert_resource failed:", err);
      setError(String(err));
    }
  }

  function edit(r: Resource) {
    setEditingId(r.id);
    setLabel(r.label);
    setTokens(r.raw_tokens);
    setGridSquare(r.grid_square ?? "");
  }

  async function remove(id: number) {
    try {
      await invoke("delete_resource", { id });
      setError(null);
      if (editingId === id) {
        setEditingId(null);
        setLabel("");
        setTokens("");
        setGridSquare("");
      }
      refresh();
    } catch (err) {
      console.error("delete_resource failed:", err);
      setError(String(err));
    }
  }

  return (
    <div className="panel-resources">
      <form className="resource-form" onSubmit={save}>
        <input value={label} onChange={(e) => setLabel(e.currentTarget.value)} placeholder="Location or callsign" />
        <input
          value={tokens}
          onChange={(e) => setTokens(e.currentTarget.value)}
          placeholder="[Beds 30/100][Power OK][Water -50]"
        />
        <input
          value={gridSquare}
          onChange={(e) => setGridSquare(e.currentTarget.value)}
          placeholder="Grid square (optional, for the map)"
        />
        <button type="submit">{editingId !== null ? "Update" : "Add"}</button>
      </form>

      {error && <div className="panel-alerts-empty">{error}</div>}

      {resources.length === 0 ? (
        <div className="panel-alerts-empty">No resources tracked yet.</div>
      ) : (
        <div className="resource-list">
          {resources.map((r) => (
            <div key={r.id} className="resource-row">
              <div className="resource-header">
                <span className="resource-label">{r.label}</span>
                <span>updated {elapsed(r.updated_at)}</span>
              </div>
              <div className="resource-tokens">
                {parseTokens(r.raw_tokens).map((t, i) => (
                  <span key={i} className="resource-chip">
                    {t.key}: {t.value}
                  </span>
                ))}
              </div>
              <div className="resource-actions">
                <button type="button" onClick={() => edit(r)}>
                  Edit
                </button>
                <button type="button" onClick={() => remove(r.id)}>
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

export default ResourcesPanel;
