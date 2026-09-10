import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { gridSquareToLatLon } from "../lib/maidenhead";
import {
  type LatLon,
  formatArea,
  formatDistance,
  pathLengthMeters,
  polygonAreaSquareMeters,
  sampleAlongPath,
} from "../lib/geoMeasure";
import { downloadTextFile, markersToGpx, markersToKml } from "../lib/markerExport";
import { ONLINE_STYLE, citadelBase, citadelStyle, probeReachable } from "../lib/citadelMapStyle";
import { RADAR_LAYER_ID, RADAR_SOURCE_ID, fetchLatestRadarTileTemplate } from "../lib/radar";

const DEFAULT_CENTER: [number, number] = [-98.5, 39.8]; // CONUS center, until the station's own grid re-centers it
const DEFAULT_ZOOM = 4;

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
const APRS_COLOR = "#2fd4a0";

// Mirrors aprs::AprsStation -- real KISS/AX.25/APRS positions decoded
// from Direwolf's RF traffic (direwolf.rs/aprs.rs). Source-tagged
// separately from a possible future APRS-IS lookup, same convention as
// mesh/aircraft/personnel/resource-request pins never silently merging.
interface AprsStation {
  callsign: string;
  lat: number;
  lon: number;
  symbol_table: string;
  symbol_code: string;
  comment: string;
  path: string;
  heard_at: string;
}

function aprsLabel(s: AprsStation): string {
  const via = s.path ? ` via ${s.path}` : " direct";
  const comment = s.comment.trim() ? ` — ${s.comment.trim()}` : "";
  return `APRS (RF): ${s.callsign}${via}${comment}`;
}

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

  const [activeTool, setActiveTool] = useState<"none" | "pin" | "measure" | "profile">("none");
  const activeToolRef = useRef(activeTool);
  const [pendingCoords, setPendingCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [pinLabel, setPinLabel] = useState("");
  const [pinType, setPinType] = useState<string>("info");
  const [pinTo, setPinTo] = useState("");
  const [pinBusy, setPinBusy] = useState(false);

  useEffect(() => {
    activeToolRef.current = activeTool;
  }, [activeTool]);

  // Distance/area measurement -- click points to build a path, live
  // distance always shown, area added once there are enough points to
  // enclose one. Pure equirectangular-plane math (see geoMeasure.ts),
  // no terrain data involved.
  const [measurePoints, setMeasurePoints] = useState<LatLon[]>([]);

  // Elevation profile -- click points to define a route, then sample
  // the loaded DEM along it. Needs a real terrain source (Citadel's
  // tactical_terrain.pmtiles); OpenFreeMap's online fallback carries no
  // local elevation data to query.
  const [hasTerrainSource, setHasTerrainSource] = useState(false);
  const [profilePoints, setProfilePoints] = useState<LatLon[]>([]);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileResult, setProfileResult] = useState<{ distanceM: number; elevationM: number | null }[] | null>(null);

  // Latest fetched map_markers pins, kept for GPX/KML export -- refreshPins
  // fetches these itself and doesn't otherwise hold onto them. pinCount is
  // real state (not just the ref) so the export buttons' disabled state
  // actually re-renders when it changes, instead of reading a ref mutation
  // React never notices.
  const pinsRef = useRef<MapMarker[]>([]);
  const [pinCount, setPinCount] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    async function init() {
      const profile = await invoke<{ grid_square: string | null; citadel_map_host: string | null }>("get_station_profile");
      const base = citadelBase(profile.citadel_map_host);
      const useLocal = await probeReachable(`${base}/tiles/comms_base.pmtiles`);
      if (cancelled || !containerRef.current) return;

      let style: maplibregl.StyleSpecification | string;
      if (useLocal) {
        const citadel = await citadelStyle(base);
        style = citadel.style;
        setHasTerrainSource(citadel.hasTerrain);
      } else {
        style = ONLINE_STYLE;
        setHasTerrainSource(false); // OpenFreeMap's style carries no local DEM to query
      }
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
      // Reads refs, not state, since this listener is registered once at
      // map creation -- only one tool is ever "active" at a time.
      map.on("click", (e) => {
        const point = { lat: e.lngLat.lat, lon: e.lngLat.lng };
        switch (activeToolRef.current) {
          case "pin":
            setPendingCoords(point);
            break;
          case "measure":
            setMeasurePoints((pts) => [...pts, point]);
            break;
          case "profile":
            setProfilePoints((pts) => [...pts, point]);
            break;
        }
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

    const [nodes, roster, resources, pins, personnel, resourceRequests, aircraft, aprsStations] = await Promise.all([
      invoke<MeshNode[]>("get_mesh_nodes"),
      invoke<NetRosterEntry[]>("get_net_roster"),
      invoke<Resource[]>("get_resources"),
      invoke<MapMarker[]>("get_markers"),
      invoke<Person[]>("get_personnel"),
      invoke<ResourceRequest[]>("get_resource_requests"),
      invoke<AircraftTrack[]>("get_aircraft_tracks"),
      invoke<AprsStation[]>("get_aprs_stations"),
    ]);
    pinsRef.current = pins;
    setPinCount(pins.length);

    // `onRemove` is only passed for actual map_markers rows (the pins an
    // operator drops) -- mesh nodes, roster check-ins, resources,
    // personnel, resource requests, aircraft, and APRS stations are live
    // telemetry views with nothing to "delete," so their pins keep the
    // plain text-only popup.
    const addPin = (lat: number, lon: number, color: string, label: string, onRemove?: () => void) => {
      let popup: maplibregl.Popup;
      if (onRemove) {
        const content = document.createElement("div");
        const text = document.createElement("div");
        text.textContent = label;
        content.appendChild(text);
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "tactical-map-popup-remove";
        removeBtn.textContent = "Remove pin";
        removeBtn.onclick = onRemove;
        content.appendChild(removeBtn);
        popup = new maplibregl.Popup({ offset: 16 }).setDOMContent(content);
      } else {
        popup = new maplibregl.Popup({ offset: 16 }).setText(label);
      }
      const marker = new maplibregl.Marker({ color }).setLngLat([lon, lat]).setPopup(popup).addTo(map);
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
    // Real RF-heard APRS stations -- same "standing presence, not an
    // incident object" reasoning as mesh/aircraft above. Source-tagged
    // with its own color/label so it's never confused with a mesh node
    // or a future APRS-IS (internet-looked-up) station.
    for (const s of aprsStations) {
      addPin(s.lat, s.lon, APRS_COLOR, aprsLabel(s));
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
      addPin(p.latitude, p.longitude, color, `${p.label}${from} (${markerStatusText(p)})`, async () => {
        await invoke("delete_marker", { id: p.id });
        refreshPins();
      });
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
      setActiveTool("none");
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

  function switchTool(tool: "none" | "pin" | "measure" | "profile") {
    // Only one tool is ever active -- switching clears the others'
    // in-progress state so a half-drawn measurement doesn't linger
    // silently once you've moved on to something else.
    setActiveTool((current) => (current === tool ? "none" : tool));
    cancelPin();
    setMeasurePoints([]);
    setProfilePoints([]);
    setProfileResult(null);
    setProfileError(null);
  }

  const MEASURE_SOURCE_ID = "tactical-measure-line";
  const MEASURE_LAYER_ID = "tactical-measure-line-layer";
  const PROFILE_SOURCE_ID = "tactical-profile-line";
  const PROFILE_LAYER_ID = "tactical-profile-line-layer";

  function pointsToLineGeoJson(points: LatLon[]): GeoJSON.Feature<GeoJSON.LineString> {
    return {
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: points.map((p) => [p.lon, p.lat]) },
    };
  }

  // Draws whichever tool's in-progress path is active as a simple line
  // overlay. Both tools share this rather than each managing their own
  // source/layer -- only one is ever populated at a time (switchTool
  // clears the other), so there's nothing to actually keep separate.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const ensureLine = (sourceId: string, layerId: string, color: string, points: LatLon[]) => {
      const data = pointsToLineGeoJson(points);
      const source = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
      if (source) {
        source.setData(data);
      } else if (points.length > 0) {
        map.addSource(sourceId, { type: "geojson", data });
        map.addLayer({
          id: layerId,
          type: "line",
          source: sourceId,
          paint: { "line-color": color, "line-width": 2, "line-dasharray": [2, 1] },
        });
      }
    };

    ensureLine(MEASURE_SOURCE_ID, MEASURE_LAYER_ID, "#c9a227", activeTool === "measure" ? measurePoints : []);
    ensureLine(PROFILE_SOURCE_ID, PROFILE_LAYER_ID, "#2fb8c4", activeTool === "profile" ? profilePoints : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, activeTool, measurePoints, profilePoints]);

  const measureDistanceM = pathLengthMeters(measurePoints);
  const measureAreaM2 = measurePoints.length >= 3 ? polygonAreaSquareMeters(measurePoints) : 0;

  /** Briefly enables MapLibre's terrain mode purely to borrow its tested
   * tile-fetch/decode pipeline for `queryTerrainElevation` -- never left
   * on, and pitch is never touched, so the map never visibly becomes a
   * 3D view; it's toggled back off immediately after sampling. */
  async function computeElevationProfile() {
    const map = mapRef.current;
    if (!map || profilePoints.length < 2) return;
    if (!hasTerrainSource) {
      setProfileError("No local terrain data loaded for this session -- elevation profiling needs Citadel's tactical_terrain.pmtiles.");
      return;
    }
    setProfileBusy(true);
    setProfileError(null);
    setProfileResult(null);
    try {
      map.setTerrain({ source: "terrain", exaggeration: 1 });
      await new Promise<void>((resolve) => {
        map.once("idle", () => resolve());
        setTimeout(resolve, 4000); // don't hang forever if tiles never settle
      });

      const samples = sampleAlongPath(profilePoints, 40);
      const result = samples.map((s) => ({
        distanceM: s.distanceM,
        elevationM: map.queryTerrainElevation([s.lon, s.lat]),
      }));
      if (result.every((r) => r.elevationM === null)) {
        setProfileError("No elevation data returned for this route -- it may be outside the loaded terrain tiles' coverage or zoom level.");
      } else {
        setProfileResult(result);
      }
    } finally {
      map.setTerrain(null);
      setProfileBusy(false);
    }
  }

  function exportMarkers(format: "gpx" | "kml") {
    const markers = pinsRef.current;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (format === "gpx") {
      downloadTextFile(`waystation-markers-${stamp}.gpx`, markersToGpx(markers), "application/gpx+xml");
    } else {
      downloadTextFile(`waystation-markers-${stamp}.kml`, markersToKml(markers), "application/vnd.google-earth.kml+xml");
    }
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
          className={activeTool === "pin" ? "tactical-map-pin-toggle active" : "tactical-map-pin-toggle"}
          onClick={() => switchTool("pin")}
        >
          {activeTool === "pin" ? "Click the map to place a pin…" : "Drop Pin"}
        </button>
        <button
          type="button"
          className={activeTool === "measure" ? "tactical-map-pin-toggle active" : "tactical-map-pin-toggle"}
          onClick={() => switchTool("measure")}
          title="Click points to measure distance and enclosed area"
        >
          {activeTool === "measure" ? "Click to add points…" : "Measure"}
        </button>
        <button
          type="button"
          className={activeTool === "profile" ? "tactical-map-pin-toggle active" : "tactical-map-pin-toggle"}
          onClick={() => switchTool("profile")}
          disabled={!hasTerrainSource}
          title={hasTerrainSource ? "Click points to define a route, then sample its elevation" : "Needs Citadel's local terrain data -- not loaded this session"}
        >
          {activeTool === "profile" ? "Click to add route points…" : "Elevation Profile"}
        </button>
        <button
          type="button"
          className={radarOn ? "tactical-map-pin-toggle active" : "tactical-map-pin-toggle"}
          onClick={() => setRadarOn((v) => !v)}
          title="RainViewer live radar overlay -- online only, no offline fallback"
        >
          {radarOn ? "Hide Radar" : "Show Radar"}
        </button>
        <button
          type="button"
          className="tactical-map-pin-toggle"
          onClick={() => exportMarkers("gpx")}
          disabled={pinCount === 0}
          title="Export dropped pins as a GPX file"
        >
          Export GPX
        </button>
        <button
          type="button"
          className="tactical-map-pin-toggle"
          onClick={() => exportMarkers("kml")}
          disabled={pinCount === 0}
          title="Export dropped pins as a KML file"
        >
          Export KML
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

      {activeTool === "measure" && (
        <div className="tactical-map-tool-panel">
          <span>
            {measurePoints.length < 2
              ? "Click at least two points to measure distance."
              : `Distance: ${formatDistance(measureDistanceM)}`}
            {measurePoints.length >= 3 && ` · Area: ${formatArea(measureAreaM2)}`}
          </span>
          <button type="button" onClick={() => setMeasurePoints((pts) => pts.slice(0, -1))} disabled={measurePoints.length === 0}>
            Undo Point
          </button>
          <button type="button" onClick={() => setMeasurePoints([])} disabled={measurePoints.length === 0}>
            Clear
          </button>
        </div>
      )}

      {activeTool === "profile" && (
        <div className="tactical-map-tool-panel tactical-map-tool-panel-column">
          <div className="tactical-map-tool-panel">
            <span>
              {profilePoints.length < 2
                ? "Click at least two points to define a route."
                : `${profilePoints.length} route points — ${formatDistance(pathLengthMeters(profilePoints))} total`}
            </span>
            <button type="button" onClick={() => setProfilePoints((pts) => pts.slice(0, -1))} disabled={profilePoints.length === 0}>
              Undo Point
            </button>
            <button
              type="button"
              onClick={() => {
                setProfilePoints([]);
                setProfileResult(null);
                setProfileError(null);
              }}
              disabled={profilePoints.length === 0}
            >
              Clear
            </button>
            <button type="button" onClick={computeElevationProfile} disabled={profilePoints.length < 2 || profileBusy}>
              {profileBusy ? "Sampling…" : "Compute Profile"}
            </button>
          </div>
          {profileError && <div className="panel-alerts-empty tactical-map-error">{profileError}</div>}
          {profileResult && <ElevationChart samples={profileResult} />}
          {profileResult && (
            <div className="tactical-map-profile-caution">
              Sampled from the loaded DEM tiles only — doesn't account for trees, buildings, or Earth's curvature at
              range. Treat as a rough guide, not a surveyed reading; worth spot-checking against a known elevation
              before trusting it for a real route decision.
            </div>
          )}
        </div>
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
        <span>
          <span className="tactical-map-swatch" style={{ background: APRS_COLOR }} /> APRS (RF)
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

/** Small hand-drawn SVG line chart -- no charting library in this
 * project, and one polyline doesn't need one. Points with no elevation
 * data (queryTerrainElevation returned null for that sample, usually
 * meaning the tile wasn't loaded at that spot) are skipped when drawing
 * the line but still counted in the gap, rather than silently treated
 * as sea level. */
function ElevationChart({ samples }: { samples: { distanceM: number; elevationM: number | null }[] }) {
  const width = 560;
  const height = 140;
  const padding = 28;

  const known = samples.filter((s) => s.elevationM !== null) as { distanceM: number; elevationM: number }[];
  if (known.length < 2) {
    return <div className="tactical-map-error">Not enough elevation data returned to draw a profile.</div>;
  }

  const minElev = Math.min(...known.map((s) => s.elevationM));
  const maxElev = Math.max(...known.map((s) => s.elevationM));
  const maxDist = samples[samples.length - 1].distanceM;
  const elevRange = Math.max(1, maxElev - minElev);

  const toX = (d: number) => padding + (d / maxDist) * (width - 2 * padding);
  const toY = (e: number) => height - padding - ((e - minElev) / elevRange) * (height - 2 * padding);

  let gainM = 0;
  for (let i = 1; i < known.length; i++) {
    const delta = known[i].elevationM - known[i - 1].elevationM;
    if (delta > 0) gainM += delta;
  }

  const pathD = known.map((s, i) => `${i === 0 ? "M" : "L"} ${toX(s.distanceM).toFixed(1)} ${toY(s.elevationM).toFixed(1)}`).join(" ");

  return (
    <div>
      <svg width={width} height={height} className="tactical-map-elevation-chart" role="img" aria-label="Elevation profile">
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="currentColor" opacity={0.3} />
        <path d={pathD} fill="none" stroke="#2fb8c4" strokeWidth={2} />
      </svg>
      <div className="tactical-map-profile-stats">
        <span>Min: {Math.round(minElev * 3.28084)} ft</span>
        <span>Max: {Math.round(maxElev * 3.28084)} ft</span>
        <span>Gain: {Math.round(gainM * 3.28084)} ft</span>
        {known.length < samples.length && <span>{samples.length - known.length} sample(s) had no data</span>}
      </div>
    </div>
  );
}

export default TacticalMapPanel;
