import { openUrl } from "@tauri-apps/plugin-opener";

const RADIO_PREPPERS_URL = "https://www.facebook.com/groups/632844199439945";
const ISSUES_URL = "https://github.com/frankprobst5-stack/WayStation/issues/new";

function AboutPanel() {
  return (
    <div className="panel-about">
      <p>Copyright © 2026 Frank, KJ4ESQ and Waystation contributors.</p>
      <p>Licensed GPLv3 — Waystation stays free forever.</p>
      <button type="button" className="radio-preppers-button" onClick={() => openUrl(RADIO_PREPPERS_URL)}>
        Visit us at Radio Preppers (Facebook group)
      </button>
      <button type="button" className="radio-preppers-button" onClick={() => openUrl(ISSUES_URL)}>
        Report a bug (GitHub Issues)
      </button>
      <p className="field-hint">
        Found something broken? Settings → Diagnostics has a "Copy report" button that puts a
        plain-text summary of everything on your clipboard — paste it straight into the issue.
      </p>
    </div>
  );
}

export default AboutPanel;
