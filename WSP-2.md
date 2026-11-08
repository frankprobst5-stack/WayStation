# WSP/2 — Compact binary encoding + mesh fragmentation

This documents what's actually implemented in `app/src-tauri/src/wsp2.rs`, `mesh.rs`, and
`MeshPanel.tsx` — not an aspirational design, the same real distinction `WSP-1.md` draws for
itself. `WSP-1.md`'s own "What's not in WSP/1" section named this explicitly as deferred
work, and the deferral reasoning (`transport.rs`'s own history: a shared abstraction waits
for a real need, not speculative design) is exactly why this wasn't written until a real
bandwidth-constrained transport — mesh — needed it.

**Status, 2026-11-08: manifest send + receive is real and live-hardware-tested, the wider
WSP/1 sync loop is not.** The codec, fragmenter, and a real send/receive path through
`mesh.rs` on a dedicated Meshtastic port all exist and are exercised against this machine's
actually-running `meshtasticd` — not just compiled. What isn't built yet is named precisely
in "What this doesn't do yet" below; read that section before assuming more is finished
than is.

## The real constraint this is sized against

Checked directly against the `meshtastic` crate's own generated protobuf
(`~/.cargo/registry/.../meshtastic-0.1.9/src/generated/meshtastic.rs`), not assumed:

```rust
pub enum Constants {
    Zero = 0,
    /// note: this payload length is ONLY the bytes that are sent inside of the Data
    /// protobuf (excluding protobuf overhead). The 16 byte header is outside of this envelope
    DataPayloadLen = 233,
}
```

**233 bytes is the real over-the-air ceiling for one `Data.payload`.** This is a materially
different (smaller) number than `mesh.rs`'s own `MAX_PACKET_LEN = 512` constant —
confirmed by reading `mesh.rs` directly: that 512 is the local TCP **client-API's** resync
threshold talking to `meshtasticd` on this machine (`"per the client-api doc: >512 assumed
corrupted, resync"`), not a real RF constraint. **Real gap this surfaced, unrelated to
WSP/2 itself**: nothing in `send_mesh_text`/`MeshTransport::send` today checks an outbound
payload against the real 233-byte ceiling before sending — a long ICS-213 message body
sent over mesh right now could silently exceed what real hardware can actually carry over
the air, even though it sends without error against the local simulated `meshtasticd` (the
simulator accepts anything under 512 at the client-API layer). Worth a small, separate fix
regardless of whether WSP/2 ships: `MeshTransport::send` should refuse (or this work should
let it fragment) anything over 233 bytes rather than trusting the 512-byte local check.

## Scope of this first real increment

Fragmentation is useless without something smaller to fragment, so this increment ships
both together, but deliberately only for **manifests** — not the full `Objects` envelope
(message/marker bodies) yet. Reasoning: a manifest exchange has to succeed before anything
else in WSP/1's granular protocol (`export_manifest` → `uuids_needed_from` → `export_objects`
→ `merge_incoming`) can proceed at all, so it's the real minimum slice that makes "WSP/1
sync over mesh" mean anything. Objects encoding is a real, named follow-on once this is
proven, not forgotten — see "What this doesn't do yet" below.

## Compact binary manifest encoding

Hand-written, explicit byte layout — no new serialization dependency (`bincode`/`postcard`
aren't in `Cargo.toml` today) — matching this codebase's existing convention of hand-rolled
wire framing when exact byte layout matters (`mesh.rs`'s own `START1`/`START2`/length-prefix
framing, `net_sync.rs`'s handshake), not a speculative abstraction.

Two real savings over WSP/1's JSON form, both grounded in how these fields are actually
generated (`db.rs`):

- **`uuid`**: WSP/1 carries `uuid::Uuid::new_v4().to_string()` — the 36-character dashed
  form. It's a real 16-byte value underneath (`Uuid::as_bytes()`); WSP/2 carries the 16 raw
  bytes, not the string.
- **`content_hash`**: WSP/1 carries `format!("{:x}", hasher.finalize())` — a SHA256,
  hex-encoded to 64 characters. WSP/2 carries the real 32 raw bytes.
- **`updated_at`** is dropped entirely from the compact wire form. `WSP-1.md` itself says
  this field is diagnostic only, "**not** the comparison key" — confirmed in
  `uuids_needed_from`, which reads only `revision` and `content_hash`. Sync correctness
  doesn't depend on it, so it costs nothing to leave off the wire and saves real bytes on a
  link where every byte is fragmentation overhead.

**Layout** (all multi-byte integers big-endian, matching `mesh.rs`'s own existing
length-prefix convention):

```
byte 0:       wsp_version = 2
byte 1:       wsp_kind = 0 (manifest)
byte 2:       origin_callsign_len (u8, 0 if none)
bytes:        origin_callsign (utf8, origin_callsign_len bytes)
bytes (8):    generated_at (i64 unix timestamp, not an RFC3339 string)
bytes (2):    entry_count (u16)
per entry:
  bytes (16): uuid (raw bytes, not the dashed string)
  byte:       kind (0 = message, 1 = marker)
  varint:     revision (LEB128 — real revisions stay small; most fit in 1 byte)
  byte:       content_hash_present (0 or 1)
  bytes (32): content_hash — only present when the flag above is 1
```

One manifest entry costs **~51 bytes** when a content hash is present (16 uuid + 1 kind +
1-2 revision varint + 1 hash-present flag + 32 hash), or **~19 bytes** when it isn't — e.g.
a fresh marker's first-ever manifest line before any edit. **Real measured comparison**
(`wsp2::tests::binary_manifest_is_substantially_smaller_than_the_equivalent_wsp1_json`,
run directly, not estimated): a 2-entry manifest with a callsign and both content hashes
present encodes to **121 bytes** in WSP/2's binary form versus **507 bytes** as WSP/1's
real JSON (`serde_json`-serialized, the exact shape `sync.rs`'s `WspEnvelope::Manifest`
produces) — a measured **4.2x reduction**, better than the back-of-envelope ~3x this
section first estimated before actually measuring it.

## Fragmentation

Content-agnostic — it fragments any byte blob, so the same framer carries a binary
manifest now and a binary `Objects` envelope later without redesign.

```
byte 0:       frame_type (0 = whole, fits in one packet; 1 = fragment)
if whole:     remaining bytes = the complete payload
if fragment:
  bytes (4):  msg_id (u32) — identifies which logical payload this fragment belongs to
  byte:       frag_index (u8)
  byte:       frag_total (u8)
  remaining:  this fragment's chunk
```

Fragment header cost: 7 bytes, leaving **226 real bytes** of payload per fragment inside
the 233-byte ceiling. `frag_total` as `u8` caps a single logical payload at 255 × 226 ≈
57,000 bytes — comfortably past anything this app's real manifest sizes need (dozens to
low hundreds of messages/markers per station, not tens of thousands); not designed to
scale past that, deliberately, since nothing in this app's real data shape needs it to.

## Acknowledgement: reusing the firmware's own ACK, not reinventing one

`mesh.rs` already has real, working per-packet delivery confirmation: `MeshPacket.want_ack`
triggers a `RoutingApp` response the firmware sends back, already wired into
`handle_mesh_packet` → `db::set_mesh_message_status` (`"delivered"`/`"failed"`, with a real
reason via `routing_error_text`). **WSP/2's fragment-level "sliding-window ack" is this same
mechanism, not a new one** — each fragment packet sets `want_ack: true` and carries its own
`packet_id`; a reassembler tracks which `frag_index` values have been confirmed delivered
by the firmware's own routing response, and only the unconfirmed indices get retransmitted.
This matches this codebase's established "orchestrate, don't reimplement" instinct (the
same reasoning that kept this app from hand-rolling SGP4 or Meshtastic's own protobuf
types) — Meshtastic's firmware already does real per-hop retry and delivery confirmation;
building a parallel TCP-style ack/retransmit protocol on top would duplicate what the radio
already proves out, not improve on it.

## Where this fits the `Transport` trait — decided and wired, 2026-11-08

**Bypasses `Transport` entirely, by deliberate choice, not oversight.** `transport.rs`'s
`Transport` trait and its `OutboundEnvelope`/`Payload` shape are for fire-and-forget
operator content — one ICS message or marker, one destination, one send call. WSP/1 sync is
a different real shape: protocol-level reconciliation, already handled by two existing,
independent, non-`Transport` implementations (`sync.rs`'s file exchange, `net_sync.rs`'s
TCP transport). Mesh-sync follows that same precedent rather than bending `Transport` to
fit a use case it wasn't shaped for.

**Real wiring, in `mesh.rs`:**
- **Send** — `sync_manifest_over_mesh` (a new `#[tauri::command]`): calls `sync::
  export_manifest` (the exact function `net_sync.rs`'s TCP transport already uses),
  `wsp2::encode_manifest`, then `wsp2::fragment`, and sends every resulting frame as its
  own `MeshPacket` with `want_ack: true`.
- **Receive** — `handle_mesh_packet` gained a new branch for `PortNum::PrivateApp` (see
  below) that feeds each incoming frame into a `Reassembler` held on `MeshState`; a
  completed payload is decoded via `wsp2::decode_manifest` and appended to a bounded
  (20-entry) history, with a `mesh-manifest-received` event emitted so the frontend doesn't
  have to poll.
- **The real port**: `PortNum::PrivateApp = 256`, not `TextMessageApp`. Checked the
  `meshtastic` crate's own protobuf doc comment directly: *"Private applications should use
  portnums >= 256... you can use 'PRIVATE_APP'"* — Meshtastic's firmware itself reserves
  this range for exactly this kind of traffic. Using it (rather than smuggling binary bytes
  through the text-chat port, which would need escaping to survive `handle_mesh_packet`'s
  existing `String::from_utf8` path) keeps WSP/2 frames structurally distinct from chat
  messages and `WSPIN|...` marker pins — no tagging byte or shared-port disambiguation
  needed.
- **Frontend** — `MeshPanel.tsx` gained a "Sync Manifest" quick action (reports how many
  fragments were sent, or a real error) and a "Received Manifests (WSP/2)" list in the
  right rail (origin callsign, entry count, received-at, refreshed live off the
  `mesh-manifest-received` event).

**Real verification, not just a clean compile**: `cargo test --lib` — 162 passing, 11
live-hardware tests correctly `#[ignore]`d by default. Three of those (including a new one,
`sending_a_real_wsp2_manifest_fragment_on_private_app_does_not_error`) were actually run
with `--ignored` against this machine's real, already-running `meshtasticd` and passed —
real fragments, real socket, real framing, not simulated. Frontend: `tsc --noEmit` clean.
Full live click-through in a browser wasn't done — this app's own Tauri `invoke()` setup
call has no bridge outside the real Tauri shell, and getting one means `npm run tauri dev`,
which this project's own established rule says not to relaunch casually (it re-registers
the deep-link scheme against the debug binary, undoing a real fix from an earlier session)
— so that gap is named honestly here rather than silently skipped.

## What this doesn't do yet

Named explicitly, matching `WSP-1.md`'s own convention:

- **`Objects` envelope binary encoding.** This increment covers manifests only — the actual
  message/marker content exchange still needs its own compact encoding, a larger task since
  object bodies (message text, marker labels) don't compress the same predictable way fixed-
  width fields do.
- **The object-request follow-up.** Receiving a manifest doesn't trigger `uuids_needed_from`
  against it, request the missing objects back, or call `merge_incoming` — a received
  manifest is decoded, counted, and shown, not yet acted on. This is the real gap between
  "a manifest can travel over mesh" (done) and "WSP/1 sync runs over mesh" (not yet) — the
  full bidirectional loop `net_sync.rs` already runs over TCP, ported to a fragmented,
  per-port mesh connection instead of a raw socket.
- **Fragment-specific retransmission.** `missing_fragments` exists and is tested in
  isolation, but nothing in `mesh.rs` calls it yet — reliability today comes entirely from
  `want_ack` triggering the firmware's own per-packet retry, not from this app asking for a
  specific missing index back. Real, named follow-on if firmware-level retry alone proves
  insufficient in practice.
- **TTL / multi-hop forwarding at the WSP/1 semantic level.** Meshtastic's firmware already
  relays packets hop-to-hop on its own; this is about whether WSP/1's own manifest/merge
  exchange itself understands "relay this sync request through an intermediate station,"
  which it still doesn't — unchanged from `WSP-1.md`'s own "What's not in WSP/1" list.
- **The 233-byte un-checked-today gap** named above in long single-shot mesh messages
  (`IcsMessage`/`Marker` payloads) — real, pre-existing, surfaced by this investigation, not
  fixed here.
- **Two-station live verification.** Everything tested so far runs against one real
  `meshtasticd` instance — send-path framing confirmed live, receive-path reassembly/decode
  confirmed by unit test only. A second real node (or a second `meshtasticd --sim`
  instance — already found, elsewhere in this codebase, to be fully RF-isolated from a
  first one with no shared virtual medium) is needed to prove an actual station-to-station
  manifest hand-off, not just this station's own send and decode logic in isolation.

## Where this lives in code

- `app/src-tauri/src/wsp2.rs` — the binary manifest codec (`encode_manifest`/
  `decode_manifest`) and the fragmenter/reassembler (`fragment`/`Reassembler`). Real unit
  tests: round-trip encoding with and without a content hash, a measured JSON-vs-binary size
  comparison against real sample data, fragmenting a payload larger than one packet and
  reassembling it byte-for-byte (in order and out of order), and confirming the reassembler
  correctly reports which fragment indices are still missing.
- `app/src-tauri/src/mesh.rs` — `MeshState.manifest_reassembler`/`received_manifests`
  (new fields), `handle_mesh_packet`'s `PortNum::PrivateApp` branch (receive), and the two
  new commands `sync_manifest_over_mesh` (send) and `get_received_mesh_manifests` (read the
  history). New live-hardware test:
  `sending_a_real_wsp2_manifest_fragment_on_private_app_does_not_error` (`#[ignore]`d,
  needs a real `meshtasticd` — run with `cargo test -- --ignored`).
- `app/src/panels/MeshPanel.tsx` — the "Sync Manifest" quick-action button and the
  "Received Manifests (WSP/2)" list in the right rail, listening for `mesh-manifest-received`.
- `app/src-tauri/src/lib.rs` — `mod wsp2;` and the two new commands registered in the
  Tauri `invoke_handler`.
