interface ExportableMarker {
  label: string;
  marker_type: string;
  latitude: number;
  longitude: number;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function markersToGpx(markers: ExportableMarker[]): string {
  const wpts = markers
    .map(
      (m) =>
        `  <wpt lat="${m.latitude}" lon="${m.longitude}">\n    <name>${escapeXml(m.label)}</name>\n    <type>${escapeXml(m.marker_type)}</type>\n  </wpt>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="WayStation Tactical Map" xmlns="http://www.topografix.com/GPX/1/1">\n${wpts}\n</gpx>\n`;
}

export function markersToKml(markers: ExportableMarker[]): string {
  const placemarks = markers
    .map(
      (m) =>
        `    <Placemark>\n      <name>${escapeXml(m.label)}</name>\n      <description>${escapeXml(m.marker_type)}</description>\n      <Point><coordinates>${m.longitude},${m.latitude},0</coordinates></Point>\n    </Placemark>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n  <Document>\n${placemarks}\n  </Document>\n</kml>\n`;
}

export function downloadTextFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
