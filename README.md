# Watch2Gether

Free, self-hosted watch-party app. No accounts, no uploads. Anyone can create a
room; the host picks a local video file and it streams peer-to-peer, straight
from their browser to everyone else's — Cloudflare only hosts the website and
relays signaling messages, it never touches the video itself.

## How it works

- **Rooms** are created on demand — no deploy step per room, no server restart.
  A [Durable Object](https://developers.cloudflare.com/durable-objects/) holds
  each room's state and WebSocket connections.
- **Video** never leaves a peer-to-peer connection: the host loads a local
  file into a hidden `<video>` element, captures it as a live stream
  (`captureStream()`), and sends it directly to each viewer over WebRTC. There
  is no upload, no storage, no per-GB cost.
- **Playback control** always happens on the host's actual video element —
  viewers with permission send a play/pause/seek *request* that the host
  executes, which then naturally propagates to everyone through the live
  stream. Both host and viewer get a custom control bar (`video-player.js`) —
  scrubbable progress, volume, fullscreen, picture-in-picture, and (host only)
  playback speed — instead of the browser's native `<video controls>`.
- **Chat** and **voice** run over the same WebSocket/WebRTC connections —
  chat is relayed and kept as a capped history per room; voice is a full mesh
  of small audio-only peer connections between everyone present.
- **Subtitles**: when the host loads a `.srt`/`.vtt` file it's shared with
  everyone automatically (relayed through the room, capped at ~300KB, never
  stored anywhere else) — rendered as an overlay timed against the host's
  broadcast position. A viewer can still load their own local file instead,
  which always takes priority over whatever the host shares.
- **Moderation** is host-only: lock the room against new joiners, cap max
  participants, turn chat or voice off for everyone, and kick or ban
  individual people. A kick just disconnects them (they can rejoin); a ban
  blocks their IP from rejoining this room. There are no accounts, so a ban
  is the strongest tool available — it isn't unbeatable against someone who
  changes networks, same as any link-based tool with no login.
- **Screen wake lock** keeps the device awake while a room is open, released
  automatically when the tab is hidden or the room is left.
- **Drift-corrected sync**: every viewer measures its own natural latency to
  the host once (this is *not* the same for everyone — someone across the
  ocean will always have a bit more than someone in the next room, that's
  physics, not a bug) and then holds itself to that baseline for the rest of
  the session with tiny playbackRate nudges (±5%, never a seek or a stutter).
  Without this, WebRTC's jitter buffer drifting under changing network
  conditions would let two viewers silently end up seconds apart after a long
  movie; with it, each viewer stays locked to within a few hundred
  milliseconds of where it started, indefinitely — so "everyone's in sync"
  means "nobody drifts," not "everyone has zero latency," which isn't
  achievable over a real network. Doesn't touch file size or buffering at
  all, so it costs nothing extra for huge files.
- **Garbage collection**: a room with zero people in it is destroyed after a
  short grace period (covers a quick refresh). A room where a second person
  never shows up within 5 minutes of creation is closed automatically too —
  so a host can't accidentally leave an open, billable connection running
  with nobody there.

**Known limits, stated plainly:** this is mesh WebRTC, so the host's own
upload bandwidth carries every viewer — comfortable for a handful of friends,
not a broadcast platform. Video quality is whatever WebRTC's encoder does
with the source file/bandwidth available, not the original file's bitrate.

## Running it locally

```
npm install
npm run dev
```

Opens on `http://localhost:8787` via `wrangler dev`.

## Running the tests

```
npm test
```

Uses [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/)
to run against the real Workers runtime (Durable Objects, WebSockets, alarms —
not mocks).

## Deploying

This is a Cloudflare Worker with static assets and one Durable Object class —
no other infrastructure required, and it fits inside Cloudflare's free plan
(Durable Objects are free on the Workers Free plan; see
[pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).

```
npx wrangler login
npm run deploy
```

### Custom domain

`wrangler.jsonc` already routes `watch2gether.appsuite.in` to this Worker:

```jsonc
"routes": [
  { "pattern": "watch2gether.appsuite.in", "custom_domain": true }
]
```

For this to work, `appsuite.in` needs to be an active zone on the Cloudflare
account you deploy with (`wrangler login`) — Cloudflare creates the DNS
record and TLS certificate for the custom domain automatically on first
deploy. To point this at a different domain, edit that `pattern` (and remove
it entirely to deploy on the default `*.workers.dev` subdomain instead).

## Project layout

```
src/
  index.ts                 Worker entry — serves static assets, routes /ws to a room
  rooms/
    room-durable-object.ts One Durable Object per room — wiring only
    room-context.ts        Narrow interface handlers depend on (testable without a real DO)
    handlers/               One module per feature: presence, control, signaling, chat
    gc.ts                  Heartbeat + dead-peer sweep (pure, testable)
    rate-limiter.ts         Per-connection flood protection
    chat-store.ts           SQLite-backed, capped chat history
    validation.ts           Hand-rolled runtime message validation
    types.ts                 The client<->server message protocol
public/
  index.html                UI
  room-app.js               Orchestrates everything below
  signaling-client.js       WebSocket wrapper (typed events, reconnect)
  webrtc-mesh.js             Host -> viewer video relay
  voice-mesh.js              Full-mesh voice chat
  chat-panel.js, subtitle-*.js, position-clock.js   Feature-specific UI/logic
  shared/room-code.js        Room-code rules, shared verbatim with the Worker
```

Every server-side module stays under 500 lines and depends on small
interfaces rather than the concrete Durable Object, specifically so it's
testable in isolation — see `test/` for the corresponding unit and
integration tests (`test/room-durable-object.test.ts` runs full WebSocket
handshakes against the real Workers runtime).

## Security notes

- No authentication by design — anyone with a room code/link can join. Use a
  long, hard-to-guess room code for anything private, same as any link-based
  sharing tool.
- The Worker never sees video bytes, so there's no file-storage attack
  surface. WebSocket messages are size-capped and rate-limited per
  connection; malformed messages are dropped, not trusted.
