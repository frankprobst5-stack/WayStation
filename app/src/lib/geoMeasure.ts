const EARTH_RADIUS_M = 6371000;

export interface LatLon {
  lat: number;
  lon: number;
}

/** Great-circle distance between two lat/lon points, in meters. */
export function haversineMeters(a: LatLon, b: LatLon): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total path length through an ordered sequence of points, in meters. */
export function pathLengthMeters(points: LatLon[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineMeters(points[i - 1], points[i]);
  return total;
}

/** Cumulative distance (meters) at each point along the path, starting at 0. */
export function cumulativeDistancesMeters(points: LatLon[]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + haversineMeters(points[i - 1], points[i]));
  return cum;
}

/**
 * Enclosed area of a polygon given as lat/lon points, in square meters.
 * Projects to a local equirectangular plane centered on the first point
 * (shoelace formula from there) -- accurate enough at the few-kilometer
 * scale this tool is meant for, not a true geodesic area calculation for
 * continent-spanning polygons.
 */
export function polygonAreaSquareMeters(points: LatLon[]): number {
  if (points.length < 3) return 0;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const lat0 = toRad(points[0].lat);
  const xy = points.map((p) => {
    const x = toRad(p.lon - points[0].lon) * Math.cos(lat0) * EARTH_RADIUS_M;
    const y = toRad(p.lat - points[0].lat) * EARTH_RADIUS_M;
    return [x, y] as [number, number];
  });
  let sum = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

export function metersToFeet(m: number): number {
  return m * 3.28084;
}

export function metersToMiles(m: number): number {
  return m / 1609.344;
}

export function squareMetersToAcres(m2: number): number {
  return m2 / 4046.8564224;
}

/** Human-readable distance: feet under half a mile, miles (2 decimals) beyond that. */
export function formatDistance(m: number): string {
  const miles = metersToMiles(m);
  if (miles < 0.5) return `${Math.round(metersToFeet(m))} ft`;
  return `${miles.toFixed(2)} mi`;
}

export function formatArea(m2: number): string {
  return `${squareMetersToAcres(m2).toFixed(2)} acres`;
}

/** Evenly-spaced sample points along a polyline, interpolated by fraction of total path length. */
export function sampleAlongPath(
  points: LatLon[],
  sampleCount: number,
): (LatLon & { distanceM: number })[] {
  if (points.length < 2) return points.map((p) => ({ ...p, distanceM: 0 }));
  const cum = cumulativeDistancesMeters(points);
  const total = cum[cum.length - 1];
  const samples: (LatLon & { distanceM: number })[] = [];
  for (let i = 0; i <= sampleCount; i++) {
    const target = (total * i) / sampleCount;
    let seg = 0;
    while (seg < cum.length - 2 && cum[seg + 1] < target) seg++;
    const segStart = cum[seg];
    const segEnd = cum[seg + 1];
    const t = segEnd > segStart ? (target - segStart) / (segEnd - segStart) : 0;
    const a = points[seg];
    const b = points[seg + 1];
    samples.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, distanceM: target });
  }
  return samples;
}
