import type { PanelDefinition } from "./types";

// This is the whole plugin boundary. To add a panel: write a component,
// describe it with a PanelDefinition, call registerPanel() once (see
// panels/index.ts) — nothing else in the app needs to know it exists.
const registry = new Map<string, PanelDefinition>();

export function registerPanel(panel: PanelDefinition): void {
  if (registry.has(panel.id)) {
    // Vite re-executes panels/index.ts whenever it's edited, but this
    // module (and so `registry`) survives that reload. Throwing here made
    // every hot update of index.ts fail, silently leaving the app running
    // the *previous* registrations — which surfaces as "my new panel
    // isn't showing up" or, worse, correct-looking output built from
    // stale definitions. Replacing is the right behavior during HMR; a
    // genuine duplicate id is still a real bug, so production still
    // throws.
    if (import.meta.hot) {
      registry.set(panel.id, panel);
      return;
    }
    throw new Error(`Panel "${panel.id}" is already registered`);
  }
  registry.set(panel.id, panel);
}

export function listPanels(): PanelDefinition[] {
  return Array.from(registry.values());
}
