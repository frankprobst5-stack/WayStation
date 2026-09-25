export const RADAR_SOURCE_ID = "rainviewer-radar";
export const RADAR_LAYER_ID = "rainviewer-radar-layer";

export interface RadarFrame {
  /** Unix seconds, RainViewer's own frame timestamp. */
  time: number;
  tileTemplate: string;
}

/** RainViewer's public tile API -- free, no key, verified live before
 * building this (a plain fetch against api.rainviewer.com). Returns the
 * real past-frame sequence (RainViewer keeps roughly the last 2 hours,
 * 10-minute steps) as tile URL templates, oldest first, or null if
 * RainViewer is unreachable or the response shape ever changes -- this is
 * a pure enhancement layer, never something the rest of the map should
 * break over. This is genuinely RainViewer's own composite radar mosaic,
 * not a literal NWS NEXRAD feed -- label it as such wherever it's shown. */
export async function fetchRadarFrames(): Promise<RadarFrame[] | null> {
  try {
    const resp = await fetch("https://api.rainviewer.com/public/weather-maps.json");
    if (!resp.ok) return null;
    const data = await resp.json();
    const frames = data?.radar?.past;
    if (!Array.isArray(frames) || frames.length === 0) return null;
    return frames.map((f: { time: number; path: string }) => ({
      time: f.time,
      tileTemplate: `${data.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`,
    }));
  } catch {
    return null;
  }
}
