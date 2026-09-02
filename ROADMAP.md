# WayStation — Roadmap

**Online for awareness. Offline for operations. Built to shine when the grid goes down.**

WayStation is an offline-first communications and field-operations platform for amateur radio, emergency communications, preparedness, and resilient local coordination. It is not a collection of ham-radio panels. Its operational loop is:

**OBSERVE → UNDERSTAND → DECIDE → COMMUNICATE → DOCUMENT → SYNCHRONIZE**

Online connectivity enriches the local operational picture. When connectivity degrades, WayStation retains cached information with honest age and provenance. When the grid fails, live RF, local hardware, nearby peers, and locally stored operational data take over. Grid-down mode is not a crippled online dashboard — it is the environment WayStation exists to serve.

WayStation is the comms component of a larger project, [Citadel](https://github.com/frankprobst5-stack/Project-Citadel) — a self-hosted, offline-first home command center. Citadel launches WayStation directly (see `app/src-tauri/src/lib.rs`'s deep-link registration); the two are separate applications, not one embedded in the other. The eventual deployment target is **8 independent homes**, each running its own Citadel+WayStation instance, coordinating with each other over long-range RF when normal internet/phone service is down.

**Non-negotiable principle:** every future feature must either strengthen the shared operational core, provide it with trustworthy data, deliver its objects, help the operator act on them, or improve field reliability. New panels must not become isolated islands.

---

## How progress is classified

| Status | Meaning | Release claim |
|---|---|---|
| **BUILT + VERIFIED** | Implemented and tested against real software, live network services, local processes, database tests, or reproducible simulations. | Working within the tested environment. |
| **BUILT — HARDWARE VALIDATION PENDING** | Code path exists, but real RF, noise, range, timing, multi-node behavior, or equipment interoperability hasn't been proven. | Experimental; not field-proven. |
| **PARTIAL** | A useful portion exists, but reception, sending, acknowledgement, synchronization, UI, or error handling remains incomplete. | Limited capability only. |
| **PLANNED** | Agreed scope with a known place in the architecture, but no implementation. | Not available. |
| **DISCOVERY** | A real possibility requiring research, protocol decisions, safety analysis, or hardware access. | No commitment until investigated. |

Frank owns no dedicated mesh/AREDN/SDR test hardware yet — the app is being built to be software-complete (simulation, replay, and real local-service integration where no radio is required) before hardware becomes the bottleneck. Testers with real equipment are WayStation's distributed hardware laboratory; their job is to validate reality and report evidence, not to finish designing the application.

---

## Built and verified

**Foundation**
- Tauri desktop shell + window management, SQLite schema with `source`/`fetched_at`/`via` provenance conventions, connectivity state machine (online/degraded/RF-only/manual-offline), panel plugin architecture with category-based registration.
- Migration system: 30 migrations, each atomic (own transaction, `user_version` only advances on success — found necessary the hard way after a real mid-migration process kill on 2026-08-30 left an earlier version of the schema half-applied). Full chain, idempotency, and partial-failure-leaves-no-trace are all covered by real tests (`db.rs`'s `#[cfg(test)] mod tests`).
- Offline world map (day/night terminator, greyline), station identity + local/Zulu time bar, app-wide staleness/freshness display convention, database backup/export (atomic `VACUUM INTO`), Diagnostics panel.

**EmComm core**
- NWS active alerts (severity-colored, cached honestly on fetch failure), net control roster (check-in/out, last-heard, traffic count), ICS-213 message form, ICS-309 log + export, resource tracking, "Prepare for Offline" forced-poll check.

**Operating awareness**
- Space weather, band-condition table, DX cluster live feed, POTA spots, Hamlib CAT/rotator control, ADIF QSO log, satellite pass prediction with Doppler, bearing/distance and RF calculators, PSKReporter reception reports, repeater lookup, contest calendar, band plan reference.

**Mesh (Meshtastic)**
- Real TCP client verified against `meshtasticd`'s actual wire protocol. Node list, channel chat with real delivery status (sent/delivered/failed — a failed send says why, never silently claims success). Direct messages, position send/request, and synchronized pins are built but unverified for want of a second physical node.

**Off-grid messaging**
- Pat/Winlink process orchestration (auto-launch, status, inbox, orphaned-process auto-reclaim) and JS8Call TCP client (status + inbox) both working.

**Citadel integration — built and verified end-to-end, 2026-09-01**
- WayStation registers a `waystation://` custom URI scheme (`tauri-plugin-deep-link`) so Citadel's cockpit can launch it directly. `tauri-plugin-single-instance` runs first in the plugin chain — a second launch attempt while WayStation is already running focuses the existing window instead of spawning a competing process (which would otherwise fight over the same SQLite file and the same mesh/rig/rotator TCP ports).
- Citadel's "Communications Hub" tile (`appdata/cockpit/index.html`) now opens `waystation://open` instead of the old `comms.html`.
- Verified for real, both cold-start and already-running cases, from Citadel's live cockpit in an actual browser. One real lesson from getting here: a plain `cargo build --release` is **not** equivalent to a real production build — it still bakes in the Vite dev server URL and embeds none of the frontend. Only `tauri build` (or `npm run tauri build`) produces a binary that doesn't depend on a dev server being alive. Verify any future release binary with `strings target/release/waystation | grep localhost:1420` before trusting it.

**Canonical object header + Transport trait — built and verified, 2026-09-01**
- v30 migration: `uuid`, `revision`, `updated_at`, `incident_id`, `expires_at`, `trust_state` added to `messages` and `map_markers` — the shared header every object type needs before cross-station sync can exist. `uuid` is the stable cross-instance identity (local autoincrement `id` will collide the moment more than one of the 8 planned home instances exists); backfilled automatically for any existing rows on every `db::open()`.
- `Transport` trait (`transport.rs`) with full `MeshTransport`/`WinlinkTransport`/`Js8CallTransport` implementations, derived from three real, already-working send paths rather than designed speculatively. `dispatch.rs`'s two near-duplicate if-chains (one for messages, one for markers) collapsed into one shared loop. Deliberately preserves a real, pre-existing asymmetry: ICS-213 messages get per-transport-tailored formatting (mesh's compact single line vs. Winlink's full body vs. JS8Call's most-compact-of-all, matching real JS8 bandwidth limits), while situational markers share one exact wire format across all three transports, since a marker is a parseable protocol another station decodes, not prose.
- Verified at three levels: 18 automated tests (10 new, including exact-string tests against the pre-refactor wire formats — this caught a real mistake in the first draft that would have collapsed the three message formats into one); a clean release build; and two live integration tests run against Frank's actual logged-in Pat and JS8Call sessions, with the resulting test message independently confirmed sitting in the real Pat outbox via the API. **Mesh is not verified live** — no Meshtastic node was connected this session, so `MeshTransport` has unit-test coverage only.

**Durable delivery-attempt history — built and verified, 2026-09-01**
- v31 migration: `delivery_attempts` table, keyed by object `uuid` (not the local integer id). `dispatch.rs`'s `try_dispatch`/`try_dispatch_marker` now share one `dispatch_with_logging()` helper that records every transport attempt — success or failure — instead of only the winning one. Closes the real gap where `dispatch_status`/`dispatched_via` only ever showed the latest outcome, never the road there.
- Verified: 2 new tests proving a message tried on a failing transport then a succeeding one leaves both attempts queryable in order (22 tests total, 20 passing + 2 live-service-only skipped by default), clean release build, no new clippy issues.

**Two-instance sync proof — reconciliation logic built and verified, 2026-09-01**
- `sync.rs`: a manifest (`uuid`/`kind`/`revision`/`updated_at`/`content_hash`) is the lightweight thing two stations exchange first; `uuids_needed_from()` diffs two manifests to decide what to actually fetch — missing entirely, strictly newer revision, *or* same revision with a different content hash (a real potential conflict, not just "who's ahead"). `export_objects()` fetches full content only for what's actually needed. `merge_incoming()` applies it: insert if unknown, adopt if strictly newer, flag-and-change-nothing on a genuine conflict, ignore if local is already ahead. `trust_state` is forced to `'received'` on ingest regardless of what a peer's object claims about itself — a station's own database is the only thing allowed to call something `'local'`.
- Deliberately transport-agnostic: the reconciliation functions operate on `&Connection` and plain data with no assumption about how the bytes moved. File-based exchange (`export_manifest_to_file`/`manifest_diff_from_file`/`export_objects_to_file`/`import_objects_from_file`) is the first real transport, chosen because the roadmap explicitly names it and it proves the logic for real without WayStation needing to become a network server yet — a local TCP listener or eventually real mesh/AREDN can wrap the exact same functions later.
- `WAYSTATION_DATA_DIR` env var override on `db::data_dir()` lets two real WayStation instances run on one machine against two separate databases — the actual mechanism for proving "two stations" without needing two physical computers.
- Verified: 3 tests, each running the real exchange sequence (export manifest → diff → export requested objects → merge) between two genuinely separate SQLite databases — not a simplified stand-in. Proves new-object convergence in both directions, a stale instance correctly adopting a newer revision, interrupt-resume (re-running an already-converged exchange is a clean no-op), and a genuine conflict (two stations editing offline, unaware of each other, same revision) being flagged and left unresolved rather than silently overwritten. Clean release build.
- **UI added, 2026-09-01: `SyncPanel.tsx` (Settings → Peer Sync).** Two buttons — Export My Data to File, Import From File — plus a combined `export_full_bundle_to_file`/reused `import_objects_from_file` command pair that skip the selective-fetch optimization (a real thing for bandwidth-constrained RF later, not meaningful for a file exchange) and just export everything, letting `merge_incoming`'s already-safe no-op behavior sort out what's actually new. Shows insert/update/already-up-to-date counts and lists any conflicts by uuid without ever silently overwriting one. **Honest gap: the panel itself hasn't been clicked through by a human yet** — TypeScript compiles clean and the release build packages correctly, but exercising two real running instances via the actual UI needs Frank's hands-on pass, not something verifiable by an agent that can't drive a native GUI window.

**WSP/1 formalized — built and verified, 2026-09-02** — see [WSP-1.md](WSP-1.md) for the full spec. Every sync export is now a versioned `WspEnvelope` (`wsp_kind`/`wsp_version`/`origin_callsign`/`generated_at`) instead of a bare JSON array; a future format change or the wrong file kind now fails with a clear error instead of a confusing deserialize panic or silent misparse. 4 new tests (29 total, 27 passing + 2 live-only skipped).

**Phase D slice 1: incident lifecycle — built and verified, 2026-09-02**
- `incidents` table (v32 migration): real multi-incident create/active/closed lifecycle with the canonical uuid/revision/updated_at/trust_state header, separate from the pre-existing `incident_info` singleton (unchanged — still the quick-glance "current situation" card).
- `set_message_incident`/`set_marker_incident`: finally puts the `incident_id` column (present on messages/map_markers since v30, unused until now) to work — tags existing traffic against a declared incident, rejecting a dangling/unknown incident reference rather than writing one silently.
- `IncidentsPanel.tsx` (EmComm → Incidents): declare an incident, see active vs. closed, close one.
- Verified: 6 new tests (34 total, 32 passing + 2 live-only skipped) — create→close lifecycle with a real revision bump on close, closing an unknown incident failing clearly, active-before-closed sort order, tagging a real message and reading it back, clearing a tag, and a dangling-uuid tag attempt being rejected with the message left untouched. Clean release build.
- **Explicitly not this slice:** personnel/team tracking, expanded resource-request objects, structured SITREP, operational timeline, and the tactical map actually rendering incident objects instead of independent pins. Real remaining Phase D work, not silently folded into "done."

**Phase D slice 2: personnel tracking — built and verified, 2026-09-02**
- `personnel` table (v33 migration): a standing roster, separate from `net_roster` (which tracks radio check-in state, not operational assignment — the same person can appear in both without conflict, they mean different things). Status vocabulary: available/assigned/en_route/on_scene/unavailable/off_duty/emergency. `incident_id` optional and reassignable — personnel exist independent of any one incident, get assigned when one exists.
- `assign_person_to_incident`: same dangling-reference protection as message/marker tagging — an unknown incident uuid is rejected, not written.
- `PersonnelPanel.tsx` (EmComm → Personnel): add a person, change status, assign/clear incident from a live dropdown of active incidents.
- Verified: 6 new tests (40 total, 38 passing + 2 live-only skipped) — default state, rejecting an unrecognized status with the record left untouched, every documented status accepted, real incident assignment + clearing, rejecting assignment to an unknown incident, and sort order (actively-assigned personnel before everyone else, not just creation order). Clean release build.
- **Explicitly not this slice:** expanded resource-request objects, structured SITREP, operational timeline, tactical-map-by-incident. Same honesty rule as slice 1.

**Phase D slice 3: resource requests — built and verified, 2026-09-02**
- `resource_requests` table (v34 migration): a real request-with-fulfillment-lifecycle, separate from the pre-existing bracket-token `resources` status board (v4, "[Beds 30/100]" — unchanged, still a real and different thing: passive current status vs. an active ask). `priority` reuses `messages.precedence`'s exact vocabulary (routine/priority/immediate/emergency) rather than inventing a second one for the same concept. `status`: requested → acknowledged → in_progress → fulfilled, or cancelled. `resource_type` is free text, same precedent as `map_markers.marker_type` — an open-ended real-world list (fuel, medical, food, water, generators, transportation, shelter beds...) that a fixed enum would just be wrong about the first time someone needs something not on it.
- Setting status to `fulfilled` stamps `fulfilled_at`; reverting away from it clears that timestamp rather than leaving it lying around contradicting the current status.
- `ResourceRequestsPanel.tsx` (EmComm → Resource Requests): log a request, change status, assign/clear incident.
- Verified: 7 new tests (47 total, 45 passing + 2 live-only skipped) — default state, rejecting an unknown priority, rejecting a dangling incident reference, fulfilled_at set-then-cleared across a status round-trip, rejecting an unrecognized status, sort order (open requests before closed, most urgent priority first within each group), and real incident assignment + clearing. Clean release build.
- **Explicitly not this slice:** structured SITREP, operational timeline, tactical-map-by-incident. Phase D's last two real pieces.

**Phase D slice 4: operational timeline — built and verified, 2026-09-02**
- `incident_events` table (v35 migration): generalizes the exact pattern `delivery_attempts` (v31) already proved — a real event log, not an inference from scattered `updated_at` columns across `incidents`/`personnel`/`resource_requests`, which can show *that* something changed but not *what* or in what order relative to everything else tied to the same incident. `incident_id` is required here (unlike every other object type's optional one) — a timeline only exists in the context of a declared incident.
- Wired into every incident-touching write path, not added in isolation: `create_incident`/`close_incident` (incident-level events), `set_person_status`/`assign_person_to_incident`, `create_resource_request`/`set_resource_request_status`/`set_resource_request_incident`, `set_message_incident`/`set_marker_incident`. Moving something from one incident to another logs an "unassigned/untagged" event on the old incident and an "assigned/tagged" event on the new one — not just the new state. A status change on personnel/resources not currently tied to any incident logs nothing, correctly — there's no timeline to attach it to.
- Timeline view added to `IncidentsPanel.tsx` — expand any incident to see its recorded sequence.
- Verified: 4 new tests (50 total, 48 passing + 2 live-only skipped) — a full realistic scenario (declare → assign person → status change → resource request → fulfill → tag a message → close) reading back in the exact order it happened with real summary content, moving a person between two incidents logging correctly on both sides, and a status change on an unassigned person logging nothing anywhere rather than writing a dangling row. Clean release build.
- **Phase D now has one real piece left:** structured SITREP (a document combining incident + personnel + resources + traffic), plus tactical-map-by-incident whenever the map panel gets touched.

---

## Built, but not yet proven in the field

- **Meshtastic direct messaging, synchronized pins, position send/request** — need a second physical node.
- **Winlink/Pat, JS8Call** — verified against real running local software; never verified against an actual RF path or real correspondent station.
- **Hamlib rig/rotator control** — verified against `rigctld`/`rotctld` running locally; not verified against real radio hardware.
- **`MeshTransport`** (this session's work) — unit-tested, not live-tested (no node available).

---

## The missing shared operational core (from the original planning review — status updated)

1. **Canonical operational objects** — ✅ **done** (see above). Message and map marker are the first two objects carrying the shared header. Alert, station, person, team, resource, request, assignment, incident, SITREP, acknowledgement, and status-event objects are not yet converted.
2. **WayStation Interchange Protocol (WSP/1)** — 🔲 **not started.** A compact versioned wire representation, fragmentation/reassembly/dedup/compression/ack/TTL, a human-readable diagnostic form and a compact RF form, signed/authenticated object support. This is the next real architectural gap.
3. **Delivery and transport architecture** — ✅ **done.** The `Transport` trait plus the v31 delivery-attempt history together cover this: every attempt on every transport is now a real, queryable record, not just a latest-state field.
4. **Peer synchronization** — ✅ **reconciliation logic, UI, and WSP/1 spec done, 2026-09-01/02** (see above and [WSP-1.md](WSP-1.md)). 🔲 Still open: a local TCP transport (files work, proven; TCP doesn't exist yet), and WSP/2's compact/fragmentable encoding once a real bandwidth-constrained transport exists to need it.

---

## Revised development sequence (Phase A–F)

- **Phase A — Stabilize the current application.** Partial: real regression tests exist for the migration system and the new transport layer; Windows/Linux CI and packaging, first-run onboarding, and a full simulated offline/crash/long-duration exercise are still open.
- **Phase B — Operational object foundation.** ✅ **Done, 2026-09-01.** Object header, message + marker conversion, revision/provenance rules, WSP/1 documented ([WSP-1.md](WSP-1.md)).
- **Phase C — Two-station communications proof.** ✅ **Done except hardware.** Durable queue + delivery-attempt history (v31), reconciliation logic proven between two real databases, the Peer Sync UI, and the WSP/1 spec are all done. Left: reusing this exact proof over physical mesh/AREDN once hardware exists — genuinely blocked on hardware, not on more design or code.
- **Phase D — Incident operations.** 🔲 **Started, 4 of 5 slices done, 2026-09-02.** Slice 1: real multi-incident lifecycle plus `incident_id` tagging on messages/markers. Slice 2: `personnel` table with status + incident assignment. Slice 3: `resource_requests` with a real fulfillment lifecycle. Slice 4: `incident_events` operational timeline, wired into every write path above. **Not done yet:** structured SITREP, tactical map driven by incident objects instead of independent pin layers.
- **Phase E — Software-complete application.** 🔲 Not started as a phase, though today's work is a down payment on its philosophy: build every hardware-facing capability against simulation/replay/fixtures so real equipment is never a blocker for finishing the software.
- **Phase F — Release candidate and tester deployment.** 🔲 Not started.

---

## Immediate next priorities

1. ~~**Operational object design**~~ — ✅ done 2026-09-01.
2. ~~**Durable outbound queue with delivery-attempt history**~~ — ✅ done 2026-09-01.
3. ~~**Two-instance proof without new hardware**~~ — ✅ reconciliation logic done and verified 2026-09-01.
4. ~~**A minimal sync UI**~~ — ✅ `SyncPanel.tsx` shipped 2026-09-01 (Settings → Peer Sync). Not yet clicked through by a human in the real running app.
5. ~~**WSP/1 real spec**~~ — ✅ done 2026-09-02, see [WSP-1.md](WSP-1.md). Real versioned envelope (`wsp_kind`/`wsp_version`/`origin_callsign`/`generated_at`), not the bare JSON arrays from the day before — a future format change now fails with a clear error instead of a silent misparse.
6. **Current-state hardening** — CI/packaging, first-run onboarding, a full no-internet exercise on the existing application.
7. **Phase D — Incident operations** — the current focus. Slices 1–4 (incident lifecycle + tagging, personnel, resource requests, operational timeline) done 2026-09-02; structured SITREP and tactical-map-by-incident are what's left.

Closing principle, unchanged from the original planning document: **success is not measured by the number of panels. Success is measured by whether WayStation can preserve and move a trustworthy operational picture when ordinary infrastructure fails.**

---

## North-star acceptance scenario

A severe-weather incident begins while internet service is available. WayStation receives alerts and builds the initial local picture. Operators create an incident, check in personnel, and stage communications paths.

The internet then fails. Cached information remains visible and marked with its true age. NOAA radio, Meshtastic, AREDN, local SDR receivers, station sensors, and nearby WayStation peers continue supplying live information.

A shelter reports generator fuel is low. The report becomes a priority resource-request object attached to the incident. WayStation queues it, recommends an available path, records operator approval, sends it, receives acknowledgement, and synchronizes the update to authorized peers.

A field team loses its preferred path. The failed attempt is preserved. WayStation recommends a fallback based on observed availability and policy — it does not silently invent delivery or endlessly retransmit.

A new operator takes over. The incident timeline, outstanding traffic, personnel, resources, station health, and current communications paths provide a complete handoff.

After the exercise or incident, WayStation exports the communications log, messages, acknowledgements, SITREP, timeline, and after-action record.

**Online, WayStation builds awareness. Offline, WayStation becomes the communications infrastructure.**

---

## Changelog

- **2026-09-02** — WSP/1 formalized: a real versioned envelope (`wsp_kind`/`wsp_version`/`origin_callsign`/`generated_at`) wraps every sync export instead of a bare JSON array, so a future format change fails clearly instead of silently misparsing. [WSP-1.md](WSP-1.md) documents what's actually built, naming what's deliberately not (compact/binary RF encoding, fragmentation, signing, TTL/forwarding, non-message/marker object types) rather than leaving it silently absent. 4 new tests — one of which failed on first write (a test bug, not a code bug: `station_profile` has no row until one's ever been saved, so an `UPDATE` in the test matched nothing) and got fixed rather than the assertion loosened. Phase C is now done except for the piece that's genuinely blocked on hardware. Phase D (Incident Operations) started same day: slice 1 — real multi-incident lifecycle (`incidents` table, create/close), `incident_id` tagging on messages/markers finally put to use, `IncidentsPanel.tsx`. Slice 2 — `personnel` table (status + incident assignment, distinct from `net_roster`'s radio-check-in concept), `PersonnelPanel.tsx`. Slice 3 — `resource_requests` (real fulfillment lifecycle, distinct from the bracket-token resources status board), `ResourceRequestsPanel.tsx`. Slice 4 — `incident_events` operational timeline (generalizes the `delivery_attempts` pattern), wired into every incident-touching write path across all three earlier slices, timeline view in `IncidentsPanel.tsx`. SITREP and tactical-map-by-incident are what's left of Phase D. 50 tests total, 48 passing, 2 live-service-only skipped by default.
- **2026-09-01** — WayStation↔Citadel launch integration (`waystation://` deep link + single-instance), built and verified end-to-end. Canonical object header (v30 migration: uuid/revision/updated_at/incident_id/expires_at/trust_state on messages + map_markers). `Transport` trait, fully migrating all three real transports (mesh/Winlink/JS8Call) off the old hand-duplicated dispatch logic — a deliberate reversal of a 2026-08-29 decision to defer this exact abstraction, revisited because there were finally three real implementations to derive it from instead of designing it speculatively. Durable delivery-attempt history (v31), closing the "delivery and transport architecture" gap. Two-instance sync reconciliation (`sync.rs`) proven against two real databases — new-object convergence, stale-instance catch-up, interrupt-resume, and genuine-conflict detection all verified. `SyncPanel.tsx` UI added (Settings → Peer Sync) so this is actually clickable, not just correct in the backend — not yet human-verified through the real app. This `ROADMAP.md` created, replacing the planning-PDF as WayStation's tracked source of truth.
