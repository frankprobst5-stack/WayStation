import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface IncidentInfo {
  incident_name: string | null;
  operational_period: string | null;
  net_frequency: string | null;
  net_status: string | null;
  updated_at: string | null;
}

const EMPTY: IncidentInfo = {
  incident_name: null,
  operational_period: null,
  net_frequency: null,
  net_status: null,
  updated_at: null,
};

function IncidentInfoPanel() {
  const [saved, setSaved] = useState<IncidentInfo>(EMPTY);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<IncidentInfo>(EMPTY);
  const [saving, setSaving] = useState(false);

  async function refresh() {
    const info = await invoke<IncidentInfo>("get_incident_info");
    setSaved(info);
    setForm(info);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const info = await invoke<IncidentInfo>("save_incident_info", {
        incidentName: form.incident_name || null,
        operationalPeriod: form.operational_period || null,
        netFrequency: form.net_frequency || null,
        netStatus: form.net_status || null,
      });
      setSaved(info);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <form className="panel-incident-info incident-form" onSubmit={save}>
        <label>
          Incident name
          <input
            value={form.incident_name ?? ""}
            onChange={(e) => setForm({ ...form, incident_name: e.currentTarget.value })}
            placeholder="e.g. Hurricane Alex"
          />
        </label>
        <label>
          Operational period
          <input
            value={form.operational_period ?? ""}
            onChange={(e) => setForm({ ...form, operational_period: e.currentTarget.value })}
            placeholder="e.g. 1400Z-1800Z Aug 29"
          />
        </label>
        <label>
          Active net frequency
          <input
            value={form.net_frequency ?? ""}
            onChange={(e) => setForm({ ...form, net_frequency: e.currentTarget.value })}
            placeholder="e.g. 146.520 MHz (VHF)"
          />
        </label>
        <label>
          Net status
          <input
            value={form.net_status ?? ""}
            onChange={(e) => setForm({ ...form, net_status: e.currentTarget.value })}
            placeholder="e.g. ACTIVE"
          />
        </label>
        <div className="incident-form-actions">
          <button type="submit" disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </button>
          <button type="button" onClick={() => { setForm(saved); setEditing(false); }}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  const hasAny = saved.incident_name || saved.operational_period || saved.net_frequency || saved.net_status;

  return (
    <div className="panel-incident-info">
      {!hasAny ? (
        <div className="panel-alerts-empty">
          No incident set. <button type="button" onClick={() => setEditing(true)}>Set incident info</button>
        </div>
      ) : (
        <>
          <div className="incident-summary">
            <div className="incident-box">
              <div className="incident-box-title">Situation Summary</div>
              <div className="incident-field">
                <span className="incident-field-label">Incident</span>
                <span className="incident-field-value">{saved.incident_name || "—"}</span>
              </div>
              <div className="incident-field">
                <span className="incident-field-label">Op. Period</span>
                <span className="incident-field-value">{saved.operational_period || "—"}</span>
              </div>
            </div>
            <div className="incident-box">
              <div className="incident-box-title">Active Net Info</div>
              <div className="incident-field">
                <span className="incident-field-label">Net Freq</span>
                <span className="incident-field-value">{saved.net_frequency || "—"}</span>
              </div>
              <div className="incident-field">
                <span className="incident-field-label">Status</span>
                <span className="incident-field-value incident-status">{saved.net_status || "—"}</span>
              </div>
            </div>
          </div>
          <button type="button" className="incident-edit-button" onClick={() => setEditing(true)}>
            Edit
          </button>
        </>
      )}
    </div>
  );
}

export default IncidentInfoPanel;
