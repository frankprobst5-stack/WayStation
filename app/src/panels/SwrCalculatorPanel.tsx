import { useState } from "react";

type Mode = "power" | "impedance";

function swrFromReflection(gamma: number): number {
  return (1 + gamma) / (1 - gamma);
}

function SwrCalculatorPanel() {
  const [mode, setMode] = useState<Mode>("power");
  const [fwd, setFwd] = useState("100");
  const [refl, setRefl] = useState("4");
  const [z0, setZ0] = useState("50");
  const [r, setR] = useState("50");
  const [x, setX] = useState("0");

  let swr: number | null = null;
  let returnLossDb: number | null = null;
  let error: string | null = null;

  if (mode === "power") {
    const pf = parseFloat(fwd);
    const pr = parseFloat(refl);
    if (isNaN(pf) || isNaN(pr) || pf <= 0 || pr < 0) {
      error = "Enter forward power > 0 and reflected power ≥ 0.";
    } else if (pr >= pf) {
      error = "Reflected power can't exceed forward power.";
    } else {
      const gamma = Math.sqrt(pr / pf);
      swr = swrFromReflection(gamma);
      returnLossDb = -10 * Math.log10(pr / pf);
    }
  } else {
    const z0n = parseFloat(z0);
    const rn = parseFloat(r);
    const xn = parseFloat(x);
    if (isNaN(z0n) || isNaN(rn) || isNaN(xn) || z0n <= 0 || rn < 0) {
      error = "Enter a valid line impedance and load R/X.";
    } else {
      const gamma = Math.sqrt(((rn - z0n) ** 2 + xn ** 2) / ((rn + z0n) ** 2 + xn ** 2));
      if (gamma >= 1) {
        error = "That load reflects 100% or more — check the values.";
      } else {
        swr = swrFromReflection(gamma);
        returnLossDb = -20 * Math.log10(gamma);
      }
    }
  }

  return (
    <div className="panel-calc">
      <div className="calc-row">
        <select value={mode} onChange={(e) => setMode(e.currentTarget.value as Mode)}>
          <option value="power">From forward/reflected power</option>
          <option value="impedance">From load impedance (R + jX)</option>
        </select>
      </div>

      {mode === "power" ? (
        <div className="calc-row">
          <input value={fwd} onChange={(e) => setFwd(e.currentTarget.value)} placeholder="Forward power (W)" />
          <input value={refl} onChange={(e) => setRefl(e.currentTarget.value)} placeholder="Reflected power (W)" />
        </div>
      ) : (
        <div className="calc-row">
          <input value={z0} onChange={(e) => setZ0(e.currentTarget.value)} placeholder="Line Z0 (Ω)" />
          <input value={r} onChange={(e) => setR(e.currentTarget.value)} placeholder="Load R (Ω)" />
          <input value={x} onChange={(e) => setX(e.currentTarget.value)} placeholder="Load X (Ω, + ind / - cap)" />
        </div>
      )}

      {error ? (
        <div className="field-error">{error}</div>
      ) : (
        <div className="bearing-result">
          <div className="sw-tile">
            <span className="sw-label">VSWR</span>
            <span className="sw-value">{swr!.toFixed(2)}:1</span>
          </div>
          <div className="sw-tile">
            <span className="sw-label">Return Loss</span>
            <span className="sw-value">{returnLossDb!.toFixed(1)} dB</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default SwrCalculatorPanel;
