# WSP/1 — WayStation Interchange Protocol, Version 1

This documents what's actually implemented in `app/src-tauri/src/sync.rs` as of 2026-09-02 — not an aspirational design. Where something is deliberately not built yet, it's named explicitly below rather than left silently absent.

## What this is for

WSP is the wire format two WayStation instances use to exchange operational objects (currently: messages and map markers) and reconcile their local stores without either side trusting the other blindly. It's transport-agnostic by design — the reconciliation logic (`export_manifest`, `uuids_needed_from`, `export_objects`, `merge_incoming`) operates on plain Rust data with no assumption about how the bytes actually moved between two stations. File exchange is the first real transport (see `export_manifest_to_file`, `import_objects_from_file`, etc., and the Settings → Peer Sync panel). A local TCP listener, or eventually a real mesh/AREDN link, wraps the exact same functions later — same separation of concerns the `Transport` trait already established for outbound messages.

## The envelope

Every file this protocol produces is a `WspEnvelope`, never a bare array. Two variants, distinguished by a `wsp_kind` tag:

```json
{
  "wsp_kind": "manifest",
  "wsp_version": 1,
  "origin_callsign": "KJ4ESQ",
  "generated_at": "2026-09-02T14:30:00Z",
  "entries": [ ... ManifestEntry ... ]
}
```

```json
{
  "wsp_kind": "objects",
  "wsp_version": 1,
  "origin_callsign": "KJ4ESQ",
  "generated_at": "2026-09-02T14:31:12Z",
  "entries": [ ... SyncObject ... ]
}
```

`wsp_version` and `wsp_kind` exist so that (a) a future format change is a clean, detectable rejection — "this file uses WSP/2, update WayStation" — instead of a confusing deserialize panic, and (b) a manifest file handed to something expecting an objects file (or vice versa) fails with a clear message rather than silently misparsing. `origin_callsign` and `generated_at` exist for the same reason provenance exists everywhere else in this app: looking at an old sync file, or troubleshooting a failed import, an operator should be able to tell who made it and when without guessing.

## Object identity

Every synced object carries the canonical header introduced in the v30 database migration:

| Field | Meaning |
|---|---|
| `uuid` | Stable identity across every station's database — never the local integer `id`, which is only unique within one database and will collide the moment more than one station exists. |
| `revision` | Increments on edit. The primary signal the diff step uses to decide what's newer. |
| `updated_at` | Human-readable timestamp, rides along for diagnostics — **not** the comparison key. Clock skew between two stations is a real, expected condition this protocol has to survive; revision numbers, which only ever move forward on the station that owns the edit, don't have that problem. |
| `content_hash` | Carried in the manifest itself, not just the full object — see "Conflict detection" below for why. |
| `trust_state` | Forced to `'received'` on import regardless of what the incoming object claims about itself. A peer's claim about its own trust level is never taken at face value; only a station's own database can call something `'local'`. |

## The exchange sequence

Two forms exist today:

**Granular (the real protocol):** `export_manifest` → peer runs `uuids_needed_from` against it → peer requests only what it's actually missing or behind on via `export_objects` → `merge_incoming`. This is what matters once a transport has real bandwidth constraints — sending objects the peer already has is meaningful waste on a slow RF link.

**Combined (`export_full_bundle_to_file` / the Peer Sync panel's default):** skips straight to exporting every current object and importing the whole thing. This is *not* a shortcut around correctness — `merge_incoming` already safely no-ops on anything the importing side doesn't need (see "Merge semantics" below) — it just doesn't force an operator through a multi-file round trip over a transport (files) that has no real bandwidth constraint to optimize against. The granular path exists and is tested for when it's actually needed.

## Conflict detection

`uuids_needed_from` flags a uuid as needed when: the local side doesn't have it at all, the remote's revision is strictly ahead, **or** both sides claim the same revision but disagree on `content_hash`. That third case is the one worth being explicit about — without the hash riding along in the lightweight manifest, two stations sitting at the same revision with genuinely different content (two operators editing offline, unaware of each other) would look identical at the manifest level, and would never even get fetched for comparison. Including the hash there is what makes a real conflict detectable during normal sync, not just in a test that force-feeds full objects past the diff step.

## Merge semantics

Given an incoming object, `merge_incoming` does exactly one of:

- **Insert** — uuid unknown locally.
- **Adopt** — incoming revision strictly ahead of the local copy.
- **No-op** — same revision, same content hash. Already converged.
- **Flag as a conflict, change nothing** — same revision, different content hash. This is the one case that does not resolve itself. No last-write-wins, no arbitrary tie-break. An operator has to look at it. The uuid is reported back in the `MergeReport`; nothing about the local object is touched.
- **Ignore** — incoming revision behind the local copy. The local side is already ahead and does not regress because a peer's manifest was stale.

Re-running an already-converged exchange is a clean no-op end to end — this is what makes the protocol safe against an interrupted transfer being retried, or the same file being handed to a station twice.

## What's not in WSP/1

Named explicitly, not silently missing:

- **Compact/binary encoding.** Today's wire format is readable JSON. The original planning notes describe a fragmentable, compressed format for constrained RF links — that's real, deliberately deferred work. Building it now, before any real bandwidth-constrained transport exists to exercise it, would repeat the exact premature-abstraction mistake this codebase already learned not to make once (see `transport.rs`'s own history: a shared `Transport` trait was rightly deferred until there were three real implementations to derive it from, not designed speculatively). When a real constrained-link transport exists, that's WSP/2's job, and the version check above is what makes that a clean upgrade instead of a silent incompatibility.
- **Fragmentation/reassembly.** Not needed by a file exchange with no message-size limit. Real work once an RF transport with a real payload ceiling (JS8Call, packet) carries this protocol.
- **Signing / authentication.** Nothing here proves an object actually came from the callsign it claims. Real work, and genuinely worth doing before this protocol is trusted over an open RF path where anyone can transmit.
- **TTL / multi-hop forwarding.** Today's exchange is strictly station-to-station. A relay/forwarding model for multi-hop mesh delivery is unbuilt.
- **Object types beyond messages and markers.** Alert, station, person, team, resource, request, assignment, incident, SITREP, acknowledgement, and status-event objects don't have the canonical header yet, so none of them are syncable today.

## Where this lives in code

- `app/src-tauri/src/sync.rs` — everything above.
- `app/src/panels/SyncPanel.tsx` — the one current consumer (Settings → Peer Sync).
- Tests: `sync::tests` — 7 tests covering convergence, staleness, conflict detection, and the envelope itself (round-trip, version rejection, kind-mismatch rejection).
