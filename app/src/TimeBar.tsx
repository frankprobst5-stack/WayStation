import { useEffect, useState } from "react";
import { formatTime, localTimeZone } from "./lib/time";

/** Always-visible time strip under the tab bar — Zulu time (and today's
 * date) matters on every tab, not just Dashboard, hence not a panel. */
function TimeBar() {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const date = new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeZone: "UTC" }).format(now);

  return (
    <div className="time-bar">
      <span>{date}</span>
      <span>
        LOCAL <strong>{formatTime(now, localTimeZone())}</strong>
      </span>
      <span>
        ZULU <strong>{formatTime(now, "UTC")} Z</strong>
      </span>
    </div>
  );
}

export default TimeBar;
