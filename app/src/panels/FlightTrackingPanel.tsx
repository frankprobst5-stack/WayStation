import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Freshness from "../staleness/Freshness";
import { gridSquareToLatLon } from "../lib/maidenhead";
import { ONLINE_STYLE, citadelBase, citadelStyle, probeReachable } from "../lib/citadelMapStyle";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

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

const DEFAULT_CENTER: [number, number] = [-98.5, 39.8]; // CONUS center, until the station's own grid re-centers it
const DEFAULT_ZOOM = 5;
const AIRCRAFT_COLOR = "#ffffff";
const ON_GROUND_COLOR = "#8a8d80";

const TABS = ["Overview", "Aircraft List", "Filters", "Statistics", "Alerts"] as const;
type Tab = (typeof TABS)[number];

function metersToFeet(m: number): number {
  return Math.round(m * 3.28084);
}

function msToKnots(ms: number): number {
  return Math.round(ms * 1.94384);
}

function lastContactLabel(unixSeconds: number): string {
  const ms = Date.now() - unixSeconds * 1000;
  if (ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

function aircraftLabel(a: AircraftTrack): string {
  const id = a.callsign ?? a.icao24;
  if (a.on_ground) return `${id} — on ground`;
  const altitude = a.altitude_m !== null ? `${metersToFeet(a.altitude_m).toLocaleString()} ft` : "altitude unknown";
  const speed = a.velocity_ms !== null ? `${msToKnots(a.velocity_ms)} kt` : null;
  return `${id} — ${altitude}${speed ? `, ${speed}` : ""}`;
}

interface Filters {
  query: string;
  minAltFt: string;
  maxAltFt: string;
  hideOnGround: boolean;
}

const DEFAULT_FILTERS: Filters = { query: "", minAltFt: "", maxAltFt: "", hideOnGround: false };

function applyFilters(tracks: AircraftTrack[], f: Filters): AircraftTrack[] {
  const q = f.query.trim().toLowerCase();
  const min = f.minAltFt.trim() === "" ? null : parseFloat(f.minAltFt);
  const max = f.maxAltFt.trim() === "" ? null : parseFloat(f.maxAltFt);
  return tracks.filter((t) => {
    if (f.hideOnGround && t.on_ground) return false;
    if (q) {
      const hay = `${t.callsign ?? ""} ${t.icao24} ${t.origin_country ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (min !== null || max !== null) {
      if (t.altitude_m === null) return false;
      const ft = metersToFeet(t.altitude_m);
      if (min !== null && ft < min) return false;
      if (max !== null && ft > max) return false;
    }
    return true;
  });
}

/** Its own dedicated map, separate from the Tactical Map (which is
 * radio/EmComm coordination, not flight situational awareness) and
 * from Weather's radar map. Same citadel-tiles-first/OpenFreeMap-
 * fallback style resolution as the other two, just plotting a
 * different thing. */
function FlightMap({ tracks, onSelect }: { tracks: AircraftTrack[]; onSelect: (t: AircraftTrack) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const [ready, setReady] = useState(false);
  const [tileSource, setTileSource] = useState<"citadel" | "online" | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);

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

      const map = new maplibregl.Map({ container: containerRef.current, style, center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM });
      mapRef.current = map;
      map.on("load", () => setReady(true));
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
        map.setZoom(7);
      }
    }

    init();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    for (const t of tracks) {
      if (t.latitude === null || t.longitude === null) continue;
      const marker = new maplibregl.Marker({ color: t.on_ground ? ON_GROUND_COLOR : AIRCRAFT_COLOR })
        .setLngLat([t.longitude, t.latitude])
        .setPopup(new maplibregl.Popup({ offset: 16 }).setText(aircraftLabel(t)))
        .addTo(map);
      marker.getElement().addEventListener("click", () => onSelect(t));
      markersRef.current.push(marker);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, ready]);

  return (
    <div>
      {mapError && <div className="panel-alerts-empty tactical-map-error">{mapError}</div>}
      <div ref={containerRef} className="tactical-map-canvas weather-radar-canvas" />
      <div className="tactical-map-legend">
        <span>
          <span className="tactical-map-swatch" style={{ background: AIRCRAFT_COLOR }} /> In flight
        </span>
        <span>
          <span className="tactical-map-swatch" style={{ background: ON_GROUND_COLOR }} /> On ground
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

function SelectedAircraftCard({ track }: { track: AircraftTrack | null }) {
  if (!track) {
    return (
      <div className="sync-section">
        <div className="sync-section-head"><h3>Selected Aircraft</h3></div>
        <div className="panel-alerts-empty">Click a plane on the map or in the Aircraft List to see its detail here.</div>
      </div>
    );
  }
  return (
    <div className="sync-section">
      <div className="sync-section-head">
        <h3>{track.callsign ?? track.icao24}</h3>
        {track.squawk && <span className="resource-chip">Squawk {track.squawk}</span>}
      </div>
      <table>
        <tbody>
          <tr><td>Altitude</td><td>{track.altitude_m !== null ? `${metersToFeet(track.altitude_m).toLocaleString()} ft` : "unknown"}</td></tr>
          <tr><td>Ground Speed</td><td>{track.velocity_ms !== null ? `${msToKnots(track.velocity_ms)} kt` : "unknown"}</td></tr>
          <tr><td>Heading</td><td>{track.true_track !== null ? `${Math.round(track.true_track)}°` : "unknown"}</td></tr>
          <tr><td>Vertical Speed</td><td>{track.vertical_rate_ms !== null ? `${Math.round(track.vertical_rate_ms * 196.85)} ft/min` : "unknown"}</td></tr>
          <tr><td>Latitude</td><td>{track.latitude?.toFixed(4) ?? "—"}</td></tr>
          <tr><td>Longitude</td><td>{track.longitude?.toFixed(4) ?? "—"}</td></tr>
          <tr><td>Origin Country</td><td>{track.origin_country ?? "—"}</td></tr>
          <tr><td>Status</td><td>{track.on_ground ? "On ground" : "En route"}</td></tr>
          <tr><td>Last Seen</td><td>{lastContactLabel(track.last_contact)}</td></tr>
        </tbody>
      </table>
      <div className="field-hint">
        ICAO24 {track.icao24} — OpenSky doesn't provide an aircraft photo, type, or route (from/to airport) via
        this feed, so those aren't shown rather than guessed.
      </div>
    </div>
  );
}

function AircraftListTab({ tracks, onSelect }: { tracks: AircraftTrack[]; onSelect: (t: AircraftTrack) => void }) {
  if (tracks.length === 0) {
    return <div className="panel-alerts-empty">No aircraft match the current filters.</div>;
  }
  return (
    <div className="panel-alerts">
      {tracks.map((t) => (
        <div key={t.id} className="alert-card" onClick={() => onSelect(t)} style={{ cursor: "pointer" }}>
          <div className="alert-header">
            <span>{t.callsign ?? t.icao24}</span>
            {t.on_ground && <span className="resource-chip">On ground</span>}
            {t.squawk && <span className="resource-chip">Squawk {t.squawk}</span>}
          </div>
          <div className="alert-area">
            {t.altitude_m !== null ? `${metersToFeet(t.altitude_m).toLocaleString()} ft` : "altitude unknown"}
            {t.velocity_ms !== null && ` · ${msToKnots(t.velocity_ms)} kt`}
            {t.true_track !== null && ` · heading ${Math.round(t.true_track)}°`}
          </div>
          <div className="alert-area">
            {t.origin_country ?? "—"}
            {t.latitude !== null && t.longitude !== null && ` · ${t.latitude.toFixed(2)}, ${t.longitude.toFixed(2)}`}
          </div>
          <div className="alert-footer">
            <span>{lastContactLabel(t.last_contact)}</span>
            <Freshness fetchedAt={t.fetched_at} agingAfterSeconds={5 * 60} staleAfterSeconds={15 * 60} />
          </div>
        </div>
      ))}
    </div>
  );
}

function FiltersTab({ filters, setFilters, matchCount, totalCount }: { filters: Filters; setFilters: (f: Filters) => void; matchCount: number; totalCount: number }) {
  return (
    <div className="sync-section">
      <div className="sync-section-head"><h3>Filters</h3></div>
      <p className="field-hint">
        Applied to both the map and the Aircraft List. {matchCount} of {totalCount} tracked aircraft match right now.
      </p>
      <div className="field-row" style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
        <input
          value={filters.query}
          onChange={(e) => setFilters({ ...filters, query: e.currentTarget.value })}
          placeholder="Callsign, ICAO24, or country contains..."
          style={{ flex: 2, minWidth: "220px" }}
        />
        <input
          value={filters.minAltFt}
          onChange={(e) => setFilters({ ...filters, minAltFt: e.currentTarget.value })}
          placeholder="Min altitude (ft)"
          inputMode="numeric"
          style={{ flex: 1, minWidth: "140px" }}
        />
        <input
          value={filters.maxAltFt}
          onChange={(e) => setFilters({ ...filters, maxAltFt: e.currentTarget.value })}
          placeholder="Max altitude (ft)"
          inputMode="numeric"
          style={{ flex: 1, minWidth: "140px" }}
        />
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <input type="checkbox" checked={filters.hideOnGround} onChange={(e) => setFilters({ ...filters, hideOnGround: e.currentTarget.checked })} />
        Hide aircraft on the ground
      </label>
      <button type="button" className="action-btn" style={{ marginTop: "0.8rem" }} onClick={() => setFilters(DEFAULT_FILTERS)}>
        Reset Filters
      </button>
      <div className="bandplan-disclaimer" style={{ marginTop: "0.8rem" }}>
        Military/Unknown-category filtering from the mockup isn't here — OpenSky's feed as stored doesn't include
        an aircraft category field to filter on, so it's not something this can honestly offer yet.
      </div>
    </div>
  );
}

function StatisticsTab({ tracks }: { tracks: AircraftTrack[] }) {
  const stats = useMemo(() => {
    const inFlight = tracks.filter((t) => !t.on_ground);
    const onGround = tracks.filter((t) => t.on_ground);
    const altitudes = inFlight.filter((t) => t.altitude_m !== null).map((t) => metersToFeet(t.altitude_m!));
    const countries = new Set(tracks.map((t) => t.origin_country).filter((c): c is string => !!c));
    return {
      total: tracks.length,
      inFlight: inFlight.length,
      onGround: onGround.length,
      maxAlt: altitudes.length ? Math.max(...altitudes) : null,
      avgAlt: altitudes.length ? Math.round(altitudes.reduce((a, b) => a + b, 0) / altitudes.length) : null,
      countries: countries.size,
    };
  }, [tracks]);

  return (
    <div className="quick-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "0.8rem" }}>
      <div className="sw-tile"><span className="sw-label">Total Tracked</span><span className="sw-value">{stats.total}</span></div>
      <div className="sw-tile"><span className="sw-label">In Flight</span><span className="sw-value">{stats.inFlight}</span></div>
      <div className="sw-tile"><span className="sw-label">On Ground</span><span className="sw-value">{stats.onGround}</span></div>
      <div className="sw-tile"><span className="sw-label">Origin Countries</span><span className="sw-value">{stats.countries}</span></div>
      <div className="sw-tile"><span className="sw-label">Avg Altitude</span><span className="sw-value">{stats.avgAlt !== null ? `${stats.avgAlt.toLocaleString()} ft` : "—"}</span></div>
      <div className="sw-tile"><span className="sw-label">Max Altitude</span><span className="sw-value">{stats.maxAlt !== null ? `${stats.maxAlt.toLocaleString()} ft` : "—"}</span></div>
    </div>
  );
}

function FlightTrackingPanel() {
  const [tracks, setTracks] = useState<AircraftTrack[] | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<AircraftTrack | null>(null);

  async function refresh() {
    setTracks(await invoke<AircraftTrack[]>("get_aircraft_tracks"));
  }

  useEffect(() => {
    refresh();
    let unlisten: (() => void) | undefined;
    listen("aircraft-tracks-changed", refresh).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  if (tracks === null) {
    return <div className="panel-alerts">Loading...</div>;
  }

  const filtered = applyFilters(tracks, filters);

  return (
    <div className="panel-weather">
      <div className="bandplan-disclaimer">
        Source: OpenSky Network, live ADS-B within ~135mi of this station's grid square. Online only — no local
        SDR fallback yet, so this goes silent the same moment the internet does.
      </div>

      <div className="panel-tabs">
        {TABS.map((t) => (
          <button key={t} type="button" className={t === tab ? "panel-tab-btn active" : "panel-tab-btn"} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      <div className="panel-tab-content">
        {tab === "Overview" && (
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "1rem" }}>
            <FlightMap tracks={filtered} onSelect={setSelected} />
            <SelectedAircraftCard track={selected} />
          </div>
        )}
        {tab === "Aircraft List" && <AircraftListTab tracks={filtered} onSelect={setSelected} />}
        {tab === "Filters" && <FiltersTab filters={filters} setFilters={setFilters} matchCount={filtered.length} totalCount={tracks.length} />}
        {tab === "Statistics" && <StatisticsTab tracks={tracks} />}
        {tab === "Alerts" && (
          <div className="bandplan-disclaimer">
            Not built yet — aircraft entering a radius, altitude thresholds, recurring sightings, or disappearing
            from tracking would need a real backend (a rules table plus a check against every incoming update),
            not just a UI. Flagged here rather than faked.
          </div>
        )}
      </div>
    </div>
  );
}

export default FlightTrackingPanel;
