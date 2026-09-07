# Project Citadel + WayStation — Design Notes & Interface Direction

Captured 2026-09-07, transcribed verbatim from a design-notes PDF Frank produced (with help from another Claude session reviewing real mockup screenshots of both products) right as active feature development paused for the offline field test. Saved here rather than left as a file on the desktop specifically so it can't be lost the way the original Direwolf/APRS planning intent was earlier in this project (see ROADMAP.md's 2026-09-05 "Direwolf/APRS recovered into backlog" changelog entry) — this is v2 scope, not urgent, but real and worth keeping durable and versioned.

**Status: reference only. Nothing in this document is built or scheduled — see ROADMAP.md's "v2 backlog" for what's actually tracked as open work.** The mockup screenshots themselves (13 images, covering Flight Tracking, Scanner, Citadel's First Aid module, the Citadel banner, Activity, Tactical Map, Incident Ops, Messaging, Reference, Tools, Settings, Citadel's own command-center dashboard, and WayStation's Dashboard) contain additional concrete UI detail beyond what's transcribed below — those still need to be gone through page-by-page to pull out specific layout/interaction decisions when this work actually starts. This document is the prose direction; the images are the visual spec.

---

## Core architecture

**Project Citadel** is the overall off-grid platform: infrastructure, local services, storage, maps, knowledge, AI, home systems, logistics, medical support, education, media, and readiness.

**WayStation** is the communications and operations console inside that ecosystem: radio, messaging, EmComm, incident management, tactical awareness, weather, flight tracking, scanner monitoring, and radio activity.

> Citadel = infrastructure, readiness, resilience.
> WayStation = communications, coordination, operations.

The two products should share typography, card geometry, status semantics, and interaction patterns, while retaining distinct personalities. Citadel should remain subdued olive/industrial; WayStation can retain its tighter amber tactical/radio-command appearance.

## Shared visual design system

- Consistent status semantics across both products: green = healthy/online/ready; amber = warning/degraded/attention; red = offline/fault/error; gray = unknown/disabled.
- Share card geometry, typography hierarchy, form controls, buttons, badges, spacing, and interaction patterns.
- Citadel branding emphasizes off-grid readiness and infrastructure. WayStation branding emphasizes communications, coordination, and operational awareness.
- **Do not let attractive mockups become accidental backend specifications.** Every UI element must either map to a current real capability, clearly show a planned/unavailable state, or be explicitly identified as future functionality — the same "no fake data" discipline this project has followed all along, stated here as a formal design rule rather than just working practice.

---

## Project Citadel Home / Cockpit

- Keep the three-column module grid — it suits Citadel because the home screen is a launcher and health cockpit for several independent off-grid capabilities.
- Give the home screen a real operational purpose with an **Off-Grid Readiness score** rather than treating every module as equally important.
- Add a health strip for Power, Network, Storage, WayStation, Maps, Kiwix, AI, and Backup. Green = healthy/ready, amber = degraded/attention, red = fault/offline, gray = unknown/disabled.
- Show active modules subtly; elevate modules needing attention. A stale backup, failed map service, low storage, or unavailable WayStation service should be visible immediately.
- Keep the cockpit scratchpad — useful for quick mission notes, frequencies, coordinates, hand-off markers, and local reference information.
- Preferred naming: **Project Citadel - Command & Control Station.**
- **Education hub, added 2026-09-07:** the "Home Education Hub" tile should link out to [Cloud9](https://github.com/frankprobst5-stack/Cloud9) (a real, already-built homeschool desktop dashboard — Flask app, local AI assistant, dictionary, weather, planner, journal, video shelf, same card-grid layout as Citadel's own front page) rather than pointing straight at Kolibri as it does today. Kolibri itself drops down a level — it becomes just one more card inside Cloud9's own dashboard, alongside Cloud9's existing Dictionary/Journal/Video Shelf/etc. cards, rather than a standalone Citadel-level module in its own right.

## WayStation — overall direction

- Should feel like an integrated EmComm operations system, not a collection of unrelated radio widgets.
- Each page should answer an operational question quickly and should not imply backend capabilities that don't exist.
- Keep source, health, connection state, and data age visible everywhere. Graceful degradation is a major design principle: Online → Local → RF/Off-grid, wherever that's a real path.

## Scanner

- Do not design Scanner as a single-VFO SDR client unless WayStation later gains a true SDR pipeline — trunk-recorder is an automated multi-channel recorder, not GQRX.
- Scanner should be a status board for monitored systems/sites/talkgroups, active calls, recent recordings, decoder/SDR health, storage, and service status.
- Do not imply speech-to-text until a real transcription backend exists — ✅ Whisper.cpp shipped 2026-09-07, see ROADMAP.md. Transcription enhances completed recordings and search.
- If manual SDR tuning/spectrum/waterfall is ever built, make it a separate **SDR Console** rather than forcing it into Scanner.

## Flight Tracking

- Make this a flight situational-awareness console rather than a consumer flight-tracking clone.
- Primary layout: live map, selected-aircraft details, aircraft table, source/receiver status, filters, and operational alerts.
- Useful alerts: aircraft entering a configured radius, altitude thresholds, recurring sightings, and disappearance from tracking.
- Always identify whether data is network-fed, local ADS-B, or combined. Do not imply local 1090 MHz reception until that backend exists (it doesn't yet — real gap, see ROADMAP.md's "Built, but not yet proven in the field").

## Weather

- Preserve the three-tier concept: Online → Local → RF/Off-grid (already the real shape `weather_station.rs`/`nws.rs` follow).
- Overview should emphasize current conditions, radar, forecast, NWS alerts, local station data, source, and last-update age.
- Alerts should be first-class and able to surface in WayStation's global alert indicator and Tactical Map warning polygons.
- Do not show RF NOAA/SAME receiver status until the actual receiver/decoder backend exists (still `[PLANNED]`, hardware-blocked).

## Incident Ops

- Treat as the heart of WayStation — an incident command workspace, not a long page of forms.
- Suggested tabs: Overview, Timeline, Personnel, Resources, Requests, Tasks, SITREP, After Action.
- Once an incident is declared, messages, map markers, personnel, resource requests, scanner recordings, aircraft observations, and weather alerts should all be taggable to it.
- Preserve and promote **Prepare for Offline** — caching maps, weather, rosters, resources, communications plans, reference documents, and other incident-critical data.
- SITREP snapshots and timeline history are especially valuable for after-action records.

## Tactical Map

- Should be WayStation's common operating picture — incident markers, resources, personnel, mesh nodes, check-ins, weather polygons, and relevant aircraft converge here.
- Keep layer controls explicit so the map doesn't become cluttered; operators should be able to show only the layers relevant to the current incident.
- Offline map availability should be obvious, and the map should clearly show whether tiles are local or online.

## Radio Activity

- Rename **Activity** to **Radio Activity** if desired — the page has evolved into ham-radio operations intelligence.
- Keep space weather, propagation, POTA spots, PSKReporter/reception reports, satellite passes, and QSO logging together — they all answer "what can I work right now?"
- Suggested tabs: Overview, Space Weather, POTA Spots, Satellite Passes, Reception Reports, QSO Log, Settings.
- Possible integrations: POTA spot → rig frequency/mode where supported; reception report → Tactical Map; satellite pass → countdown/Doppler; severe space weather → WayStation alert.

## Messaging

- Should be a unified communications center without pretending every transport behaves like chat.
- Suggested tabs: Messages, Compose, Channels, Net Control, Winlink, JS8Call, Mesh, Templates, Settings.
- Top-level status cards should truthfully show states such as Mesh Connected, Pat Running, JS8Call Not Reachable, Direwolf Stopped/Receive Only — matches the honest-status convention already built throughout.
- Meshtastic is currently the strongest live-chat-like transport and deserves the main workspace: channels/conversations left, messages/composer center, nodes/network health right.
- Net Control deserves a full board: Callsign, Name, Grid/Location, Time In, Status, Assignment, Last Heard, Notes.
- Preserve ICS-213/ICS-309. Compose could eventually support Quick Message, ICS-213, and Formal Traffic, with supported traffic feeding a permanent communications log.
- Preset message templates reduce field typing: En route, Arrived on scene, Need resources, Stand by, All clear, Request weather update, etc.

## Reference

- The knowledge layer behind WayStation — should remain useful offline.
- Suggested tabs: Overview, Frequencies, Repeaters, WebSDR, Channel Directory, Field Library, Reference Docs, Bookmarks, Settings.
- Keep Kiwix as a major feature — locally stored field manuals, technical references, preparedness material, and other offline knowledge (already real, see `kiwix_search.rs`).
- Clearly distinguish built-in trusted reference data from operator-created channels, bookmarks, and directories.
- Future idea: Incident Reference Packs assembled by Prepare for Offline.

## Tools

- Organize into tabs: Overview, Radio Control, Antenna Tools, RF Calculators, Conversions, Utilities, Saved/History, Settings.
- Keep rigctld/rotctld controls honest about connection state and capabilities.
- Calculators should be deterministic, transparent about units/assumptions, and provide useful results without unnecessary visual complexity.
- Examples: antenna length, dB, SWR/impedance, RF power density, frequency conversions, bearing/distance.

## Settings

- Split into Overview, Station, Connections, Integrations, Appearance, Data & Storage, Diagnostics, Backup/Sync, About.
- Overview page: station identity, service health, appearance preview, quick actions, module status, and data management.
- Diagnostics should remain detailed but easier to scan: healthy/degraded/fault states, last success, source category, and actionable remediation.
- Backup should be prominent — a self-contained system needs visible backup age and easy export/restore.

## First Aid & Medical Support (Citadel)

A real, new subsystem — not yet started anywhere in either repo.

- Reframe as an offline medical support center rather than an AI-centered triage terminal.
- **Priority order: trusted offline references + structured checklists first; AI assistance second.**
- Suggested navigation: Overview, Triage, Emergency Guides, Conditions & Treatments, Procedures/Skills, Medications, Checklists, Patient Log, Resources Offline, AI Medical Assistant, Settings.
- Keep prominent emergency entry points for Massive Bleeding, Airway Block, Severe Burns, and Fractures, but route them into trusted structured guidance.
- Add a local **Patient Log** — patient entries, treatments, outcomes, export/backup.
- Add **Supplies & Inventory** — quantities, expiration dates, low-stock alerts, restock checklists.
- Add **Training & Drills** — illustrated skills, videos, scenarios, printable field cards, notes — useful before an emergency, not just during one.
- Add an **Emergency Mode** that strips the UI down to large, time-critical guidance and removes dashboard/configuration clutter.
- AI is supplemental guidance only. For medication arithmetic or dosage calculations, prefer deterministic calculators tied to vetted reference data with explicit units and assumptions — never let an LLM do dosage math.
- Design philosophy: **during normal times** — learn, inventory, and prepare. **During an emergency** — simplify, guide, and record.

---

## Design north star

Project Citadel should feel like a self-contained off-grid platform that can tell the operator whether the station is ready. WayStation should feel like the focused communications and incident-operations console that turns those local capabilities into situational awareness and coordinated action.

**Off-grid. On purpose.**
