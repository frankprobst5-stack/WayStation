import { useState } from "react";

// Standard rule-of-thumb constants (feet, frequency in MHz). Real antennas
// need trimming/tuning by SWR measurement — these are starting points, not
// exact resonant lengths (conductor diameter, height, and nearby objects
// all shift the real value).
type AntennaType = "dipole" | "vertical" | "quad" | "jpole";

const ANTENNA_LABELS: Record<AntennaType, string> = {
  dipole: "Dipole (half-wave)",
  vertical: "Vertical (quarter-wave)",
  quad: "Quad loop (full-wave)",
  jpole: "J-Pole",
};

function feetToFtIn(feet: number): string {
  const wholeFeet = Math.floor(feet);
  const inches = (feet - wholeFeet) * 12;
  return `${wholeFeet}' ${inches.toFixed(1)}"`;
}

function AntennaCalculatorPanel() {
  const [type, setType] = useState<AntennaType>("dipole");
  const [freq, setFreq] = useState("146");

  const f = parseFloat(freq);
  const valid = !isNaN(f) && f > 0;

  function render() {
    if (!valid) return null;
    if (type === "dipole") {
      const total = 468 / f;
      return (
        <>
          <div className="sw-tile">
            <span className="sw-label">Total length</span>
            <span className="sw-value">{feetToFtIn(total)}</span>
          </div>
          <div className="sw-tile">
            <span className="sw-label">Each leg</span>
            <span className="sw-value">{feetToFtIn(total / 2)}</span>
          </div>
        </>
      );
    }
    if (type === "vertical") {
      const total = 234 / f;
      return (
        <div className="sw-tile">
          <span className="sw-label">Radiator length</span>
          <span className="sw-value">{feetToFtIn(total)}</span>
        </div>
      );
    }
    if (type === "quad") {
      const total = 1005 / f;
      return (
        <div className="sw-tile">
          <span className="sw-label">Loop perimeter</span>
          <span className="sw-value">{feetToFtIn(total)}</span>
        </div>
      );
    }
    // jpole
    const radiator = 468 / f;
    const stub = 234 / f;
    return (
      <>
        <div className="sw-tile">
          <span className="sw-label">Radiator</span>
          <span className="sw-value">{feetToFtIn(radiator)}</span>
        </div>
        <div className="sw-tile">
          <span className="sw-label">Matching stub</span>
          <span className="sw-value">{feetToFtIn(stub)}</span>
        </div>
      </>
    );
  }

  return (
    <div className="panel-calc">
      <div className="calc-row">
        <select value={type} onChange={(e) => setType(e.currentTarget.value as AntennaType)}>
          {(Object.keys(ANTENNA_LABELS) as AntennaType[]).map((t) => (
            <option key={t} value={t}>
              {ANTENNA_LABELS[t]}
            </option>
          ))}
        </select>
        <input
          value={freq}
          onChange={(e) => setFreq(e.currentTarget.value)}
          placeholder="Frequency (MHz)"
        />
      </div>

      {valid ? (
        <div className="bearing-result">{render()}</div>
      ) : (
        <div className="field-error">Enter a frequency in MHz.</div>
      )}

      <div className="bandplan-disclaimer">
        Rule-of-thumb starting dimensions — always trim and tune by SWR measurement. Real length depends on conductor diameter, height, and nearby objects.
      </div>
    </div>
  );
}

export default AntennaCalculatorPanel;
