<p align="center">
  <img src="brand/logo.png" alt="Citadel Ecosystem" width="360">
</p>

# WayStation

**Online for awareness. Offline for operations. Built to shine when the grid goes down.**

WayStation is an offline-first communications and field-operations desktop app for amateur radio, emergency communications, preparedness, and resilient local coordination. It's not a collection of ham-radio panels bolted together — its real operational loop is:

**OBSERVE → UNDERSTAND → DECIDE → COMMUNICATE → DOCUMENT → SYNCHRONIZE**

Online connectivity enriches the local operational picture while it's available. When connectivity degrades, WayStation retains cached information with honest age and provenance instead of pretending it's live. When the grid fails entirely, live RF, local hardware, nearby peers, and locally stored operational data take over — grid-down mode is the environment this app exists to serve, not a crippled fallback for when the "real" online version stops working.

<p align="center">
  <img src="screenshots/dashboard-overview.png" alt="WayStation's main dashboard, showing operational status, tactical map, and incident status" width="800">
</p>

---

## Status: public release, post-field-test

This is a genuine, working build — not a prototype. Under the hood: a Rust/Tauri backend with 200+ automated tests, 50+ real panels (net control, ICS-style incident forms, mesh networking, Winlink, JS8Call, rig/rotator control, flight and satellite tracking, propagation and space-weather data, and more), and an honest internal status taxonomy that this project's own [ROADMAP.md](ROADMAP.md) uses to track exactly what's verified versus still rough.

The real month-long offline field trial that gated earlier releases concluded 2026-09-24 (about two weeks ahead of schedule, no crashes or data loss beyond what's already fixed) — this release reflects real feature work that landed afterward, not just the field-tested baseline:

- **A real pick-your-capability module system** (Settings → Modules): every transport (Mesh, Winlink, JS8Call, Packet/APRS, ATAK/CoT, Rig, Rotator) can be switched off individually — off means WayStation opens no connection and does no polling for that capability, not just a hidden tab.
- **WSP/2 compact mesh sync, now with full reconciliation**: manifests travel over Meshtastic as compact binary fragments sized to the real 233-byte over-the-air ceiling, and a station that receives one now automatically pulls back whatever it's missing and merges it — the same conflict detection and signature verification every other sync transport (file, authenticated TCP) already has.
- **QR-code packet transport**: turn a message into 4 QR-code panels another device just photographs — zero radio, zero network. Any 3 of the 4 panels fully reconstruct it. Wire-compatible with Keith B. Phillips's own [qrcoder](https://github.com/keithbphillips/qrcoder) apps, not just similar to them.
- **ATAK/CoT interoperability**: exchanges position data directly with ATAK/WinTAK over their own real default network broadcast — no server, no account, nothing to install on the ATAK side.
- A flight-tracking trail line, a tactical-shorthand compressor for mesh messages, and real Critical Resource (Power/Water/Food) status chips.

Known, honestly-disclosed gaps as of this release:

- **No macOS build exists yet** — only Windows and Linux installers are produced by this release.
- Multi-node mesh networking is real and tested in isolation, but genuinely unverified with a second physical node in the field — see ROADMAP.md's own status tags for the full, current picture of what's BUILT+VERIFIED versus BUILT-BUT-HARDWARE-PENDING.
- ATAK/CoT interoperability covers position/situational data, not GeoChat (a separate, more involved CoT shape with its own delivery-ack handshake) and not a TAK Server/TLS path — LAN broadcast only, the zero-configuration case.

If you hit something broken, that's exactly what this release is for — please report it.

---

## Screenshots

<p align="center">
  <img src="screenshots/dashboard-comms-weather.png" alt="WayStation's radio/rotator control, communications status, space weather HF conditions, and local weather panels" width="800">
</p>

Radio and rotator control, live communications status, real HF propagation conditions from actual space-weather data, and local weather — all on the same dashboard, all degrading honestly when a data source isn't reachable rather than showing stale numbers as if they were current.

---

## Requirements

- **Windows 10/11**, or **Ubuntu 22.04 or newer** (or a compatible Linux distro — the `.deb` and `.AppImage` builds are produced on Ubuntu 22.04's toolchain).
- No installed dependencies needed for the packaged installer — Tauri bundles everything required.
- **Citadel is optional, not required.** WayStation is built to work standalone; a handful of features (live map tiles, an AI narrative assistant, offline encyclopedia search) enrich themselves automatically if a [Citadel](https://github.com/frankprobst5-stack/Project-Citadel) instance is reachable on your network, and fall back gracefully (verified directly in the source, not just assumed) if one isn't. You do not need to install Citadel first.

## Installing

Grab the installer for your platform from this repo's **[Releases page](../../releases)**:
- **Windows**: download and run the `.msi`.
- **Linux**: download the `.deb` (Debian/Ubuntu) or the `.AppImage` (most other distros — make it executable and run it directly, no install needed).

These installers are unsigned (no code-signing certificate is configured yet), so Windows SmartScreen or your Linux distro's package manager may warn before running them the first time — expected for this project at its current size, not a sign anything's wrong.

### Building from source instead

```bash
git clone https://github.com/frankprobst5-stack/WayStation.git
cd WayStation/app
npm install
npm run tauri build
```
Needs Node 22+ and a Rust toolchain, plus Tauri's own system dependencies (`libwebkit2gtk-4.1-dev` etc. on Linux — see [Tauri's prerequisites guide](https://tauri.app/start/prerequisites/)).

## Learn more

- **[ROADMAP.md](ROADMAP.md)** is this project's real, running engineering log — what's built and verified, what's built but hardware-pending, what's still planned, written honestly rather than aspirationally.
- Once WayStation is running, its own **User Manual panel** (in-app) covers day-to-day usage for every feature.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE) if present, or the license header in [app/package.json](app/package.json).

**Important:** This covers WayStation's own original code only (everything under `app/src` and `app/src-tauri/src`) — it does not relicense anything else. Real third-party dependencies (MapLibre GL JS, PMTiles, protomaps-themes-base, React, and everything else in [app/package.json](app/package.json)) are pulled in through the normal npm package manager, not manually copied into this repo, and each keeps its own license as published — verified directly, not assumed: MapLibre GL JS, PMTiles, and protomaps-themes-base are all BSD-3-Clause; React/React-DOM are MIT. See [Citadel's THIRD_PARTY_LICENSES.md](https://github.com/frankprobst5-stack/Project-Citadel/blob/main/THIRD_PARTY_LICENSES.md) for the same libraries' real copyright holders and sources — WayStation depends on the identical set, just via npm rather than a manually-vendored copy.
