import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import Freshness from "../staleness/Freshness";
import { gridSquareToLatLon } from "../lib/maidenhead";
import { ONLINE_STYLE, citadelBase, citadelStyle, probeReachable } from "../lib/citadelMapStyle";

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

/** Its own dedicated map, separate from the Tactical Map (which is
 * radio/EmComm coordination, not flight situational awareness) and
 * from Weather's radar map. Same citadel-tiles-first/OpenFreeMap-
 * fallback style resolution as the other two, just plotting a
 * different thing. */
function FlightMap({ tracks }: { tracks: AircraftTrack[] }) {
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
      markersRef.current.push(marker);
    }
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

function FlightTrackingPanel() {
  const [tracks, setTracks] = useState<AircraftTrack[] | null>(null);

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

  return (
    <div className="panel-alerts">
      <div className="bandplan-disclaimer">
        Source: OpenSky Network, live ADS-B within ~135mi of this station's grid square. Online only — no local
        SDR fallback yet, so this goes silent the same moment the internet does.
      </div>

      <FlightMap tracks={tracks} />

      {tracks.length === 0 ? (
        <div className="panel-alerts-empty">
          No aircraft currently reported nearby — either a quiet sky, or this station's grid square isn't set yet
          (Settings → Station Identity), which is required to know what "nearby" means.
        </div>
      ) : (
        tracks.map((t) => (
          <div key={t.id} className="alert-card">
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
        ))
      )}
    </div>
  );
}

export default FlightTrackingPanel;
