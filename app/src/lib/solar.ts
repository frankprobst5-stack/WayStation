/**
 * Subsolar point (where the sun is directly overhead) from a standard
 * low-precision solar position approximation (mean orbital elements +
 * first-order equation-of-center/equation-of-time correction). Good to a
 * fraction of a degree, which is what a greyline overlay needs — this is
 * not a precision ephemeris.
 */
export function subsolarPoint(date: Date): { lat: number; lon: number } {
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;

  const daysSinceJ2000 = (date.getTime() - Date.UTC(2000, 0, 1, 12, 0, 0)) / 86_400_000;

  const meanLongitude = (280.46 + 0.9856474 * daysSinceJ2000) % 360;
  const meanAnomaly = (357.528 + 0.9856003 * daysSinceJ2000) % 360;
  const eclipticLongitude =
    meanLongitude + 1.915 * Math.sin(meanAnomaly * rad) + 0.02 * Math.sin(2 * meanAnomaly * rad);
  const obliquity = 23.439 - 0.0000004 * daysSinceJ2000;

  const declination = Math.asin(Math.sin(obliquity * rad) * Math.sin(eclipticLongitude * rad)) * deg;

  let rightAscension =
    Math.atan2(
      Math.cos(obliquity * rad) * Math.sin(eclipticLongitude * rad),
      Math.cos(eclipticLongitude * rad),
    ) * deg;
  rightAscension = ((rightAscension % 360) + 360) % 360;

  // Equation of time, in minutes (mean longitude vs right ascension, wrapped to +-180deg then to minutes).
  let eotDegrees = meanLongitude - rightAscension;
  if (eotDegrees > 180) eotDegrees -= 360;
  if (eotDegrees < -180) eotDegrees += 360;
  const eotMinutes = eotDegrees * 4;

  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const subsolarLon = -15 * ((utcMinutes + eotMinutes) / 60 - 12);

  return {
    lat: declination,
    lon: (((subsolarLon + 180) % 360) + 360) % 360 - 180,
  };
}

/** Cosine of the solar zenith angle at (lat, lon) — negative means the sun is below the horizon (night). */
export function cosZenith(lat: number, lon: number, subsolar: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const hourAngle = (lon - subsolar.lon) * rad;
  return (
    Math.sin(lat * rad) * Math.sin(subsolar.lat * rad) +
    Math.cos(lat * rad) * Math.cos(subsolar.lat * rad) * Math.cos(hourAngle)
  );
}
