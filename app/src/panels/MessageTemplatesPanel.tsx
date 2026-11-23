import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Mirrors db::MessageTemplate. Closes Messaging's own "Not built yet"
// gap, half 2: preset quick-messages an operator can save once and fill
// into any compose box (see MeshPanel's own template quick-pick)
// instead of retyping the same status line or SITREP request every time.
interface MessageTemplate {
  id: number;
  label: string;
  body: string;
  updated_at: string;
}

function MessageTemplatesPanel() {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [label, setLabel] = useState("");
  const [body, setBody] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setTemplates(await invoke<MessageTemplate[]>("get_message_templates"));
    } catch (err) {
      console.error("get_message_templates failed:", err);
      setError(String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function resetForm() {
    setEditingId(null);
    setLabel("");
    setBody("");
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim() || !body.trim()) return;
    try {
      await invoke("upsert_message_template", { id: editingId, label: label.trim(), body: body.trim() });
      setError(null);
      resetForm();
      await refresh();
    } catch (err) {
      console.error("upsert_message_template failed:", err);
      setError(String(err));
    }
  }

  function edit(t: MessageTemplate) {
    setEditingId(t.id);
    setLabel(t.label);
    setBody(t.body);
  }

  async function remove(id: number) {
    try {
      await invoke("delete_message_template", { id });
      setError(null);
      if (editingId === id) resetForm();
      await refresh();
    } catch (err) {
      console.error("delete_message_template failed:", err);
      setError(String(err));
    }
  }

  return (
    <div className="panel-channels">
      <p className="sync-lede">
        Save a short message once, pick it from the quick-fill dropdown next to any compose box (see Mesh) instead
        of retyping the same status line or request every time.
      </p>

      <form className="resource-form" onSubmit={save} style={{ flexDirection: "column", alignItems: "stretch" }}>
        <input value={label} onChange={(e) => setLabel(e.currentTarget.value)} placeholder="Label (e.g. Status Check)" />
        <textarea
          value={body}
          onChange={(e) => setBody(e.currentTarget.value)}
          placeholder="Message text (e.g. Status: all clear, no action needed.)"
          rows={3}
        />
        <button type="submit" style={{ alignSelf: "flex-start" }}>
          {editingId !== null ? "Update" : "Add"}
        </button>
      </form>

      {error && <div className="panel-alerts-empty">{error}</div>}

      {templates.length === 0 ? (
        <div className="panel-alerts-empty">No templates saved yet.</div>
      ) : (
        <div className="resource-list">
          {templates.map((t) => (
            <div key={t.id} className="resource-row">
              <div className="resource-header">
                <span className="resource-label">{t.label}</span>
              </div>
              <div className="resource-tokens">
                <span className="resource-chip">{t.body}</span>
              </div>
              <div className="resource-actions">
                <button type="button" onClick={() => edit(t)}>
                  Edit
                </button>
                <button type="button" onClick={() => remove(t.id)}>
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

export default MessageTemplatesPanel;
