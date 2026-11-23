import { useState } from "react";
import SaveCalcButton from "../components/SaveCalcButton";

type Mode = "power" | "voltage";

function DecibelCalculatorPanel() {
  const [mode, setMode] = useState<Mode>("power");
  const [p1, setP1] = useState("100");
  const [p2, setP2] = useState("50");

  const a = parseFloat(p1);
  const b = parseFloat(p2);
  const valid = !isNaN(a) && !isNaN(b) && a > 0 && b > 0;
  const db = valid ? (mode === "power" ? 10 : 20) * Math.log10(b / a) : null;

  return (
    <div className="panel-calc">
      <div className="calc-row">
        <select value={mode} onChange={(e) => setMode(e.currentTarget.value as Mode)}>
          <option value="power">Power ratio (10·log₁₀)</option>
          <option value="voltage">Voltage/field ratio (20·log₁₀)</option>
        </select>
      </div>
      <div className="calc-row">
        <input value={p1} onChange={(e) => setP1(e.currentTarget.value)} placeholder="P1 / V1 (reference)" />
        <input value={p2} onChange={(e) => setP2(e.currentTarget.value)} placeholder="P2 / V2" />
      </div>

      {db !== null ? (
        <>
          <div className="sw-tile">
            <span className="sw-label">Result</span>
            <span className="sw-value">{db.toFixed(2)} dB</span>
          </div>
          <SaveCalcButton
            tool="Decibel"
            summary={`${mode === "power" ? "Power" : "Voltage/field"} ratio ${p1}->${p2} = ${db.toFixed(2)} dB`}
          />
        </>
      ) : (
        <div className="field-error">Enter two positive numbers.</div>
      )}
    </div>
  );
}

export default DecibelCalculatorPanel;
