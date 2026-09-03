import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

// Mirrors sync::SignatureStatus.
type SignatureStatus = "verified" | "unsigned" | "unknown_signer" | "invalid";

// Mirrors sync::MergeReport. uuids only -- this panel doesn't need to
// know message/marker content to show what happened, just what and how
// many.
interface MergeReport {
  inserted: string[];
  updated: string[];
  ignored_stale: string[];
  conflicts: string[];
  signature_status: SignatureStatus;
}

// Mirrors db::TrustedPeer.
interface TrustedPeer {
  id: number;
  callsign: string;
  shared_secret: string;
  added_at: string;
  notes: string | null;
}

type ExportState = { status: "idle" } | { status: "exporting" } | { status: "done"; count: number; path: string } | { status: "error"; message: string };

type ImportState = { status: "idle" } | { status: "importing" } | { status: "done"; report: MergeReport } | { status: "error"; message: string };

function SyncPanel() {
  const [exportState, setExportState] = useState<ExportState>({ status: "idle" });
  const [importState, setImportState] = useState<ImportState>({ status: "idle" });
  const [mySecret, setMySecret] = useState<string | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);
  const [peers, setPeers] = useState<TrustedPeer[]>([]);
  const [peerCallsign, setPeerCallsign] = useState("");
  const [peerSecret, setPeerSecret] = useState("");
  const [peerNotes, setPeerNotes] = useState("");
  const [addingPeer, setAddingPeer] = useState(false);

  async function refreshPeers() {
    setPeers(await invoke<TrustedPeer[]>("get_trusted_peers"));
  }

  useEffect(() => {
    refreshPeers();
  }, []);

  async function revealMySecret() {
    setMySecret(await invoke<string>("get_or_create_signing_secret"));
  }

  async function copySecret() {
    if (!mySecret) return;
    await navigator.clipboard.writeText(mySecret);
    setSecretCopied(true);
    setTimeout(() => setSecretCopied(false), 1500);
  }

  async function addPeer(e: React.FormEvent) {
    e.preventDefault();
    if (!peerCallsign.trim() || !peerSecret.trim()) return;
    setAddingPeer(true);
    try {
      await invoke("add_trusted_peer", { callsign: peerCallsign.trim(), sharedSecret: peerSecret.trim(), notes: peerNotes.trim() || null });
      setPeerCallsign("");
      setPeerSecret("");
      setPeerNotes("");
      await refreshPeers();
    } finally {
      setAddingPeer(false);
    }
  }

  async function removePeer(id: number) {
    await invoke("delete_trusted_peer", { id });
    await refreshPeers();
  }

  async function exportBundle() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const path = await save({
      defaultPath: `waystation-sync-${stamp}.json`,
      filters: [{ name: "WayStation sync bundle", extensions: ["json"] }],
    });
    if (!path) return; // cancelled
    setExportState({ status: "exporting" });
    try {
      const count = await invoke<number>("export_full_bundle_to_file", { path });
      setExportState({ status: "done", count, path });
    } catch (err) {
      setExportState({ status: "error", message: String(err) });
    }
  }

  async function importBundle() {
    const path = await open({
      multiple: false,
      filters: [{ name: "WayStation sync bundle", extensions: ["json"] }],
    });
    if (!path) return; // cancelled
    setImportState({ status: "importing" });
    try {
      const report = await invoke<MergeReport>("import_objects_from_file", { path });
      setImportState({ status: "done", report });
    } catch (err) {
      setImportState({ status: "error", message: String(err) });
    }
  }

  return (
    <div className="panel-sync">
      <p className="sync-lede">
        Exchange messages and map markers with another WayStation station — no network required. Hand the exported
        file to the other station however you can (USB drive, LAN share, a mesh file transfer once that exists):
        export here, import there, and vice versa to sync both ways. Every object keeps its own identity and edit
        history, so importing the same file twice, or importing after you're already caught up, changes nothing.
      </p>

      <div className="sync-section">
        <div className="sync-section-head">
          <h3>Signing</h3>
        </div>
        <p className="sync-lede">
          Signing proves an exported file really came from this station — not who else it's shared with. Anyone can
          transmit on an open RF path and claim to be any callsign; a signature is what lets a station you've
          exchanged secrets with actually tell the difference. Discovering a peer never means trusting them —
          exchanging secrets is something you do deliberately, out loud, ahead of time.
        </p>
        {!mySecret ? (
          <button type="button" onClick={revealMySecret}>
            Show My Signing Secret
          </button>
        ) : (
          <div className="sync-secret-box">
            <code className="sync-secret-value">{mySecret}</code>
            <button type="button" onClick={copySecret}>
              {secretCopied ? "Copied" : "Copy"}
            </button>
          </div>
        )}
        <p className="field-hint">
          Share this with people you trust over voice, in person, or another channel you already trust — never by
          putting it in a sync file itself. Whoever you give it to should add it below under <em>your</em> callsign
          on their own station, so they can verify things you send them.
        </p>

        <h4>Trusted Peers</h4>
        <p className="field-hint">
          People who've given you their own signing secret the same way. Register it here under their callsign to
          verify objects claiming to come from them.
        </p>
        <div className="sync-peer-list">
          {peers.length === 0 && <div className="sync-peer-empty">No trusted peers registered yet.</div>}
          {peers.map((peer) => (
            <div key={peer.id} className="sync-peer-row">
              <span className="sync-peer-callsign">{peer.callsign}</span>
              {peer.notes && <span className="sync-peer-notes">{peer.notes}</span>}
              <button type="button" onClick={() => removePeer(peer.id)}>
                Remove
              </button>
            </div>
          ))}
        </div>
        <form className="sync-peer-form" onSubmit={addPeer}>
          <input placeholder="Their callsign" value={peerCallsign} onChange={(e) => setPeerCallsign(e.currentTarget.value)} />
          <input placeholder="The secret they gave you" value={peerSecret} onChange={(e) => setPeerSecret(e.currentTarget.value)} />
          <input placeholder="Notes (optional)" value={peerNotes} onChange={(e) => setPeerNotes(e.currentTarget.value)} />
          <button type="submit" disabled={addingPeer || !peerCallsign.trim() || !peerSecret.trim()}>
            {addingPeer ? "Adding…" : "Add Trusted Peer"}
          </button>
        </form>
      </div>

      <div className="sync-section">
        <div className="sync-section-head">
          <h3>Export</h3>
          <button type="button" onClick={exportBundle} disabled={exportState.status === "exporting"}>
            {exportState.status === "exporting" ? "Exporting…" : "Export My Data to File"}
          </button>
        </div>
        {exportState.status === "done" && (
          <div className="sync-result sync-result-ok">
            Exported {exportState.count} object{exportState.count === 1 ? "" : "s"} to {exportState.path}
          </div>
        )}
        {exportState.status === "error" && <div className="sync-result sync-result-error">Export failed: {exportState.message}</div>}
      </div>

      <div className="sync-section">
        <div className="sync-section-head">
          <h3>Import</h3>
          <button type="button" onClick={importBundle} disabled={importState.status === "importing"}>
            {importState.status === "importing" ? "Importing…" : "Import From File"}
          </button>
        </div>
        {importState.status === "done" && <ImportReport report={importState.report} />}
        {importState.status === "error" && <div className="sync-result sync-result-error">Import failed: {importState.message}</div>}
      </div>
    </div>
  );
}

const SIGNATURE_LABELS: Record<SignatureStatus, string> = {
  verified: "✓ Verified — signature matches the registered secret for this callsign",
  unsigned: "Unsigned — this file carries no signature",
  unknown_signer: "⚠ Unverified — no trusted-peer secret registered for this callsign",
  invalid: "✕ INVALID SIGNATURE — content may have been altered or forged",
};

function SignatureBadge({ status }: { status: SignatureStatus }) {
  return <div className={`sync-signature-badge sync-signature-${status}`}>{SIGNATURE_LABELS[status]}</div>;
}

function ImportReport({ report }: { report: MergeReport }) {
  const total = report.inserted.length + report.updated.length + report.ignored_stale.length + report.conflicts.length;
  if (total === 0) {
    return (
      <div className="sync-result sync-result-ok">
        <SignatureBadge status={report.signature_status} />
        Nothing in that file — the exporting station had no objects yet.
      </div>
    );
  }
  return (
    <div className="sync-result">
      <SignatureBadge status={report.signature_status} />
      <div className="sync-summary-row">
        <span className="sync-stat sync-stat-inserted">{report.inserted.length} new</span>
        <span className="sync-stat sync-stat-updated">{report.updated.length} updated</span>
        <span className="sync-stat sync-stat-stale">{report.ignored_stale.length} already up to date</span>
        {report.conflicts.length > 0 && <span className="sync-stat sync-stat-conflict">{report.conflicts.length} conflicts</span>}
      </div>
      {report.conflicts.length > 0 && (
        <div className="sync-conflict-warning">
          <strong>{report.conflicts.length} object{report.conflicts.length === 1 ? "" : "s"} could not be merged automatically.</strong>{" "}
          Both stations edited the same item without either being clearly newer. Nothing was overwritten — your
          copy is untouched. Compare manually with the other station for now:
          <ul className="sync-conflict-list">
            {report.conflicts.map((uuid) => (
              <li key={uuid}>
                <code>{uuid}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default SyncPanel;
