import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

// Mirrors qr_transport::QrPanel.
interface QrPanel {
  idx: number;
  png_base64: string;
}

// Mirrors qr_transport::QrCardStatus.
interface QrCardStatus {
  card_id: string;
  panels_present: number;
  decoded_text: string | null;
}

/** Zero-radio, zero-network message exchange: a message becomes 4 QR
 * panels (any 3 of 4 reconstruct it -- the real scheme is Keith B.
 * Phillips's own qrcoder, ported natively here, see qr_transport.rs's
 * own module doc), displayed for another device to just photograph. No
 * mesh, no Winlink, no internet -- works on line-of-sight camera contact
 * alone, the real gap the XTOC comparison in ROADMAP.md named. */
function QrTransportPanel() {
  const [draft, setDraft] = useState("");
  const [panels, setPanels] = useState<QrPanel[] | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [cards, setCards] = useState<QrCardStatus[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  async function refreshProgress() {
    try {
      setCards(await invoke<QrCardStatus[]>("get_qr_import_progress"));
    } catch (err) {
      console.error("get_qr_import_progress failed:", err);
    }
  }

  useEffect(() => {
    refreshProgress();
  }, []);

  async function generate() {
    if (!draft.trim()) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      setPanels(await invoke<QrPanel[]>("generate_qr_card", { text: draft }));
    } catch (err) {
      setGenerateError(String(err));
    } finally {
      setGenerating(false);
    }
  }

  async function importPhoto() {
    const path = await open({
      multiple: false,
      filters: [{ name: "Photo", extensions: ["png", "jpg", "jpeg", "bmp", "gif", "webp"] }],
    });
    if (!path) return; // cancelled
    setImporting(true);
    setImportError(null);
    try {
      await invoke<QrCardStatus[]>("import_qr_image", { path });
      await refreshProgress();
    } catch (err) {
      setImportError(String(err));
    } finally {
      setImporting(false);
    }
  }

  async function clearCard(cardId: string) {
    try {
      await invoke("clear_qr_import", { cardId });
      await refreshProgress();
    } catch (err) {
      console.error("clear_qr_import failed:", err);
    }
  }

  return (
    <div className="panel-sync">
      <p className="sync-lede">
        Turn a message into a sequence of QR codes another device just photographs — no radio, no network, no mesh
        node in range needed. Any 3 of the 4 panels fully reconstruct the message, so losing one to a bad photo,
        glare, or a torn printout is survivable.
      </p>

      <div className="sync-section">
        <div className="sync-section-head">
          <h3>Create a Card</h3>
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          placeholder="Message to encode (e.g. a SITREP, a position, a short note)..."
          rows={4}
          style={{ width: "100%" }}
        />
        <button type="button" className="action-btn" style={{ marginTop: "0.6rem" }} onClick={generate} disabled={!draft.trim() || generating}>
          {generating ? "Generating..." : "Generate QR Card"}
        </button>
        {generateError && <div className="panel-alerts-empty">{generateError}</div>}

        {panels && (
          <div className="quick-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "1rem", marginTop: "1rem" }}>
            {panels.map((p) => (
              <div key={p.idx} className="sw-tile" style={{ textAlign: "center" }}>
                <img
                  src={`data:image/png;base64,${p.png_base64}`}
                  alt={`QR panel ${p.idx + 1} of 4`}
                  style={{ width: "100%", maxWidth: "220px", imageRendering: "pixelated" }}
                />
                <span className="sw-label">Panel {p.idx + 1} of 4</span>
              </div>
            ))}
          </div>
        )}
        {panels && <p className="field-hint">Show each panel in turn (or all 4 printed together) for the other device to photograph.</p>}
      </div>

      <div className="sync-section" style={{ marginTop: "1rem" }}>
        <div className="sync-section-head">
          <h3>Import a Card</h3>
        </div>
        <p className="field-hint">
          Pick a photo of one panel at a time (a single photo framing more than one panel works too). Once any card
          reaches 3 of its 4 panels, the message decodes automatically below.
        </p>
        <button type="button" className="action-btn" onClick={importPhoto} disabled={importing}>
          {importing ? "Reading..." : "Choose Photo..."}
        </button>
        {importError && <div className="panel-alerts-empty">{importError}</div>}

        {cards.length === 0 ? (
          <div className="panel-alerts-empty" style={{ marginTop: "0.6rem" }}>
            No cards imported yet.
          </div>
        ) : (
          <div className="mesh-participant-list" style={{ marginTop: "0.6rem" }}>
            {cards.map((c) => (
              <div key={c.card_id} className="mesh-participant-row">
                <div className="mesh-participant-body">
                  <div className="mesh-participant-name-row">
                    <span className="resource-label">Card {c.card_id}</span>
                    <span className="resource-chip">{c.panels_present}/4 panels</span>
                    <button type="button" className="mesh-message-delete" title="Discard this card's progress" onClick={() => clearCard(c.card_id)}>
                      ✕
                    </button>
                  </div>
                  {c.decoded_text ? (
                    <div className="mesh-message-text" style={{ whiteSpace: "pre-wrap" }}>
                      {c.decoded_text}
                    </div>
                  ) : (
                    <div className="resource-tokens">
                      <span className="resource-chip">Waiting on at least 3 of 4 panels</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default QrTransportPanel;
