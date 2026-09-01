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

  useEffect(() => {
    invoke<{ grid_square: string | null }>("get_station_profile").then((p) => {
      setStationGrid(p.grid_square);
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
