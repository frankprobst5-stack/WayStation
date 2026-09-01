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
3. **Delivery and transport architecture** — ✅ **transport layer done** (the `Transport` trait). 🔲 The durable outbound queue with delivery-attempt history is **not** built yet — `dispatch_status`/`dispatched_via` on `messages`/`map_markers` capture latest state only, not a full attempt history.
4. **Peer synchronization** — 🔲 **not started.** This is next: prove reconciliation between two local WayStation instances before ever touching real mesh/AREDN hardware.

---

## Revised development sequence (Phase A–F)

- **Phase A — Stabilize the current application.** Partial: real regression tests exist for the migration system and the new transport layer; Windows/Linux CI and packaging, first-run onboarding, and a full simulated offline/crash/long-duration exercise are still open.
- **Phase B — Operational object foundation.** ✅ **Done, 2026-09-01.** Object header, message + marker conversion, revision/provenance rules. WSP/1 documentation and serialization fixtures are the one piece of Phase B not yet done — worth finishing before Phase C's sync work needs it.
- **Phase C — Two-station communications proof.** 🔲 **Next up.** Build the durable queue + delivery-attempt history, derive the synchronous transport interface from the (now real) `Transport` implementations, build a unified traffic view, and prove `create → send → receive → acknowledge → reconcile → audit` between two local WayStation instances before ever touching physical mesh/AREDN. This is fully testable today with zero additional hardware.
- **Phase D — Incident operations.** 🔲 Not started. Incident workspace/lifecycle, personnel/teams/resources, structured SITREP, operational timeline, tactical map driven by incident objects.
- **Phase E — Software-complete application.** 🔲 Not started as a phase, though today's work is a down payment on its philosophy: build every hardware-facing capability against simulation/replay/fixtures so real equipment is never a blocker for finishing the software.
- **Phase F — Release candidate and tester deployment.** 🔲 Not started.

---

## Immediate next priorities

1. ~~**Operational object design**~~ — ✅ done 2026-09-01.
2. **Two-instance proof without new hardware** — run two isolated WayStation databases, exchange object summaries and requested objects over local TCP or files, prove deduplication/interrupt-resume/conflict/convergence, then reuse the exact same protocol later over physical mesh/AREDN. **This is the current priority.**
3. **WSP/1 test fixtures** — worth writing alongside or just before #2, since the two-instance proof needs *some* wire format to exchange objects over, even a minimal first version.
4. **Durable outbound queue with delivery-attempt history** — currently `dispatch_status` only tracks latest state; a real history (queued → route selected → transmitting → ack waiting → delivered, or failed → recalculate → try next path) is what Phase C's "audit" step actually needs.
5. **Current-state hardening** — CI/packaging, first-run onboarding, a full no-internet exercise on the existing application.

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

- **2026-09-01** — WayStation↔Citadel launch integration (`waystation://` deep link + single-instance), built and verified end-to-end. Canonical object header (v30 migration: uuid/revision/updated_at/incident_id/expires_at/trust_state on messages + map_markers). `Transport` trait, fully migrating all three real transports (mesh/Winlink/JS8Call) off the old hand-duplicated dispatch logic — a deliberate reversal of a 2026-08-29 decision to defer this exact abstraction, revisited because there were finally three real implementations to derive it from instead of designing it speculatively. This `ROADMAP.md` created, replacing the planning-PDF as WayStation's tracked source of truth.
