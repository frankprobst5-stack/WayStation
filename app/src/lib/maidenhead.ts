/** Maidenhead grid square (e.g. "EM12ab") to a [lon, lat] centroid. Returns null if invalid. */
export function gridSquareToLatLon(grid: string): { lon: number; lat: number } | null {
  const g = grid.trim().toUpperCase();
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(g)) return null;

  const fieldLon = g.charCodeAt(0) - 65; // A-R -> 0-17, 20 deg each
  const fieldLat = g.charCodeAt(1) - 65; // A-R -> 0-17, 10 deg each
  const squareLon = Number(g[2]); // 0-9, 2 deg each
  const squareLat = Number(g[3]); // 0-9, 1 deg each

  let lon = fieldLon * 20 - 180 + squareLon * 2;
  let lat = fieldLat * 10 - 90 + squareLat * 1;

  if (g.length >= 6) {
    const subsquareLon = g.charCodeAt(4) - 65; // A-X -> 0-23, 5 min each
    const subsquareLat = g.charCodeAt(5) - 65; // A-X -> 0-23, 2.5 min each
    lon += (subsquareLon * 5) / 60 + 2.5 / 60;
    lat += (subsquareLat * 2.5) / 60 + 1.25 / 60;
  } else {
    lon += 1; // centroid of the 2deg x 1deg square
    lat += 0.5;
  }

  return { lon, lat };
}
