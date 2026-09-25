import * as maplibregl from "maplibre-gl";
import { Protocol, PMTiles } from "pmtiles";
import { namedTheme, layers as protomapsLayers } from "protomaps-themes-base";

// Real primary path: Citadel's own already-running nginx serving
// comms_base.pmtiles/tactical_terrain.pmtiles over plain HTTP range
// requests, matching Citadel's own verified-working Tactical Map exactly
// (same protomaps-themes-base styling, same 'dark' theme). Decided
// 2026-08-31 -- the whole family/group runs Citadel, so this is the real
// path, not a nice-to-have. Shared by every WayStation panel that shows a
// map (TacticalMapPanel, WeatherPanel's Radar tab) so they never drift
// into two different styling approaches.
//
// OpenFreeMap stays as the fallback for anyone running WayStation
// standalone without Citadel: genuinely free, no API key, no rate limit,
// MIT-licensed and self-hostable if terms ever change -- checked directly
// before using, same discipline as WebSDR/RepeaterBook/POTA elsewhere in
// this project.
export const ONLINE_STYLE = "https://tiles.openfreemap.org/styles/liberty";

const CITADEL_PROBE_TIMEOUT_MS = 2000;

export function citadelBase(host: string | null): string {
  const h = (host || "127.0.0.1:8085").trim();
  return `http://${h}`;
}

let sharedProtocol: Protocol | null = null;
export function ensurePmtilesProtocol(): Protocol {
  if (!sharedProtocol) {
    sharedProtocol = new Protocol();
    maplibregl.addProtocol("pmtiles", sharedProtocol.tile);
  }
  return sharedProtocol;
}

export async function probeReachable(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CITADEL_PROBE_TIMEOUT_MS);
    const resp = await fetch(url, { method: "HEAD", signal: controller.signal });
    clearTimeout(timeout);
    return resp.ok;
  } catch {
    return false;
  }
}

/** Mirrors Citadel's own map.html (background + hillshade + base layers,
 * 'dark' theme) rather than inventing a second styling approach. One
 * tradeoff carried over unchanged from Citadel: label glyphs still come
 * from a hosted URL, so text labels specifically need internet even in
 * this "local" mode -- roads/terrain/water don't.
 *
 * The terrain/hillshade file is treated as optional, not assumed present
 * -- comms_base.pmtiles (roads/labels) is the one thing the caller
 * actually checks for before calling this, and standalone users following
 * the manual's tile instructions may reasonably only bother downloading
 * that one. Silently requiring a second file that isn't there would mean
 * a MapLibre source error firing on load for something that was never
 * promised to exist. */
export async function citadelStyle(base: string): Promise<{ style: maplibregl.StyleSpecification; hasTerrain: boolean }> {
  const protocol = ensurePmtilesProtocol();
  const basemapUrl = `${base}/tiles/comms_base.pmtiles`;
  const terrainUrl = `${base}/tiles/tactical_terrain.pmtiles`;
  protocol.add(new PMTiles(basemapUrl));

  const theme = namedTheme("dark");
  const baseLayers = protomapsLayers("basemap", theme, { lang: "en" });
  const hasTerrain = await probeReachable(terrainUrl);

  const sources: maplibregl.StyleSpecification["sources"] = {
    basemap: {
      type: "vector",
      url: `pmtiles://${basemapUrl}`,
      attribution: '© <a href="https://openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
    },
  };
  const layers: maplibregl.LayerSpecification[] = [{ id: "bg", type: "background", paint: { "background-color": theme.background } }];

  if (hasTerrain) {
    protocol.add(new PMTiles(terrainUrl));
    sources.terrain = { type: "raster-dem", url: `pmtiles://${terrainUrl}`, encoding: "terrarium", tileSize: 256 };
    layers.push({
      id: "hillshade",
      type: "hillshade",
      // Retinted 2026-09-24, WayStation-side only: the olive-green highlight
      // was a real, visible green wash across the whole Tactical Map terrain
      // -- much more obvious than any single marker color. Shadow/highlight
      // now reuse Citadel's own real bg/border values (cockpit/index.html's
      // --bg and --border) instead of inventing new hex, keeping the same
      // shadow/highlight luminance contrast the terrain relief needs.
      source: "terrain",
      paint: { "hillshade-shadow-color": "#05090d", "hillshade-highlight-color": "#2a4a66", "hillshade-exaggeration": 0.6 },
    });
  }

  return {
    style: {
      version: 8,
      glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
      sources,
      layers: [...layers, ...baseLayers],
    },
    hasTerrain,
  };
}
