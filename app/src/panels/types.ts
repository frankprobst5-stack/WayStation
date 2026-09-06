import type { ComponentType } from "react";

/**
 * How a panel behaves as connectivity degrades. Required on every panel
 * per CONTRIBUTING.md — a feature proposal has to say what it does in all
 * three states, and this is where that answer lives in code.
 *
 * - "always-available": needs nothing from the network (a clock, a form).
 * - "degrades": still useful RF-only, but with reduced/stale data — must
 *   show honest staleness, never blank.
 * - "internet-only": has no offline story yet. Allowed to exist, but the
 *   panel must say so visibly rather than silently failing.
 */
export type OfflineBehavior = "always-available" | "degrades" | "internet-only";

/**
 * Which tab a panel appears under. Fixed set (not free-form) so the tab bar
 * stays predictable as panels are added — pick the closest fit rather than
 * inventing a new category for one panel.
 *
 * "emcomm" was retired 2026-09-05 -- it had grown to 12 stacked panels on
 * one page (incident ops, the tactical map, flight tracking, the scanner,
 * weather, all in one scroll) as each got built. Split into one category
 * per real sub-group instead, matching a flatter sidebar over a few
 * overloaded tabs -- each of tactical-map/flight-tracking/scanner/weather
 * is substantial enough to be its own page, not a fragment.
 */
/**
 * "dashboard" is special: as of 2026-09-05, App.tsx renders `DashboardPage`
 * directly for this tab instead of stacking whatever panels are
 * registered under it, so no panel should register itself here anymore --
 * the composite dashboard pulls its own data straight from the same
 * commands the individual panels use (rig/rotator status, connectivity,
 * incident_info, space/local weather, channels), it doesn't wrap them.
 * Kept in the union purely so it still has a tab label and a place in
 * TAB_ORDER.
 */
export type PanelCategory =
  | "dashboard"
  | "incident-ops"
  | "tactical-map"
  | "flight-tracking"
  | "scanner"
  | "weather"
  | "messaging"
  | "activity"
  | "reference"
  | "tools"
  | "settings"
  | "manual";

/**
 * How much horizontal room a panel needs, in grid columns.
 *
 * Panels are not interchangeable boxes — a world map, a six-field entry
 * form, and a two-line status readout have genuinely different shapes,
 * and forcing them into one uniform cell is what produced this app's
 * recurring layout bugs (truncated labels, form rows with 3-character
 * inputs, a Save button pushed below a scroll). The panel declares its
 * own shape here, next to the rest of its contract, rather than App.css
 * special-casing it by class name after the fact.
 *
 * - "standard": one column. The default.
 * - "wide": two columns — multi-input forms, side-by-side readouts.
 * - "full": the whole row — maps, wide tables, anything with its own
 *   internal multi-column layout.
 */
export type PanelWidth = "standard" | "wide" | "full";

/**
 * How tall a panel is allowed to get.
 *
 * - "standard": capped, scrolls internally. Right for feeds you skim.
 * - "tall": a taller cap, still scrolling. For longer lists worth seeing
 *   more of at once.
 * - "natural": no cap. For content where hiding part of it behind an
 *   inner scrollbar is wrong — a map, or a form whose submit button must
 *   stay reachable.
 */
export type PanelHeight = "standard" | "tall" | "natural";

export interface PanelDefinition {
  /** Stable, unique id — used as the React key and for future layout persistence. */
  id: string;
  title: string;
  category: PanelCategory;
  /** How often the panel's data should be considered fresh, in seconds. Null if it's self-driven (e.g. a clock) and doesn't poll anything. */
  refreshCadenceSeconds: number | null;
  offlineBehavior: OfflineBehavior;
  /**
   * Layout hints. Optional, unlike offlineBehavior, and deliberately so:
   * a wrong offline story is a correctness problem you can't see, while a
   * wrong width is cosmetic and obvious the first time you look at it.
   * Omit both and you get a standard cell.
   */
  width?: PanelWidth;
  height?: PanelHeight;
  /**
   * Marks a panel as hobbyist/operating-award-adjacent rather than
   * mission-focused — contest calendars, DX cluster spots, that kind of
   * thing. Hidden by default under Tactical Mode, still fully present in
   * Hobbyist Mode. Deliberately per-panel, not per-category: "Activity"
   * also holds QSO log and satellite tracking, which stay visible in
   * either mode.
   */
  hobbyist?: boolean;
  component: ComponentType;
}
