import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

interface SoftwareEntry {
  id: string;
  name: string;
  detected: boolean;
  install_url: string;
  note: string;
}

function RequiredSoftwarePanel() {
  const [software, setSoftware] = useState<SoftwareEntry[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    // Real bug found live 2026-10-09 (same file-wide sweep): no catch
    // meant a failed invoke left `software` null forever, and
    // `!software` below is this panel's own loading gate.
    invoke<SoftwareEntry[]>("get_required_software")
      .then(setSoftware)
      .catch((err) => {
        console.error("get_required_software failed:", err);
        setFetchError(String(err));
      });
  }, []);

  if (fetchError) {
    return <div className="panel-required-software panel-alerts-empty">Could not check installed software: {fetchError}</div>;
  }

  if (!software) {
    return <div className="panel-required-software">Loading...</div>;
  }

  return (
    <div className="panel-required-software">
      <p className="field-hint">
        What's actually installed on this machine, for the programs WayStation talks to. Detection
        only checks the filesystem — it never runs anything to find out, so "not found" can also
        mean it's installed somewhere unusual. Setup steps for each one are in the User Manual's
        Setup & Operation row.
      </p>
      <div className="required-software-list">
        {software.map((s) => (
          <div key={s.id} className={`required-software-row ${s.detected ? "detected" : "missing"}`}>
            <div className="required-software-head">
              <span className={`diag-badge diag-badge-${s.detected ? "healthy" : "down"}`}>
                {s.detected ? "Detected" : "Not found"}
              </span>
              <span className="required-software-name">{s.name}</span>
              {!s.detected && (
                <button type="button" onClick={() => openUrl(s.install_url)}>
                  Get {s.name.split(" (")[0]}
                </button>
              )}
            </div>
            <p className="required-software-note">{s.note}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default RequiredSoftwarePanel;
