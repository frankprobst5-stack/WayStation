import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Freshness from "../staleness/Freshness";
import { drawLand, drawGraticule, drawPin, drawTrack } from "../lib/mapCanvas";

interface SatelliteTle {
  norad_id: number;
  name: string;
  fetched_at: string;
}

interface PassWindow {
  aos: string;
  los: string;
  max_elevation_deg: number;
}

interface SatelliteStatus {
  norad_id: number;
  name: string;
  tle_fetched_at: string;
  currently_visible: boolean;
  azimuth_deg: number;
  elevation_deg: number;
  range_rate_km_s: number;
  subpoint_lat_deg: number;
  subpoint_lon_deg: number;
  next_pass: PassWindow | null;
}

interface GroundTrackPoint {
  lat_deg: number;
  lon_deg: number;
  minutes_from_now: number;
}

const SPEED_OF_LIGHT_KM_S = 299_792.458;
// Live status is only cheap to refetch this often because pass search is
// bounded (see satellite.rs) — a few thousand propagate() calls, not a
// network round-trip, so a 5s client-side poll while a satellite is
// selected keeps az/el/Doppler moving during an actual pass without
// needing a push-based backend channel for something this simple.
const REFRESH_INTERVAL_MS = 5000;

function SatellitePanel() {
  const [tles, setTles] = useState<SatelliteTle[] | null>(null);
  const [hasGridSquare, setHasGridSquare] = useState<boolean | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [status, setStatus] = useState<SatelliteStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [freqMhz, setFreqMhz] = useState("146.000");
  const [groundTrack, setGroundTrack] = useState<GroundTrackPoint[] | null>(null);
  const trackCanvasRef = useRef<HTMLCanvasElement>(null);
  const trackContainerRef = useRef<HTMLDivElement>(null);

  async function refreshList() {
    const [tleList, profile] = await Promise.all([
      invoke<SatelliteTle[]>("get_satellite_tles"),
      invoke<{ grid_square: string | null }>("get_station_profile"),
    ]);
    setTles(tleList);
    setHasGridSquare(!!profile.grid_square);
    if (selectedId === null && tleList.length > 0) {
      setSelectedId(tleList[0].norad_id);
    }
  }

  useEffect(() => {
    refreshList();
    let unlisten: (() => void) | undefined;
    listen("satellites-changed", refreshList).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedId === null || !hasGridSquare) return;

    let cancelled = false;
    function fetchStatus(showLoading: boolean) {
      if (showLoading) setLoading(true);
      setError(null);
      invoke<SatelliteStatus>("get_satellite_status", { noradId: selectedId })
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        .catch((e) => {
          if (!cancelled) setError(String(e));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }

    fetchStatus(true);
    const interval = setInterval(() => fetchStatus(false), REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedId, hasGridSquare]);

  // The ground track (one full orbit, centered on "now") shifts slowly —
  // refetched every 5 minutes rather than on the same fast 5s cadence as
  // az/el/Doppler. The "you are here" marker on top of it still updates
  // every 5s, from status.subpoint_lat/lon_deg above.
  useEffect(() => {
    if (selectedId === null) return;
    let cancelled = false;
    function fetchTrack() {
      invoke<GroundTrackPoint[]>("get_satellite_ground_track", { noradId: selectedId }).then((t) => {
        if (!cancelled) setGroundTrack(t);
      });
    }
    fetchTrack();
    const interval = setInterval(fetchTrack, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedId]);

  useEffect(() => {
    const canvas = trackCanvasRef.current;
    const container = trackContainerRef.current;
    if (!canvas || !container || !groundTrack) return;

    const width = container.clientWidth;
    const height = Math.round(width / 2);
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#1a2a3a";
    ctx.fillRect(0, 0, width, height);
    drawLand(ctx, width, height);
    drawGraticule(ctx, width, height);
    drawTrack(
      ctx,
      width,
      height,
      groundTrack.map((p) => ({ lon: p.lon_deg, lat: p.lat_deg })),
      "#ffb000",
    );
    if (status) {
      drawPin(ctx, width, height, status.subpoint_lon_deg, status.subpoint_lat_deg, "#008dff");
    }
  }, [groundTrack, status]);

  if (tles === null || hasGridSquare === null) {
    return <div className="panel-alerts">Loading...</div>;
  }

  if (!hasGridSquare) {
    return (
      <div className="panel-alerts panel-alerts-empty">
        Set your station's grid square (Station panel) to compute satellite look angles.
      </div>
    );
  }

  if (tles.length === 0) {
    return <div className="panel-alerts panel-alerts-empty">No satellite data yet — waiting on the next poll.</div>;
  }

  return (
    <div className="panel-satellite">
      <div className="resource-form channel-form">
        <select value={selectedId ?? ""} onChange={(e) => setSelectedId(Number(e.currentTarget.value))}>
          {tles.map((t) => (
            <option key={t.norad_id} value={t.norad_id}>
              {t.name}
            </option>
          ))}
        </select>
        <input
          value={freqMhz}
          onChange={(e) => setFreqMhz(e.currentTarget.value)}
          placeholder="Downlink freq (MHz), for Doppler"
        />
      </div>

      {loading && <div className="panel-alerts-empty">Computing...</div>}
      {error && <div className="panel-alerts-empty">{error}</div>}

      {status && !loading && !error && (
        <div className="alert-card">
          <div className="alert-header">
            <span>{status.name}</span>
            <span className="resource-chip">{status.currently_visible ? "ABOVE HORIZON" : "below horizon"}</span>
          </div>
          <div className="alert-area">
            Az {status.azimuth_deg.toFixed(0)}° · El {status.elevation_deg.toFixed(0)}°
          </div>
          {Number(freqMhz) > 0 &&
            (() => {
              const freqHz = Number(freqMhz) * 1e6;
              const shiftHz = (-freqHz * status.range_rate_km_s) / SPEED_OF_LIGHT_KM_S;
              const shiftedMhz = (freqHz + shiftHz) / 1e6;
              return (
                <div className="alert-area">
                  Doppler: {shiftHz >= 0 ? "+" : ""}
                  {shiftHz.toFixed(0)} Hz · dial {shiftedMhz.toFixed(5)} MHz
                </div>
              );
            })()}
          {status.next_pass ? (
            <div className="alert-area">
              {status.currently_visible ? "Current pass sets" : "Next pass"}: AOS{" "}
              {new Date(status.next_pass.aos).toLocaleTimeString()}, LOS{" "}
              {new Date(status.next_pass.los).toLocaleTimeString()}, max el{" "}
              {status.next_pass.max_elevation_deg.toFixed(0)}°
            </div>
          ) : (
            <div className="alert-area">No pass found in the next 48 hours.</div>
          )}
          <div ref={trackContainerRef} className="satellite-ground-track">
            <canvas ref={trackCanvasRef} />
          </div>
          <div className="alert-footer">
            <span>TLE source: CelesTrak</span>
            <Freshness fetchedAt={status.tle_fetched_at} agingAfterSeconds={8 * 3600} staleAfterSeconds={24 * 3600} />
          </div>
        </div>
      )}
    </div>
  );
}

export default SatellitePanel;
