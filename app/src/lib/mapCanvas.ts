import landOutline from "../assets/land-outline-110m.json";

type Ring = [number, number][];

/** Equirectangular projection: lon/lat in degrees to canvas pixel x/y. */
export function project(lon: number, lat: number, width: number, height: number): [number, number] {
  return [((lon + 180) / 360) * width, ((90 - lat) / 180) * height];
}

export function drawLand(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.fillStyle = "#3a5f3a";
  ctx.beginPath();
  for (const ring of landOutline as Ring[]) {
    ring.forEach(([lon, lat], i) => {
      const [x, y] = project(lon, lat, width, height);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
  }
  ctx.fill();
}

export function drawGraticule(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  for (let lon = -180; lon <= 180; lon += 30) {
    const [x] = project(lon, 0, width, height);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const [, y] = project(0, lat, width, height);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
}

export function drawPin(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  lon: number,
  lat: number,
  color: string,
): [number, number] {
  const [x, y] = project(lon, lat, width, height);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  ctx.stroke();
  return [x, y];
}

/**
 * Draws a polyline through lon/lat points, breaking the path wherever
 * consecutive points cross the antimeridian (a >180° jump in longitude)
 * instead of drawing a spurious line straight across the map.
 */
export function drawTrack(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  points: { lon: number; lat: number }[],
  color: string,
) {
  if (points.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  let started = false;
  let prevLon = points[0].lon;
  for (const p of points) {
    const [x, y] = project(p.lon, p.lat, width, height);
    if (!started || Math.abs(p.lon - prevLon) > 180) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
    prevLon = p.lon;
  }
  ctx.stroke();
}
