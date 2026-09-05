import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol, PMTiles } from "pmtiles";
import { namedTheme, layers as protomapsLayers } from "protomaps-themes-base";
import { gridSquareToLatLon } from "../lib/maidenhead";

// Real primary path: Citadel's own already-running nginx serving
// comms_base.pmtiles/tactical_terrain.pmtiles over plain HTTP range
// requests, matching Citadel's own verified-working Tactical Map exactly
// (same protomaps-themes-base styling, same 'dark' theme). Decided
// 2026-08-31 -- the whole family/group runs Citadel, so this is the real
// path, not a nice-to-have.
//
// OpenFreeMap stays as the fallback for anyone running WayStation
// standalone without Citadel: genuinely free, no API key, no rate limit,
// MIT-licensed and self-hostable if terms ever change -- checked directly
// before using, same discipline as WebSDR/RepeaterBook/POTA elsewhere in
// this project.
const ONLINE_STYLE = "https://tiles.openfreemap.org/styles/liberty";

const DEFAULT_CENTER: [number, number] = [-98.5, 39.8]; // CONUS center, until the station's own grid re-centers it
const DEFAULT_ZOOM = 4;
const CITADEL_PROBE_TIMEOUT_MS = 2000;

interface MeshNode {
  node_num: number;
  long_name: string | null;
  short_name: string | null;
  latitude: number | null;
  longitude: number | null;
}

interface NetRosterEntry {
  id: number;
  callsign: string;
  status: string;
  latitude: number | null;
  longitude: number | null;
}

interface Resource {
  id: number;
  label: string;
  latitude: number | null;
  longitude: number | null;
}

interface MapMarker {
  id: number;
  label: string;
  marker_type: string;
  latitude: number;
  longitude: number;
  origin_station: string | null;
  to_station: string | null;
  created_at: string;
  dispatch_status: string;
  dispatched_via: string | null;
  received_via: string | null;
  incident_id: string | null;
}

interface Incident {
  id: number;
  uuid: string;
  name: string;
  status: "active" | "closed";
}

interface Person {
  id: number;
  name: string;
  callsign: string | null;
  status: string;
  incident_id: string | null;
  latitude: number | null;
  longitude: number | null;
}

interface ResourceRequest {
  id: number;
  resource_type: string;
  description: string | null;
  status: string;
  incident_id: string | null;
  latitude: number | null;
  longitude: number | null;
}

// Mirrors db::AircraftTrack.
interface AircraftTrack {
  id: number;
  fetched_at: string;
  icao24: string;
  callsign: string | null;
  origin_country: string | null;
  latitude: number | null;
  longitude: number | null;
  altitude_m: number | null;
  on_ground: boolean;
  velocity_ms: number | null;
  true_track: number | null;
  vertical_rate_ms: number | null;
  squawk: string | null;
  last_contact: number;
}

const MARKER_TYPES = ["hazard", "shelter", "resource", "info"] as const;

const MARKER_COLORS: Record<string, string> = {
  hazard: "#e64d4d",
  shelter: "#2fb8c4",
  resource: "#b06fe0",
  info: "#c9a227",
};

const PERSONNEL_COLOR = "#ff6ec7";
const RESOURCE_REQUEST_COLOR = "#7c5cff";
const AIRCRAFT_COLOR = "#ffffff";

function aircraftLabel(a: AircraftTrack): string {
  const id = a.callsign ?? a.icao24;
  if (a.on_ground) return `Aircraft: ${id} — on ground`;
  const altitude = a.altitude_m !== null ? `${Math.round(a.altitude_m * 3.28084).toLocaleString()} ft` : "altitude unknown";
  const speed = a.velocity_ms !== null ? `${Math.round(a.velocity_ms * 1.94384)} kt` : null;
  return `Aircraft: ${id} — ${altitude}${speed ? `, ${speed}` : ""}`;
}

function markerStatusText(m: MapMarker): string {
  if (m.received_via) return `received via ${m.received_via}`;
  if (m.dispatch_status === "dispatched") return `sent via ${m.dispatched_via}`;
  return "queued — no transport reached yet";
}

function citadelBase(host: string | null): string {
  const h = (host || "127.0.0.1:8085").trim();
  return `http://${h}`;
}

let sharedProtocol: Protocol | null = null;
function ensurePmtilesProtocol(): Protocol {
  if (!sharedProtocol) {
    sharedProtocol = new Protocol();
    maplibregl.addProtocol("pmtiles", sharedProtocol.tile);
  }
  return sharedProtocol;
}

/** Mirrors Citadel's own map.html (background + hillshade + base layers,
 * 'dark' theme) rather than inventing a second styling approach. One
 * tradeoff carried over unchanged from Citadel: label glyphs still come
 * from a hosted URL, so text labels specifically need internet even in
 * this "local" mode -- roads/terrain/water don't.
 *
 * The terrain/hillshade file is treated as optional, not assumed present
 * -- comms_base.pmtiles (roads/labels) is the one thing citadelReachable()
 * actually checks for, and standalone users following the manual's tile
 * instructions may reasonably only bother downloading that one. Silently
 * requiring a second file that isn't there would mean a MapLibre source
 * error firing on load for something that was never promised to exist. */
async function citadelStyle(base: string): Promise<maplibregl.StyleSpecification> {
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
      source: "terrain",
      paint: { "hillshade-shadow-color": "#0a0e07", "hillshade-highlight-color": "#3a4a2a", "hillshade-exaggeration": 0.6 },
    });
  }

  return {
    version: 8,
    glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
    sources,
    layers: [...layers, ...baseLayers],
  };
}

async function probeReachable(url: string): Promise<boolean> {
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

const RADAR_SOURCE_ID = "rainviewer-radar";
const RADAR_LAYER_ID = "rainviewer-radar-layer";

/** RainViewer's public tile API -- free, no key, verified live before
 * building this (a plain fetch against api.rainviewer.com). Returns the
 * most recent radar frame's tile URL template, or null if RainViewer is
 * unreachable or the response shape ever changes -- this is a pure
 * enhancement layer, never something the rest of the map should break
 * over. */
async function fetchLatestRadarTileTemplate(): Promise<string | null> {
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

function TacticalMapPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const [mapError, setMapError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [tileSource, setTileSource] = useState<"citadel" | "online" | null>(null);

  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selectedIncident, setSelectedIncident] = useState<string>("all");

  const [radarOn, setRadarOn] = useState(false);
  const [radarError, setRadarError] = useState<string | null>(null);

  const [dropPinMode, setDropPinMode] = useState(false);
  const dropPinModeRef = useRef(false);
  const [pendingCoords, setPendingCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [pinLabel, setPinLabel] = useState("");
  const [pinType, setPinType] = useState<string>("info");
  const [pinTo, setPinTo] = useState("");
  const [pinBusy, setPinBusy] = useState(false);

  useEffect(() => {
    dropPinModeRef.current = dropPinMode;
  }, [dropPinMode]);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    async function init() {
      const profile = await invoke<{ grid_square: string | null; citadel_map_host: string | null }>("get_station_profile");
      const base = citadelBase(profile.citadel_map_host);
      const useLocal = await probeReachable(`${base}/tiles/comms_base.pmtiles`);
      if (cancelled || !containerRef.current) return;

      const style = useLocal ? await citadelStyle(base) : ONLINE_STYLE;
      if (cancelled || !containerRef.current) return;
      setTileSource(useLocal ? "citadel" : "online");

      const map = new maplibregl.Map({
        container: containerRef.current,
        style,
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
      });
      mapRef.current = map;

      map.on("load", () => setReady(true));
      // Only acts when "Drop Pin" mode is on -- an ordinary click just
      // pans/inspects the map otherwise. Reads a ref, not state, since
      // this listener is registered once at map creation.
      map.on("click", (e) => {
        if (!dropPinModeRef.current) return;
        setPendingCoords({ lat: e.lngLat.lat, lon: e.lngLat.lng });
      });
      // MapLibre fires this for any tile/style load failure. Distinct
      // messages because the fix is different: a broken local path means
      // check Citadel, a broken online path means check the internet.
      map.on("error", () => {
        setMapError(
          useLocal
            ? "Citadel's map tiles stopped responding after connecting — check the cockpit service is still up."
            : "Map tiles unavailable — Citadel's local tile server isn't reachable and this needs internet as a fallback.",
        );
      });

      const coords = profile.grid_square ? gridSquareToLatLon(profile.grid_square) : null;
      if (coords) {
        map.setCenter([coords.lon, coords.lat]);
        map.setZoom(9);
      }
    }

    init();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  async function refreshPins() {
    const map = mapRef.current;
    if (!map) return;

    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    const [nodes, roster, resources, pins, personnel, resourceRequests, aircraft] = await Promise.all([
      invoke<MeshNode[]>("get_mesh_nodes"),
      invoke<NetRosterEntry[]>("get_net_roster"),
      invoke<Resource[]>("get_resources"),
      invoke<MapMarker[]>("get_markers"),
      invoke<Person[]>("get_personnel"),
      invoke<ResourceRequest[]>("get_resource_requests"),
      invoke<AircraftTrack[]>("get_aircraft_tracks"),
    ]);

    const addPin = (lat: number, lon: number, color: string, label: string) => {
      const marker = new maplibregl.Marker({ color })
        .setLngLat([lon, lat])
        .setPopup(new maplibregl.Popup({ offset: 16 }).setText(label))
        .addTo(map);
      markersRef.current.push(marker);
    };

    // Mesh nodes, net check-ins, and the generic resources board aren't
    // incident objects -- they're standing infrastructure/presence with
    // no incident_id to filter on -- so they stay visible regardless of
    // which incident is selected.
    for (const n of nodes) {
      if (n.latitude !== null && n.longitude !== null) {
        addPin(n.latitude, n.longitude, "#ffb000", `Mesh node: ${n.long_name || n.short_name || `!${n.node_num.toString(16)}`}`);
      }
    }
    for (const r of roster) {
      if (r.latitude !== null && r.longitude !== null) {
        addPin(r.latitude, r.longitude, "#39d97a", `Check-in: ${r.callsign} (${r.status === "checked_in" ? "in" : "out"})`);
      }
    }
    for (const res of resources) {
      if (res.latitude !== null && res.longitude !== null) {
        addPin(res.latitude, res.longitude, "#5aa9e6", `Resource: ${res.label}`);
      }
    }
    // Aircraft aren't incident objects either -- OpenSky reports what's
    // actually in the air near this station regardless of which
    // incident is selected, same reasoning as mesh/roster/resources
    // above. The whole point (tracking flights toward a disaster area)
    // is spotting something relevant before anyone's declared an
    // incident around it yet, so hiding these behind an incident
    // filter would work against that.
    for (const a of aircraft) {
      if (a.latitude !== null && a.longitude !== null) {
        addPin(a.latitude, a.longitude, AIRCRAFT_COLOR, aircraftLabel(a));
      }
    }

    // Markers, personnel, and resource requests ARE incident objects --
    // this is the actual "tactical map driven by incident objects"
    // filtering. "All incidents" shows every one of them that has a
    // location, same as before this existed; picking a specific
    // incident narrows each of these three down to just what's tagged
    // to it.
    const matchesIncident = (incidentId: string | null) => selectedIncident === "all" || incidentId === selectedIncident;

    for (const p of pins) {
      if (!matchesIncident(p.incident_id)) continue;
      const color = MARKER_COLORS[p.marker_type] || MARKER_COLORS.info;
      const from = p.origin_station ? ` — ${p.origin_station}` : "";
      addPin(p.latitude, p.longitude, color, `${p.label}${from} (${markerStatusText(p)})`);
    }
    for (const person of personnel) {
      if (person.latitude === null || person.longitude === null) continue;
      if (!matchesIncident(person.incident_id)) continue;
      const who = person.callsign ? `${person.name} (${person.callsign})` : person.name;
      addPin(person.latitude, person.longitude, PERSONNEL_COLOR, `Personnel: ${who} — ${person.status}`);
    }
    for (const req of resourceRequests) {
      if (req.latitude === null || req.longitude === null) continue;
      if (!matchesIncident(req.incident_id)) continue;
      const detail = req.description ? ` — ${req.description}` : "";
      addPin(req.latitude, req.longitude, RESOURCE_REQUEST_COLOR, `Resource request: ${req.resource_type}${detail} (${req.status})`);
    }
  }

  useEffect(() => {
    if (!ready) return;
    refreshPins();
    const interval = setInterval(refreshPins, 15_000);
    const unlistens: Promise<() => void>[] = [listen("map-markers-changed", refreshPins), listen("aircraft-tracks-changed", refreshPins)];
    return () => {
      clearInterval(interval);
      unlistens.forEach((p) => p.then((fn) => fn()));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, selectedIncident]);

  useEffect(() => {
    invoke<Incident[]>("get_incidents").then(setIncidents);
  }, []);

  async function submitPin(e: React.FormEvent) {
    e.preventDefault();
    if (!pendingCoords || !pinLabel.trim()) return;
    setPinBusy(true);
    try {
      const marker = await invoke<MapMarker>("create_marker", {
        label: pinLabel.trim(),
        markerType: pinType,
        latitude: pendingCoords.lat,
        longitude: pendingCoords.lon,
        toStation: pinTo.trim() || null,
      });
      await invoke("dispatch_marker", { markerId: marker.id });
      setPinLabel("");
      setPinTo("");
      setPendingCoords(null);
      setDropPinMode(false);
      refreshPins();
    } finally {
      setPinBusy(false);
    }
  }

  function cancelPin() {
    setPendingCoords(null);
    setPinLabel("");
    setPinTo("");
  }

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    if (!radarOn) {
      if (map.getLayer(RADAR_LAYER_ID)) map.removeLayer(RADAR_LAYER_ID);
      if (map.getSource(RADAR_SOURCE_ID)) map.removeSource(RADAR_SOURCE_ID);
      setRadarError(null);
      return;
    }

    let cancelled = false;
    fetchLatestRadarTileTemplate().then((template) => {
      if (cancelled || !mapRef.current) return;
      if (!template) {
        setRadarError("Could not reach RainViewer for radar imagery — online only, no offline fallback.");
        setRadarOn(false);
        return;
      }
      if (!map.getSource(RADAR_SOURCE_ID)) {
        map.addSource(RADAR_SOURCE_ID, { type: "raster", tiles: [template], tileSize: 256 });
        map.addLayer({ id: RADAR_LAYER_ID, type: "raster", source: RADAR_SOURCE_ID, paint: { "raster-opacity": 0.6 } });
      }
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [radarOn, ready]);

  return (
    <div className="panel-tactical-map">
      {mapError && <div className="panel-alerts-empty tactical-map-error">{mapError}</div>}
      {radarError && <div className="panel-alerts-empty tactical-map-error">{radarError}</div>}

      <div className="tactical-map-toolbar">
        <button
          type="button"
          className={dropPinMode ? "tactical-map-pin-toggle active" : "tactical-map-pin-toggle"}
          onClick={() => {
            setDropPinMode((v) => !v);
            cancelPin();
          }}
        >
          {dropPinMode ? "Click the map to place a pin…" : "Drop Pin"}
        </button>
        <button
          type="button"
          className={radarOn ? "tactical-map-pin-toggle active" : "tactical-map-pin-toggle"}
          onClick={() => setRadarOn((v) => !v)}
          title="RainViewer live radar overlay -- online only, no offline fallback"
        >
          {radarOn ? "Hide Radar" : "Show Radar"}
        </button>
        <select
          className="tactical-map-incident-select"
          value={selectedIncident}
          onChange={(e) => setSelectedIncident(e.target.value)}
          title="Filter pins, personnel, and resource requests to one incident"
        >
          <option value="all">All incidents</option>
          {incidents.map((incident) => (
            <option key={incident.uuid} value={incident.uuid}>
              {incident.name}
              {incident.status === "closed" ? " (closed)" : ""}
            </option>
          ))}
        </select>
      </div>

      {pendingCoords && (
        <form className="marker-form" onSubmit={submitPin}>
          <input value={pinLabel} onChange={(e) => setPinLabel(e.currentTarget.value)} placeholder="What is this?" autoFocus />
          <select value={pinType} onChange={(e) => setPinType(e.currentTarget.value)}>
            {MARKER_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            value={pinTo}
            onChange={(e) => setPinTo(e.currentTarget.value)}
            placeholder="To callsign (blank = broadcast to everyone)"
          />
          <button type="submit" disabled={pinBusy || !pinLabel.trim()}>
            {pinBusy ? "Sending…" : "Send"}
          </button>
          <button type="button" onClick={cancelPin}>
            Cancel
          </button>
        </form>
      )}

      <div ref={containerRef} className="tactical-map-canvas" />
      <div className="tactical-map-legend">
        <span>
          <span className="tactical-map-swatch" style={{ background: "#ffb000" }} /> Mesh nodes
        </span>
        <span>
          <span className="tactical-map-swatch" style={{ background: "#39d97a" }} /> Net check-ins
        </span>
        <span>
          <span className="tactical-map-swatch" style={{ background: "#5aa9e6" }} /> Resources
        </span>
        {MARKER_TYPES.map((t) => (
          <span key={t}>
            <span className="tactical-map-swatch" style={{ background: MARKER_COLORS[t] }} /> Pin: {t}
          </span>
        ))}
        <span>
          <span className="tactical-map-swatch" style={{ background: PERSONNEL_COLOR }} /> Personnel
        </span>
        <span>
          <span className="tactical-map-swatch" style={{ background: RESOURCE_REQUEST_COLOR }} /> Resource requests
        </span>
        <span>
          <span className="tactical-map-swatch" style={{ background: AIRCRAFT_COLOR }} /> Aircraft (ADS-B)
        </span>
        {tileSource && (
          <span className="tactical-map-source">
            Tiles: {tileSource === "citadel" ? "Citadel (local)" : "OpenFreeMap (online)"}
          </span>
        )}
      </div>
    </div>
  );
}

export default TacticalMapPanel;
