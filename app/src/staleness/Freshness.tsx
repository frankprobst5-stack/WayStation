import { useEffect, useState } from "react";
import { formatAge } from "./format";

export type FreshnessTier = "fresh" | "aging" | "stale" | "unknown";

interface FreshnessProps {
  /** RFC3339 timestamp of when this data was fetched, or null if never fetched. */
  fetchedAt: string | null;
  /** Age in seconds past which the tier becomes "aging". Default 5 minutes. */
  agingAfterSeconds?: number;
  /** Age in seconds past which the tier becomes "stale". Default 1 hour. */
  staleAfterSeconds?: number;
}

export function freshnessTier(
  fetchedAt: string | null,
  agingAfterSeconds = 300,
  staleAfterSeconds = 3600,
): { tier: FreshnessTier; ageSeconds: number | null } {
  if (!fetchedAt) return { tier: "unknown", ageSeconds: null };
  const ageSeconds = (Date.now() - new Date(fetchedAt).getTime()) / 1000;
  if (ageSeconds < agingAfterSeconds) return { tier: "fresh", ageSeconds };
  if (ageSeconds < staleAfterSeconds) return { tier: "aging", ageSeconds };
  return { tier: "stale", ageSeconds };
}

/**
 * The one place data age is ever rendered. Per CONTRIBUTING.md: "Nothing
 * blanks out" — a panel with no fresh data still shows what it has, with
 * an honest age, never an empty box or an infinite spinner. Panels compose
 * this instead of each inventing their own staleness display.
 */
function Freshness({ fetchedAt, agingAfterSeconds, staleAfterSeconds }: FreshnessProps) {
  const [, forceTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  const { tier, ageSeconds } = freshnessTier(fetchedAt, agingAfterSeconds, staleAfterSeconds);

  if (tier === "unknown") {
    return <span className="freshness freshness-unknown">no data yet</span>;
  }

  return (
    <span className={`freshness freshness-${tier}`} title={fetchedAt ?? undefined}>
      {formatAge(ageSeconds as number)}
    </span>
  );
}

export default Freshness;
