import { useState } from "react";

// S = P·G / (4πR²), the FCC OET Bulletin 65 far-field power density formula
// (confirmed directly against the primary source: transition.fcc.gov/
// Bureaus/Engineering_Technology/Documents/bulletins/oet65/oet65.pdf,
// Section 2, Equation confirming S = E²/3770 = 37.7H² and its power form).
//
// Deliberately does NOT embed the MPE limit table (Table 1) to compare
// against: two independent secondary sources gave inconsistent numbers for
// the same frequency band when cross-checked, and this is safety-adjacent
// content — better to compute the number correctly and point to the
// official table than guess at a threshold. See ROADMAP.md.
function powerDensity(powerW: number, gainDbi: number, distanceM: number) {
  const gainLinear = 10 ** (gainDbi / 10);
  const wPerM2 = (powerW * gainLinear) / (4 * Math.PI * distanceM ** 2);
  return { wPerM2, mwPerCm2: wPerM2 * 0.1 };
}

function RfSafetyPanel() {
  const [power, setPower] = useState("100");
  const [gain, setGain] = useState("2.15");
  const [distance, setDistance] = useState("3");

  const p = parseFloat(power);
  const g = parseFloat(gain);
  const d = parseFloat(distance);
  const valid = !isNaN(p) && !isNaN(g) && !isNaN(d) && p > 0 && d > 0;
  const result = valid ? powerDensity(p, g, d) : null;

  return (
    <div className="panel-calc">
      <div className="calc-row">
        <input value={power} onChange={(e) => setPower(e.currentTarget.value)} placeholder="Power at antenna (W)" />
        <input value={gain} onChange={(e) => setGain(e.currentTarget.value)} placeholder="Antenna gain (dBi)" />
        <input value={distance} onChange={(e) => setDistance(e.currentTarget.value)} placeholder="Distance (m)" />
      </div>

      {result ? (
        <div className="bearing-result">
          <div className="sw-tile">
            <span className="sw-label">Power Density</span>
            <span className="sw-value">{result.mwPerCm2.toFixed(4)} mW/cm²</span>
          </div>
          <div className="sw-tile">
            <span className="sw-label">&nbsp;</span>
            <span className="sw-value">{result.wPerM2.toFixed(2)} W/m²</span>
          </div>
        </div>
      ) : (
        <div className="field-error">Enter power, gain, and a positive distance.</div>
      )}

      <div className="bandplan-disclaimer">
        This computes far-field power density only — it does NOT tell you whether that's safe. Compare against
        the actual FCC MPE limits (frequency-dependent, different for controlled/occupational vs. general
        population/uncontrolled exposure, and duty-cycle dependent) in FCC OET Bulletin 65, Table 1, or run the
        official ARRL/FCC RF exposure calculator before relying on this for compliance.
      </div>
    </div>
  );
}

export default RfSafetyPanel;
