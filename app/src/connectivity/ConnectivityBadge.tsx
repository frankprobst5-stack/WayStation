import { useConnectivity } from "./useConnectivity";
import type { OverallState } from "./useConnectivity";
import Freshness from "../staleness/Freshness";

const LABELS: Record<OverallState, string> = {
  online: "ONLINE",
  degraded: "DEGRADED",
  rf_only: "RF-ONLY",
  offline_manual: "OFFLINE",
};

const DOTS: Record<OverallState, string> = {
  online: "🟢",
  degraded: "🟡",
  rf_only: "🔴",
  // Deliberately not the red "something broke" dot — this state is a
  // choice the operator made, not a failure.
  offline_manual: "⏸️",
};

function ConnectivityBadge() {
  const snapshot = useConnectivity();

  if (!snapshot) {
    return (
      <div className="connectivity-badge" title="Waiting for first connectivity check...">
        <span>⚪</span> <span>CHECKING</span>
      </div>
    );
  }

  const title = snapshot.sources
    .map((s) => `${s.label}: ${s.status}${s.detail ? ` (${s.detail})` : ""}`)
    .join("\n");

  const attempts = snapshot.sources
    .map((s) => s.last_attempt_at)
    .filter((t): t is string => t !== null)
    .sort();
  const lastAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;

  return (
    <div className={`connectivity-badge state-${snapshot.overall}`} title={title}>
      <span>{DOTS[snapshot.overall]}</span> <span>{LABELS[snapshot.overall]}</span>
      <Freshness fetchedAt={lastAttempt} agingAfterSeconds={30} staleAfterSeconds={120} />
    </div>
  );
}

export default ConnectivityBadge;
