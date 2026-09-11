import { useState } from "react";

// Genuinely missing before this -- confirmed by grep across the whole
// codebase before writing it. Pure unit math, no backend, same shape as
// the other calculators in Tools.
const SPEED_OF_LIGHT_M_S = 299_792_458;

function formatNumber(n: number): string {
  if (n === 0) return "0";
  if (Math.abs(n) >= 1e9 || Math.abs(n) < 1e-6) return n.toExponential(6);
  return n.toLocaleString(undefined, { maximumFractionDigits: 9 });
}

function FrequencyConversionPanel() {
  const [mhz, setMhz] = useState("146.520");

  const f = parseFloat(mhz);
  const valid = !isNaN(f) && f > 0;
  const hz = valid ? f * 1_000_000 : null;
  const wavelengthM = hz !== null ? SPEED_OF_LIGHT_M_S / hz : null;

  return (
    <div className="panel-calc">
      <div className="calc-row">
        <input value={mhz} onChange={(e) => setMhz(e.currentTarget.value)} placeholder="Frequency (MHz)" inputMode="decimal" />
      </div>

      {valid && hz !== null && wavelengthM !== null ? (
        <div className="bearing-result">
          <div className="sw-tile">
            <span className="sw-label">Hz</span>
            <span className="sw-value">{formatNumber(hz)}</span>
          </div>
          <div className="sw-tile">
            <span className="sw-label">kHz</span>
            <span className="sw-value">{formatNumber(hz / 1_000)}</span>
          </div>
          <div className="sw-tile">
            <span className="sw-label">GHz</span>
            <span className="sw-value">{formatNumber(hz / 1_000_000_000)}</span>
          </div>
          <div className="sw-tile">
            <span className="sw-label">Wavelength</span>
            <span className="sw-value">{wavelengthM.toFixed(3)} m ({(wavelengthM * 3.28084).toFixed(2)} ft)</span>
          </div>
        </div>
      ) : (
        <div className="field-error">Enter a frequency in MHz.</div>
      )}

      <div className="bandplan-disclaimer">
        Wavelength is the free-space value (c/f) — real antenna dimensions need the velocity factor / end-effect
        adjustments the Antenna Tools tab's calculators already account for.
      </div>
    </div>
  );
}

export default FrequencyConversionPanel;
