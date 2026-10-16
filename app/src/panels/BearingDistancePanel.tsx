import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { gridSquareToLatLon } from "../lib/maidenhead";
import { distanceKm, initialBearing, compassPoint } from "../lib/greatCircle";

interface Result {
  distanceKm: number;
  distanceMi: number;
  bearing: number;
  compass: string;
}

function BearingDistancePanel() {
  const [stationGrid, setStationGrid] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    // Real bug found live 2026-10-09 (same file-wide sweep): no .catch()
    // meant a failed invoke left `stationGrid` null forever, and
    // `stationGrid === null` below is this panel's own gate -- which
    // would have shown a misleading "set your grid square" message even
    // if it genuinely is set and the fetch just failed, hence the
    // dedicated fetchError instead.
    invoke<{ grid_square: string | null }>("get_station_profile")
      .then((p) => {
        setStationGrid(p.grid_square);
      })
      .catch((err) => {
        console.error("get_station_profile failed:", err);
        setFetchError(String(err));
      });
  }, []);

  function calculate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);

    if (!stationGrid) return;
    const origin = gridSquareToLatLon(stationGrid);
    const dest = gridSquareToLatLon(target);
    if (!origin) {
      setError("Your own station grid square isn't valid — check the Station panel.");
      return;
    }
    if (!dest) {
      setError("Not a valid Maidenhead grid square.");
      return;
    }

    const km = distanceKm(origin.lat, origin.lon, dest.lat, dest.lon);
    const bearing = initialBearing(origin.lat, origin.lon, dest.lat, dest.lon);
    setResult({
      distanceKm: km,
      distanceMi: km * 0.621371,
      bearing,
      compass: compassPoint(bearing),
    });
  }

  if (fetchError) {
    return <div className="panel-bearing panel-alerts-empty">Could not load your station profile: {fetchError}</div>;
  }

  if (stationGrid === null) {
    return (
      <div className="panel-bearing panel-alerts-empty">
        Set your station's grid square (Station panel) to use the bearing/distance calculator.
      </div>
    );
  }

  return (
    <div className="panel-bearing">
      <form onSubmit={calculate} className="bearing-form">
        <span className="bearing-from">From {stationGrid}</span>
        <input
          value={target}
          onChange={(e) => setTarget(e.currentTarget.value.toUpperCase())}
          placeholder="Target grid square (e.g. FN31pr)"
        />
        <button type="submit">Calculate</button>
      </form>

      {error && <div className="field-error">{error}</div>}

      {result && (
        <div className="bearing-result">
          <div className="sw-tile">
            <span className="sw-label">Bearing</span>
            <span className="sw-value">{result.bearing.toFixed(0)}° {result.compass}</span>
          </div>
          <div className="sw-tile">
            <span className="sw-label">Distance</span>
            <span className="sw-value">{result.distanceKm.toFixed(0)} km</span>
          </div>
          <div className="sw-tile">
            <span className="sw-label">&nbsp;</span>
            <span className="sw-value">{result.distanceMi.toFixed(0)} mi</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default BearingDistancePanel;
