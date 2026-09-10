/** NWS heat index, °F. Uses the simplified Steadman formula outside hot/
 * humid conditions, falling through to the full Rothfusz regression (with
 * NWS's own low/high-humidity correction terms) only when that simplified
 * average is actually in heat-index territory -- matches NWS's own
 * published algorithm, not an approximation of it. Only meaningful when
 * it's hot; `feelsLikeF` below only calls this when that's true. */
export function heatIndexF(tempF: number, humidityPct: number): number {
  const T = tempF;
  const RH = humidityPct;
  const simple = 0.5 * (T + 61 + (T - 68) * 1.2 + RH * 0.094);
  if ((simple + T) / 2 < 80) return simple;

  let hi =
    -42.379 +
    2.04901523 * T +
    10.14333127 * RH -
    0.22475541 * T * RH -
    0.00683783 * T * T -
    0.05481717 * RH * RH +
    0.00122874 * T * T * RH +
    0.00085282 * T * RH * RH -
    0.00000199 * T * T * RH * RH;

  if (RH < 13 && T >= 80 && T <= 112) {
    hi -= ((13 - RH) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
  } else if (RH > 85 && T >= 80 && T <= 87) {
    hi += ((RH - 85) / 10) * ((87 - T) / 5);
  }
  return hi;
}

/** NWS wind chill, °F. Only valid for cold, windy conditions --
 * `feelsLikeF` below only calls this when both hold. */
export function windChillF(tempF: number, windMph: number): number {
  const v016 = Math.pow(windMph, 0.16);
  return 35.74 + 0.6215 * tempF - 35.75 * v016 + 0.4275 * tempF * v016;
}

/** Picks whichever NWS apparent-temperature formula actually applies to
 * the current conditions, falling back to the plain air temperature
 * outside both formulas' valid ranges (e.g. a mild 65°F breeze) rather
 * than inventing a third blended number NWS itself doesn't define. */
export function feelsLikeF(tempF: number, humidityPct: number | null, windMph: number | null): number {
  if (tempF <= 50 && windMph !== null && windMph >= 3) {
    return windChillF(tempF, windMph);
  }
  if (tempF >= 80 && humidityPct !== null) {
    return heatIndexF(tempF, humidityPct);
  }
  return tempF;
}

export interface ForecastPeriodLike {
  name: string;
  start_time: string;
  is_daytime: boolean;
  temperature: number | null;
  temperature_unit: string | null;
  probability_of_precip: number | null;
  icon: string | null;
  short_forecast: string | null;
}

export interface DayForecast {
  label: string;
  date: string;
  highF: number | null;
  lowF: number | null;
  icon: string | null;
  shortForecast: string | null;
  precipPct: number | null;
}

/** Pairs each daytime period with the night that follows it (NWS's
 * gridpoint forecast alternates day/night) to build one card per day
 * with a high and low, instead of showing 14 separate stacked periods.
 * A leading night-only period (the feed can start mid-night, e.g.
 * "Tonight" first) still gets its own card, just with no high yet. */
export function buildDayStrip(periods: ForecastPeriodLike[], maxDays = 7): DayForecast[] {
  const days: DayForecast[] = [];
  let i = 0;
  while (i < periods.length && days.length < maxDays) {
    const p = periods[i];
    if (p.is_daytime) {
      const next = periods[i + 1];
      const pairsWithNight = next && !next.is_daytime;
      days.push({
        label: p.name,
        date: p.start_time,
        highF: p.temperature,
        lowF: pairsWithNight ? next.temperature : null,
        icon: p.icon,
        shortForecast: p.short_forecast,
        precipPct: p.probability_of_precip,
      });
      i += pairsWithNight ? 2 : 1;
    } else {
      days.push({
        label: p.name,
        date: p.start_time,
        highF: null,
        lowF: p.temperature,
        icon: p.icon,
        shortForecast: p.short_forecast,
        precipPct: p.probability_of_precip,
      });
      i += 1;
    }
  }
  return days;
}
