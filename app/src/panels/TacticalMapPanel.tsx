import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { gridSquareToLatLon } from "../lib/maidenhead";
import { ONLINE_STYLE, citadelBase, citadelStyle, probeReachable } from "../lib/citadelMapStyle";

// This is the radio/EmComm common operating picture only -- mesh nodes,
// net check-ins, resources, personnel, APRS, and operator-dropped
// hazard/shelter/resource/info pins. Aircraft tracks live on their own
// map on the Flight Tracking page, general-purpose measurement/elevation/
// export tools live on Citadel's map (this is about coordinating people
// and traffic, not surveying land), and radar lives only on the Weather
// page's own map -- all three used to be dumped in here together, which
// is exactly the confusion DESIGN.md's per-panel scoping is meant to
// avoid. Decided 2026-09-10 after that got flagged for real.

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

const MARKER_TYPES = ["hazard", "shelter", "resource", "info"] as const;

const MARKER_COLORS: Record<string, string> = {
  hazard: "#e64d4d",
  shelter: "#2fb8c4",
  resource: "#b06fe0",
  info: "#c9a227",
};

const PERSONNEL_COLOR = "#ff6ec7";
const RESOURCE_REQUEST_COLOR = "#7c5cff";
const APRS_COLOR = "#2fd4a0";

// Mirrors aprs::AprsStation -- real KISS/AX.25/APRS positions decoded
// from Direwolf's RF traffic (direwolf.rs/aprs.rs). Source-tagged
// separately from a possible future APRS-IS lookup, same convention as
// mesh/personnel/resource-request pins never silently merging.
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

      const style = useLocal ? (await citadelStyle(base)).style : ONLINE_STYLE;
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

    const [nodes, roster, resources, pins, personnel, resourceRequests, aprsStations] = await Promise.all([
      invoke<MeshNode[]>("get_mesh_nodes"),
      invoke<NetRosterEntry[]>("get_net_roster"),
      invoke<Resource[]>("get_resources"),
      invoke<MapMarker[]>("get_markers"),
      invoke<Person[]>("get_personnel"),
      invoke<ResourceRequest[]>("get_resource_requests"),
      invoke<AprsStation[]>("get_aprs_stations"),
    ]);

    // `onRemove` is only passed for actual map_markers rows (the pins an
    // operator drops) -- mesh nodes, roster check-ins, resources,
    // personnel, resource requests, and APRS stations are live telemetry
    // views with nothing to "delete," so their pins keep the plain
    // text-only popup.
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
    // Real RF-heard APRS stations -- same "standing presence, not an
    // incident object" reasoning as mesh above. Source-tagged with its
    // own color/label so it's never confused with a mesh node or a
    // future APRS-IS (internet-looked-up) station.
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
    const unlisten = listen("map-markers-changed", refreshPins);
    return () => {
      clearInterval(interval);
      unlisten.then((fn) => fn());
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

  return (
    <div className="panel-tactical-map">
      {mapError && <div className="panel-alerts-empty tactical-map-error">{mapError}</div>}

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

export default TacticalMapPanel;
