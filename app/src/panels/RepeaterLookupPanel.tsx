import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// RepeaterBook's exact response field names aren't fully documented
// publicly — read defensively rather than guess wrong and hide results.
type Repeater = Record<string, unknown>;

function field(r: Repeater, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === "string" && v.trim() !== "") return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

function RepeaterLookupPanel() {
  const [state, setState] = useState("TX");
  const [city, setCity] = useState("");
  const [callsign, setCallsign] = useState("");
  const [results, setResults] = useState<Repeater[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const r = await invoke<Repeater[]>("search_repeaters", {
        state,
        city: city || null,
        callsign: callsign || null,
      });
      setResults(r);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="panel-repeaters">
      <form className="calc-row" onSubmit={search}>
        <input
          value={state}
          onChange={(e) => setState(e.currentTarget.value.toUpperCase())}
          placeholder="State (e.g. TX)"
          maxLength={2}
        />
        <input value={city} onChange={(e) => setCity(e.currentTarget.value)} placeholder="City (optional)" />
        <input
          value={callsign}
          onChange={(e) => setCallsign(e.currentTarget.value.toUpperCase())}
          placeholder="Callsign (optional)"
        />
        <button type="submit" disabled={loading}>
          {loading ? "Searching..." : "Search"}
        </button>
      </form>

      {error && <div className="field-error">{error}</div>}

      {results && results.length === 0 && !error && (
        <div className="panel-alerts-empty">No repeaters found.</div>
      )}

      {results && results.length > 0 && (
        <div className="resource-list">
          {results.map((r, i) => (
            <div key={i} className="resource-row">
              <div className="resource-header">
                <span className="resource-label">
                  {field(r, "Callsign", "callsign") ?? "?"} — {field(r, "Frequency", "frequency") ?? "?"} MHz
                </span>
              </div>
              <div className="resource-tokens">
                {field(r, "Input Freq", "input_frequency") && (
                  <span className="resource-chip">In: {field(r, "Input Freq", "input_frequency")}</span>
                )}
                {field(r, "PL", "CTCSS", "ctcss") && (
                  <span className="resource-chip">Tone: {field(r, "PL", "CTCSS", "ctcss")}</span>
                )}
                {field(r, "Nearest City", "city") && (
                  <span className="resource-chip">{field(r, "Nearest City", "city")}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default RepeaterLookupPanel;
