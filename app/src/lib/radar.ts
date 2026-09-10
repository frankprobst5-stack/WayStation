export const RADAR_SOURCE_ID = "rainviewer-radar";
export const RADAR_LAYER_ID = "rainviewer-radar-layer";

/** RainViewer's public tile API -- free, no key, verified live before
 * building this (a plain fetch against api.rainviewer.com). Returns the
 * most recent radar frame's tile URL template, or null if RainViewer is
 * unreachable or the response shape ever changes -- this is a pure
 * enhancement layer, never something the rest of the map should break
 * over. This is genuinely RainViewer's own composite radar mosaic, not
 * a literal NWS NEXRAD feed -- label it as such wherever it's shown. */
export async function fetchLatestRadarTileTemplate(): Promise<string | null> {
  try {
    const resp = await fetch("https://api.rainviewer.com/public/weather-maps.json");
    if (!resp.ok) return null;
    const data = await resp.json();
    const frames = data?.radar?.past;
    if (!Array.isArray(frames) || frames.length === 0) return null;
    const latest = frames[frames.length - 1];
    return `${data.host}${latest.path}/256/{z}/{x}/{y}/2/1_1.png`;
  } catch {
    return null;
  }
}
