import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** A small "save this result" button shared by every Tools calculator --
 * closes ToolsPanel's own "Not built yet" gap (calculation-history
 * storage) without six separate copies of the same invoke/feedback
 * logic. `tool` names which calculator this is (shown in the History
 * tab); `summary` is a plain-text description of the current inputs and
 * result, built by the caller since only it knows how to describe its
 * own calculation. Disabled whenever there's nothing valid to save. */
function SaveCalcButton({ tool, summary }: { tool: string; summary: string | null }) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function save() {
    if (!summary) return;
    setState("saving");
    try {
      await invoke("save_calc_history", { tool, summary });
      setState("saved");
      setTimeout(() => setState("idle"), 1500);
    } catch (err) {
      console.error("save_calc_history failed:", err);
      setState("error");
    }
  }

  return (
    <button type="button" className="action-btn" onClick={save} disabled={!summary || state === "saving"} title="Save this result to Tools → History">
      {state === "saved" ? "Saved ✓" : state === "error" ? "Save failed" : "💾 Save"}
    </button>
  );
}

export default SaveCalcButton;
