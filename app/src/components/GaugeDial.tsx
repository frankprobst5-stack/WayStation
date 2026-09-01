function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export type GaugeTier = "quiet" | "unsettled" | "storm" | null;

interface GaugeDialProps {
  label: string;
  value: number | null;
  min: number;
  max: number;
  unit?: string;
  tier?: GaugeTier;
  decimals?: number;
}

/** Semicircular analog-meter-style gauge, SVG. `pathLength={100}` on both
 * arcs normalizes stroke-dasharray/dashoffset to plain percentages,
 * avoiding real arc-length math. */
function GaugeDial({ label, value, min, max, unit, tier, decimals = 0 }: GaugeDialProps) {
  const hasValue = value !== null && !isNaN(value);
  const percent = hasValue ? ((clamp(value, min, max) - min) / (max - min)) * 100 : 0;
  const arcPath = "M 10 50 A 40 40 0 1 1 90 50";

  return (
    <div className={`gauge-dial ${tier ? `gauge-${tier}` : ""}`}>
      <svg viewBox="0 0 100 58" className="gauge-svg">
        <path d={arcPath} pathLength={100} className="gauge-track" />
        <path
          d={arcPath}
          pathLength={100}
          className="gauge-fill"
          style={{ strokeDasharray: 100, strokeDashoffset: 100 - percent }}
        />
      </svg>
      <div className="gauge-value">{hasValue ? value.toFixed(decimals) : "—"}{unit}</div>
      <div className="gauge-label">{label}</div>
    </div>
  );
}

export default GaugeDial;
