import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ConnectivitySnapshot, OverallState } from "../connectivity/useConnectivity";

interface ReadinessReport {
  connectivity: ConnectivitySnapshot;
  station_configured: boolean;
  alerts_count: number;
  messages_count: number;
  roster_count: number;
  resources_count: number;
  checked_at: string;
}

const STATE_LABEL: Record<OverallState, string> = {
  online: "🟢 ONLINE",
  degraded: "🟡 DEGRADED",
  rf_only: "🔴 RF-ONLY",
  offline_manual: "⏸️ OFFLINE (switched off)",
};

function ReadinessPanel() {
  const [report, setReport] = useState<ReadinessReport | null>(null);
  const [checking, setChecking] = useState(false);

  async function check() {
    setChecking(true);
    try {
      setReport(await invoke<ReadinessReport>("prepare_for_offline"));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="panel-readiness">
      <button type="button" onClick={check} disabled={checking}>
        {checking ? "Checking..." : "Prepare for Offline"}
      </button>

      {report && (
        <div className="readiness-report">
          <div className={`readiness-line state-${report.connectivity.overall}`}>
            {STATE_LABEL[report.connectivity.overall]}
          </div>
          <div className={`readiness-line ${report.station_configured ? "" : "readiness-warn"}`}>
            {report.station_configured ? "✅" : "⚠️"} Station identity {report.station_configured ? "configured" : "not set — alerts won't fetch"}
          </div>
          <div className="readiness-line">📋 {report.alerts_count} active alert(s) cached</div>
          <div className="readiness-line">💬 {report.messages_count} message(s) logged</div>
          <div className="readiness-line">📻 {report.roster_count} station(s) on roster</div>
          <div className="readiness-line">🏠 {report.resources_count} resource(s) tracked</div>
          <div className="readiness-checked-at">checked {new Date(report.checked_at).toLocaleTimeString()}</div>
        </div>
      )}
    </div>
  );
}

export default ReadinessPanel;
