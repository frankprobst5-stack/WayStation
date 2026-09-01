// One-time (rerun-as-needed) generator for the bundled offline land outline.
// Source: world-atlas (Natural Earth 110m land, public domain), converted
// from TopoJSON to a flat array of [lon, lat] polygon rings so the app
// needs no mapping/topojson library at runtime — just plain coordinates
// for our own canvas renderer.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { feature } from "topojson-client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const topology = JSON.parse(
  readFileSync(path.join(__dirname, "../node_modules/world-atlas/land-110m.json")),
);
const geojson = feature(topology, topology.objects.land);

const polygons = [];
for (const f of geojson.features) {
  const rings = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const poly of rings) {
    for (const ring of poly) {
      // Round to 2 decimal places (~1km) — plenty for a world-overview map, keeps the file small.
      polygons.push(ring.map(([lon, lat]) => [Math.round(lon * 100) / 100, Math.round(lat * 100) / 100]));
    }
  }
}

const outPath = path.join(__dirname, "../src/assets/land-outline-110m.json");
writeFileSync(outPath, JSON.stringify(polygons));
console.log(`Wrote ${polygons.length} rings to ${outPath}`);
