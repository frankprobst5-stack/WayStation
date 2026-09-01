import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { subsolarPoint, cosZenith } from "../lib/solar";
import { gridSquareToLatLon } from "../lib/maidenhead";
import { drawLand, drawGraticule, drawPin } from "../lib/mapCanvas";

const NIGHT_GRID_LON = 120; // 3-degree resolution offscreen buffer for the terminator shading
const NIGHT_GRID_LAT = 60;
const TERMINATOR_REFRESH_MS = 60_000; // the terminator moves ~0.25 deg/min; once a minute is plenty
const HOVER_HIT_RADIUS_PX = 8;

interface PotaSpot {
  activator: string;
  frequency_mhz: number | null;
  mode: string | null;
  reference: string;
  park_name: string | null;
  latitude: number | null;
  longitude: number | null;
}

interface PskSpot {
  heard_by_call: string;
  heard_by_grid: string | null;
  freq_mhz: number | null;
  mode: string | null;
  snr: number | null;
}

interface QsoLogEntry {
  call: string;
  band: string | null;
  mode: string;
  gridsquare: string | null;
  qso_date: string;
  time_on: string;
}

interface MapMarker {
  lat: number;
  lon: number;
  color: string;
  summary: string[];
}

function drawNightOverlay(ctx: CanvasRenderingContext2D, width: number, height: number, subsolar: { lat: number; lon: number }) {
  const buffer = document.createElement("canvas");
  buffer.width = NIGHT_GRID_LON;
  buffer.height = NIGHT_GRID_LAT;
  const bctx = buffer.getContext("2d")!;
  const image = bctx.createImageData(NIGHT_GRID_LON, NIGHT_GRID_LAT);

  for (let py = 0; py < NIGHT_GRID_LAT; py++) {
    const lat = 90 - (py / NIGHT_GRID_LAT) * 180;
    for (let px = 0; px < NIGHT_GRID_LON; px++) {
      const lon = (px / NIGHT_GRID_LON) * 360 - 180;
      const cz = cosZenith(lat, lon, subsolar);
      // cz > 0.05: day (alpha 0). cz < -0.05: night (alpha ~0.55). Between: twilight gradient.
      const t = Math.min(1, Math.max(0, (0.05 - cz) / 0.1));
      const alpha = Math.round(t * 140);
      const idx = (py * NIGHT_GRID_LON + px) * 4;
      image.data[idx] = 0;
      image.data[idx + 1] = 0;
      image.data[idx + 2] = 10;
      image.data[idx + 3] = alpha;
    }
  }
  bctx.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(buffer, 0, 0, width, height);
}

function WorldMapPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [station, setStation] = useState<{ lon: number; lat: number } | null>(null);
  const [markers, setMarkers] = useState<MapMarker[]>([]);
  const hitTestRef = useRef<{ x: number; y: number; marker: MapMarker }[]>([]);
  const [hover, setHover] = useState<{ x: number; y: number; marker: MapMarker } | null>(null);

  useEffect(() => {
    invoke<{ grid_square: string | null }>("get_station_profile").then((p) => {
      if (p.grid_square) setStation(gridSquareToLatLon(p.grid_square));
    });
  }, []);

  // Three data sources genuinely carry a real location: POTA spots have
  // lat/lon directly from the API, PSKReporter reception reports and
  // logged QSOs both have an optional grid square. DX cluster spots are
  // deliberately NOT plotted here — that feed carries only callsigns, no
  // coordinates, and guessing a location from a callsign prefix would
  // need a verified DXCC country/prefix database this app doesn't have.
  async function refreshMarkers() {
    const [potaSpots, pskSpots, qsoLog] = await Promise.all([
      invoke<PotaSpot[]>("get_pota_spots"),
      invoke<PskSpot[]>("get_psk_spots"),
      invoke<QsoLogEntry[]>("get_qso_log"),
    ]);

    const next: MapMarker[] = [];

    for (const s of potaSpots) {
      if (s.latitude === null || s.longitude === null) continue;
      next.push({
        lat: s.latitude,
        lon: s.longitude,
        color: "#39d97a",
        summary: [
          `POTA: ${s.activator} @ ${s.reference}`,
          s.park_name ?? "",
          `${s.frequency_mhz !== null ? s.frequency_mhz.toFixed(3) + " MHz" : ""} ${s.mode ?? ""}`.trim(),
        ].filter(Boolean),
      });
    }

    for (const s of pskSpots) {
      if (!s.heard_by_grid) continue;
      const pos = gridSquareToLatLon(s.heard_by_grid);
      if (!pos) continue;
      next.push({
        lat: pos.lat,
        lon: pos.lon,
        color: "#ffb000",
        summary: [
          `Heard by ${s.heard_by_call}`,
          `${s.freq_mhz !== null ? s.freq_mhz.toFixed(3) + " MHz" : ""} ${s.mode ?? ""}`.trim(),
          s.snr !== null ? `SNR ${s.snr} dB` : "",
        ].filter(Boolean),
      });
    }

    for (const q of qsoLog) {
      if (!q.gridsquare) continue;
      const pos = gridSquareToLatLon(q.gridsquare);
      if (!pos) continue;
      next.push({
        lat: pos.lat,
        lon: pos.lon,
        color: "#c77dff",
        summary: [`${q.call} — ${q.band ?? "?"} ${q.mode}`, `${q.qso_date} ${q.time_on}Z`],
      });
    }

    setMarkers(next);
  }

  useEffect(() => {
    refreshMarkers();
    let unlistenPota: (() => void) | undefined;
    let unlistenPsk: (() => void) | undefined;
    listen("pota-spots-changed", refreshMarkers).then((fn) => {
      unlistenPota = fn;
    });
    listen("psk-spots-changed", refreshMarkers).then((fn) => {
      unlistenPsk = fn;
    });
    return () => {
      unlistenPota?.();
      unlistenPsk?.();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    function render() {
      const width = container!.clientWidth;
      const height = Math.round(width / 2); // equirectangular: 2:1 aspect
      canvas!.width = width;
      canvas!.height = height;
      const ctx = canvas!.getContext("2d")!;

      ctx.fillStyle = "#1a2a3a";
      ctx.fillRect(0, 0, width, height);
      drawLand(ctx, width, height);
      drawNightOverlay(ctx, width, height, subsolarPoint(new Date()));
      drawGraticule(ctx, width, height);

      const hits: { x: number; y: number; marker: MapMarker }[] = [];
      for (const m of markers) {
        const [x, y] = drawPin(ctx, width, height, m.lon, m.lat, m.color);
        hits.push({ x, y, marker: m });
      }
      if (station) {
        const [x, y] = drawPin(ctx, width, height, station.lon, station.lat, "#ff5555");
        hits.push({ x, y, marker: { lat: station.lat, lon: station.lon, color: "#ff5555", summary: ["Your station"] } });
      }
      hitTestRef.current = hits;
    }

    render();
    const interval = setInterval(render, TERMINATOR_REFRESH_MS);
    const resizeObserver = new ResizeObserver(render);
    resizeObserver.observe(container);

    return () => {
      clearInterval(interval);
      resizeObserver.disconnect();
    };
  }, [station, markers]);

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    let closest: { x: number; y: number; marker: MapMarker } | null = null;
    let closestDist = HOVER_HIT_RADIUS_PX;
    for (const hit of hitTestRef.current) {
      const d = Math.hypot(hit.x - mx, hit.y - my);
      if (d < closestDist) {
        closestDist = d;
        closest = hit;
      }
    }
    setHover(closest ? { x: mx, y: my, marker: closest.marker } : null);
  }

  return (
    <div ref={containerRef} className="panel-world-map" onMouseMove={handleMouseMove} onMouseLeave={() => setHover(null)}>
      <canvas ref={canvasRef} />
      {hover && (
        <div className="map-tooltip" style={{ left: hover.x + 10, top: hover.y + 10 }}>
          {hover.marker.summary.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export default WorldMapPanel;
