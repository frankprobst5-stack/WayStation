# WSP/1 — WayStation Interchange Protocol, Version 1

This documents what's actually implemented in `app/src-tauri/src/sync.rs` (and, as of 2026-09-03, `app/src-tauri/src/net_sync.rs`) — not an aspirational design. Where something is deliberately not built yet, it's named explicitly below rather than left silently absent.

## What this is for

WSP is the wire format two WayStation instances use to exchange operational objects (currently: messages and map markers) and reconcile their local stores without either side trusting the other blindly. It's transport-agnostic by design — the reconciliation logic (`export_manifest`, `uuids_needed_from`, `export_objects`, `merge_incoming`) operates on plain Rust data with no assumption about how the bytes actually moved between two stations. Two real transports exist today: file exchange (see `export_manifest_to_file`, `import_objects_from_file`, etc., and the Settings → Peer Sync panel) and, as of 2026-09-03, an authenticated TCP transport (`net_sync.rs`, see "Transports" below) — both wrap the exact same reconciliation functions, same separation of concerns the `Transport` trait already established for outbound messages.

## Transports

**File exchange.** An operator exports to a file and hands it to the other station however they choose (USB drive, LAN share, etc.). The physical act of handing over the file *is* the consent — there's no separate authentication step, because there doesn't need to be one.

**TCP (`net_sync.rs`), added 2026-09-03.** A live network connection has no equivalent physical gesture, so it needs its own explicit gate: a connecting station must prove it knows a secret this station has already agreed to trust, or it gets nothing. Discovery (`discovery.rs`, mDNS) can tell an operator a station exists on the network; it is deliberately not permission to sync with it — see `ROADMAP.md`'s second non-negotiable principle. Concretely:

1. Client connects and sends `Hello { callsign, nonce, signature }`, where `signature` is an HMAC of `nonce` computed with the client's own signing secret (the same secret from "Signing" above).
2. Server looks up `callsign` in its `trusted_peers` table. No entry, or the signature doesn't match that entry's registered secret → `Rejected`, connection closed, nothing else exchanged. This is a real access-control gate, not just after-the-fact provenance checking — an unauthorized connection never sees a manifest, let alone object content.
3. On `Accepted`, both sides run the identical bidirectional exchange: swap manifests, swap requests for what each is missing, each side answers the other's request (objects signed the same way file exports are, via the same `wrap_objects`), each side merges what it receives.

On-demand sync ("Sync via Network," one click, one station) is always available regardless of the setting below. A separate, opt-in **automated background sync loop**, added 2026-09-04, closes the last item that used to be tracked here as not-yet-built: `auto_sync.rs` checks every 5 minutes for trusted peers who are *also* marked `auto_sync` in the `trusted_peers` table (migration v39) — a real, explicit, per-peer operator decision, off by default even for an existing trusted peer, since trusting someone enough to click Sync once by hand isn't the same as trusting them enough to sync with unattended, forever, on a timer. The second gate matters just as much as the first: a peer only becomes a real connect target if `discovery.rs` (mDNS) currently sees them on the network *right now* — being opted in is not permission to reach out to a stale address from an hour ago. Every attempt, success or failure, is recorded (`get_auto_sync_history`) and shown in the Peer Sync panel with a timestamp and outcome, so this runs unattended without running silently.

**Trust model limits, same as signing:** shared-secret-per-known-station, not a PKI. Adequate for a small, mutually-known circle. The nonce-signature handshake has no server-issued challenge (the client picks its own nonce) — fine for this trust model, but worth naming: it doesn't defend against a sophisticated replay attack the way a server-issued challenge would. Real work if this protocol is ever exposed beyond a trusted LAN.

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
  "entries": [ ... SyncObject ... ],
  "signature": "a3f9...  (or absent/null — see Signing below)"
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

## Signing

Added 2026-09-03. Closes a real gap: anyone can transmit on an open RF path and claim to be any callsign, and until now nothing could tell a genuine object from a forged one.

**Trust model — shared secret per known station, not a PKI.** Each station generates its own signing secret (`get_or_create_signing_secret`, once, on first use — never silently regenerated). The operator shares that secret with people they trust, out-of-band — voice, in person, anything other than the sync channel itself, since sending it alongside the data it's meant to authenticate would defeat the point. Each recipient registers it under the sender's callsign in their own `trusted_peers` table (`add_trusted_peer`). This is deliberately small-circle trust, adequate for a family/friends net where everyone has actually talked to everyone else — it is not designed for an open or public network, and does not by itself prove non-repudiation (anyone holding a station's secret can sign as that station until the secret is rotated; rotation isn't built yet, see below).

**What gets signed.** Only the `Objects` envelope — a `Manifest` carries no content worth forging, nothing from it ever gets merged into a database. The signature is an HMAC-SHA256 over `wsp_version` + `origin_callsign` + `generated_at` + `entries`, computed with the sender's own secret, hex-encoded into the envelope's `signature` field.

**Backward compatible, not a version bump.** `signature` is an additive field (`#[serde(default)]`) — a WSP/1 file written before signing existed still parses cleanly, just with `signature: None`, read honestly as *unsigned* rather than rejected. No `wsp_version` change was needed.

**Verification outcomes (`SignatureStatus`), surfaced not enforced:**

| Status | Meaning |
|---|---|
| `verified` | Recomputing the signature with the claimed signer's registered secret matches exactly. |
| `unsigned` | No signature present at all — sender never generated a secret, or this predates signing. |
| `unknown_signer` | No `origin_callsign`, or that callsign has no registered secret in `trusted_peers` — this station has never exchanged keys with whoever (claims to have) sent this. |
| `invalid` | A signature is present, the signer is known, but it doesn't match — the content was altered after signing, or a different secret than the registered one was used. Treated the same regardless of which cause. |

A merge always proceeds regardless of `SignatureStatus` — matching this protocol's standing rule (see "Merge semantics" above): flag, don't guess, and don't silently decide something on the operator's behalf. `import_objects_from_file` returns the status on `MergeReport`, and the Peer Sync panel shows it prominently on every import, `invalid` and `unknown_signer` visually distinct from `verified`. Blocking or requiring an explicit override on an untrusted import is real future work, not built here — this pass gets the *information* in front of the operator honestly; deciding what to do with an unverified import is still on them.

**Explicitly not built:** secret rotation (replacing a compromised or accidentally-shared secret currently means re-distributing a new one to everyone who had the old one, by hand, same as first exchange), per-object signing (only the whole envelope, not each message/marker individually — fine for a file exchange, would matter more once objects move independently over a bandwidth-constrained link), and any enforcement/blocking behavior on a bad signature.

## What's not in WSP/1

Named explicitly, not silently missing:

- **Compact/binary encoding.** Today's wire format is readable JSON. The original planning notes describe a fragmentable, compressed format for constrained RF links — that's real, deliberately deferred work. Building it now, before any real bandwidth-constrained transport exists to exercise it, would repeat the exact premature-abstraction mistake this codebase already learned not to make once (see `transport.rs`'s own history: a shared `Transport` trait was rightly deferred until there were three real implementations to derive it from, not designed speculatively). When a real constrained-link transport exists, that's WSP/2's job, and the version check above is what makes that a clean upgrade instead of a silent incompatibility.
- **Fragmentation/reassembly.** Not needed by a file exchange with no message-size limit. Real work once an RF transport with a real payload ceiling (JS8Call, packet) carries this protocol.
- **TTL / multi-hop forwarding.** Today's exchange is strictly station-to-station. A relay/forwarding model for multi-hop mesh delivery is unbuilt.
- **Object types beyond messages and markers.** Alert, station, team, assignment, acknowledgement, and status-event objects don't have the canonical header yet, so they're not syncable today. (Incident, personnel, resource_request, and SITREP *do* have the header as of Phase D, but aren't wired into `sync.rs`'s `ObjectKind`/`SyncObject` yet — the header existing on a table isn't the same as this protocol knowing how to sync it.)

## Where this lives in code

- `app/src-tauri/src/sync.rs` — the envelope, reconciliation logic, signing, and the file transport.
- `app/src-tauri/src/net_sync.rs` — the TCP transport and its authentication handshake. `sync_with_peer_conn` is the plain-`&Connection` core both the operator-triggered command and `auto_sync.rs`'s poller call.
- `app/src-tauri/src/discovery.rs` — mDNS peer discovery (not part of WSP/1 itself; a separate concern that feeds `net_sync.rs` an address to connect to).
- `app/src-tauri/src/auto_sync.rs` — the automated background sync loop: opt-in flag check, discovery-presence check, the timer, and the visible activity history.
- `app/src-tauri/src/db.rs` — `signing_secret` (station_profile), `trusted_peers` table and CRUD including `auto_sync` (v38/v39 migrations).
- `app/src/panels/SyncPanel.tsx` — the one current consumer (Settings → Peer Sync): export/import, signing-secret display, trusted-peer management with per-peer auto-sync toggle, discovered-peers list, "Sync via Network," automated-sync activity history, signature status on every import regardless of transport.
- Tests: `sync::tests` — 12 tests covering convergence, staleness, conflict detection, the envelope itself, and signing (valid/tampered/unknown-signer/legacy-unsigned). `net_sync::tests` — 6 tests covering the auth handshake (accept/reject cases) and a real bidirectional convergence over an actual TCP socket on loopback. `discovery::tests` — 1 test, real advertise-then-browse over loopback. `auto_sync::tests` — 6 tests covering the eligibility decision (opted-in-but-not-discovered, discovered-but-not-opted-in, case-insensitive matching, mixed lists). `db::tests` — secret generation/persistence, trusted-peer CRUD, and auto_sync flag defaults/toggling/persistence-through-secret-rotation.
