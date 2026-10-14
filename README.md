# homegames-client

Embeddable browser client for Homegames — the canonical rendering/input/networking engine a player's browser runs to play a Homegames game. It connects to a game server over WebSocket, decodes the squish binary game-state protocol, renders to a 2D canvas, and sends player input back.

This package was extracted from [homegames-web](../homegames-web), which now depends on it (`file:../homegames-client`) and is a thin server/page shell around it. It's framework-agnostic and ships both a source entry (`main: src/index.js`) and a prebuilt UMD bundle (`dist/homegames-client.js`, browser global `HomegamesClient`).

## Usage

```js
const { HomegamesClient } = require('homegames-client');

const client = new HomegamesClient({
    containerId: 'game-div',        // DOM element to render into
    wsUrl: 'ws://localhost:8300',   // game server WebSocket
    workerUrl: '/socket-worker.js', // optional: run the socket in a Web Worker
    // onReady, onClose, onError, spectating, requestedGame also supported
});

client.start();
```

`workerUrl` should point at `src/socket-worker.js` served raw (homegames-web serves it from `node_modules/homegames-client/src/socket-worker.js`); it moves socket I/O off the main thread. Frame decoding and canvas rendering remain on the main thread. A synchronous worker-construction failure falls back to an inline socket; later worker errors reach `onError`.

## Architecture (`src/`)

| Module | Role |
|---|---|
| `index.js` | `HomegamesClient` — inline/worker WebSocket lifecycle and binary protocol dispatch |
| `session-controller.js` | Owns session switching, cancellation/generation guards, local chrome and active-session disposal |
| `game-view.js` | Shared canvas, renderer, assets, input attachment, sizing/disposal, and a single scheduled animation loop |
| `local-game-loader.js` | Shared manifest/asset loader with explicit game/version identity and AbortSignal support |
| `local-game-chrome.js` | Shared responsive frame: Home, title, session status, privacy and Share |
| `session-frame-styles.js` | Scoped frame/dialog styles, shared and released across mounted instances |
| `renderer.js` | Draws unsquished frames to canvas: polygons, text, images, video, shadow effects; builds per-frame hit-test data; triggers audio |
| `video-player.js` | Per-node video playback, gesture-based sound unlock, video-frame invalidation and cleanup |
| `input.js` | Mouse/touch/keyboard/gamepad → JSON protocol messages; point-in-polygon hit-testing, hover tracking, text prompts, file uploads (5 MB cap; oversized images are auto-shrunk to fit), gamepad via `homepad` |
| `image-fit.js` | `fitImageToSize(blob, maxBytes)` — standalone, dependency-free canvas re-encoder that fits an image into a byte budget (quality first, then dimensions); JPEG/WebP keep their format, everything else re-encodes to WebP (or JPEG where WebP encoding is unavailable) |
| `assets.js` | Parses binary asset bundles; decodes images, audio (WebAudio), fonts; owns video Blobs/URLs and media sound unlock |
| `squish-map.js` | Browser map: `142`, `143`, `144`; default `142`. See the dependency caveat below. |
| `socket-worker.js` | Web Worker that owns the WebSocket and forwards frames as zero-copy transferables |
| `rtc-network.js`, `rtc-worker.js` | One communication worker per browser host or RTC guest; shared by every peer, with bounded queues across the worker boundary |
| `rtc-session.js`, `rtc-signaling-client.js` | Room/peer lifecycle and signaling; worker owns the signaling socket and heartbeat, Window negotiates RTCPeerConnection |
| `rtc-channel.js` | Shared worker/Window packet framing, 16 KiB chunks, backpressure and duplicate/stale snapshot suppression |
| `local-session.js` | `LocalSession` — browser game execution, saves, real Squisher frames, extra simulated players and Studio inspector |
| `local-game-runtime.js` | Owns game ticking across Squish versions, including 142's otherwise inaccessible interval |
| `local-dispatch.js` | Binds one simulated player to `homegames-common/game-dispatch.js`, the same game-facing dispatcher used by the server |
| `game-loader.js` | Minimal in-browser CommonJS loader for published games; only `squish-NNN` and the game's own relative files are requirable |
| `asset-bundle.js` | `packAssetBundle()` — browser-safe builder producing squish-compatible type-1 asset bundles |

`LocalSession`, `loadLocalGame`, `packAssetBundle`, `fitImageToSize`, and `downloadSave` are available as CommonJS named exports and statics on the browser class (for example, `HomegamesClient.LocalSession`).

## Lifecycle and local play

`start()` replaces an existing session. `stop()` cancels pending loads and disposes the owned local or remote game, views, input, timers, sounds, and worker/socket; it is safe to repeat. `startLocalGame({ gameKey, versionId })` uses the serving origin's home-server manifest endpoint, then mounts an in-place local view with a Home button. It keeps the current game alive until the manifest and assets load. A newer request or stop prevents stale results from booting, even if an injected loader ignores its AbortSignal. `exitLocalGame()` reconnects to the client's current remote URL.

A different manifest host can use the exported loader directly:

```js
const { LocalSession, loadLocalGame } = require('homegames-client');
const abort = new AbortController();
const game = await loadLocalGame({
    manifestUrl: 'https://example.test/games/42/local-manifest?ref=abc',
    gameKey: 'catalog:42',
    versionId: 'abc',
}, { signal: abort.signal });
const local = new LocalSession({ containerId: 'game-div', ...game });
local.start();
// Later: local.stop();
```

For integrated switching, inject `loadLocalGame: (request, { signal }) => Promise<gameOptions>` into HomegamesClient. The result includes `files`, `entryPoint`, optional `assetBundle`, `name`, `gameKey`, and `versionId`.

Local games mount the shared session frame automatically. Set `localHome: '/'` to navigate Home to a website, `localHome: false` to hide it, or leave it unset to reconnect to the WebSocket dashboard. RTC guest pages can mount `HomegamesClient.createSessionFrame(containerId, title, homeUrl, null, { status })`, render their client into the returned `containerId`, update it with `setStatus(text)`, and call `dispose()` after stopping the client. The frame keeps the canvas centered and fits its controls to the container width.

For guest sharing, replace the frame's `null` share option with `{ getLink: () => client.getShareLink(), hintText: 'Scan to join this session. The host needs to keep their game open.' }`. The website and Core guest pages do this and detach game input while the dialog is open. RTC hosts send their canonical invitation URL over the data channel, so public-discovery guests receive the full invitation and LAN guests share the public player URL. Share never creates a second room; visibility controls remain host-only. Invitations still work when a guest leaves and stop working when the host ends the session. Older hosts fall back to the guest's existing room/invite with the transport's `joinUrl` (default `https://homegames.io/play.html`); discovery links without an invite require the room to remain public.

Direct `LocalSession` callers can supply a game class instead of files. `addPlayer()` provides extra views of the same instance; it does not create networked participants. `freeze()` stops the game and input but retains its canvas/inspector. `stop()` also removes the views. The next `start()` replaces any prior runtime on that instance.

All local seats now use the same join, frame capture, resize, rendering and teardown paths. Each player record holds its view, dispatcher and frame; primary-view accessors such as `canvas` and `renderer` read from that owner rather than storing duplicate references. Freeze and stop share one runtime teardown, and stop destroys borrowed views before the primary asset owner. Asset decode completion invalidates every view; frozen inspection stays silent and cannot reattach gameplay input.

Pass explicit identity for saves. Storage has one `local:<gameKey>` slot per origin, with `versionId` in its envelope; restore checks the current version or `metadata().saveCompatibility`. It does not create one slot per version. If omitted, gameKey falls back to the class name and versionId to `local-game-version`. The website/download, Studio, and core manifest paths now supply identity; old class-name saves are retained but are not automatically migrated to potentially ambiguous destinations.

The [session architecture and test record](../homegames-core/docs/session-refactor.md) describes these boundaries, migration considerations, and release limits. From the sibling core checkout, run `npm run test:sessions` for focused input/lifecycle/save/route and real child-process tests, or `npm test` for the full suite.

## RTC communication and session uploads

RTC hosting and joining default to one `homegames-rtc` worker per session, including hosts with multiple guests. Signaling, heartbeat timers, data-channel sends/receives, UTF-8 packet encoding, chunk assembly and network backpressure run there. `RTCPeerConnection` negotiation remains on Window. Games, Squish serialization/decoding, image/audio decoding, file picking and canvas rendering still run on the main thread.

Channels are transferred immediately at creation or `ondatachannel`. If the browser cannot transfer a channel, it uses the same packet implementation on Window; signaling still uses the worker if available. `{ worker: false }` in `share`/`RtcHost` options or `createRtcTransport` explicitly selects the inline compatibility path. `await client.getNetworkStats()` reports worker availability, each channel's actual mode, packet counts, duplicate/replaced frames and queue sizes. Direct Studio `RtcHost` users can call `getStats()`.

The worker source is embedded in the normal client bundle and loaded through a Blob URL. Downloaded HTML remains self-contained. A site's CSP must permit `worker-src blob:` to use the worker. Shutdown terminates the worker and releases its URL. This does not keep a suspended browser/tab or phone awake.

Input Test supports image, audio and video uploads over RTC and Core/WebSocket. The game constructor receives `handleFileUpload`; `await handleFileUpload(playerId, bytes, meta)` validates and registers the upload, returning an `Asset` with a `.key` for a normal `GameNode.Asset`. Files are capped at 5 MiB in both the picker and helper, and sent as base64 input to the host. The shared dispatcher invokes the game's file-input handler. Registered assets reach every guest and remain in session memory for late joins. Asset packets remain reliable and ordered; only stale visual snapshots may be dropped. Each historical upload is sent separately to stay below the transport's 10 MiB packet cap. Uploading does not persist a file on the API.

Video uses asset type byte `4` and a browser video element drawn into the canvas. Video-frame callbacks invalidate the existing render loop even when no new game snapshot arrives; this also works with older browsers through the render loop's playback check. Each node plays once, a new node replays it, and removing the node disposes its player. Session teardown also revokes Blob URLs. A canvas gesture enables sound; autoplay can start muted. Uploaded clips are not synchronized between devices and codec support depends on the browser. See the [media upload contract and Input Test instructions](../homegames-core/docs/media-uploads.md).

See [RTC performance and file-transfer notes](../homegames-core/docs/rtc-performance-and-files.md) for validation, current limits, and the proposed path to general files and media streams.

## Live microphone and camera

Browser/RTC games receive a `media` service with `request(playerId, { audio, video, transmitting, pushToTalk })`, `setTransmitting(id, bool)`, `stop(id)` and `onChange(listener)`. A successful request returns a stream handle for `new GameNode.Stream({ streamId: handle.id, pos, size, audio: true })`. Stream is a native Squish 1.4.6 node: games using it must import `squish-146` and declare version `146`. Squish serializes its reference and presentation properties; live bytes are carried by native WebRTC tracks. The host forwards guest sources to the other participants.

The player's browser owns permission confirmation, capture and a persistent Disconnect control. Push-to-talk is additionally gated locally by a held pointer/touch/Space and releases immediately on cancellation, blur, hiding or detach. Own-source playback stays muted. This version broadcasts to the whole room, is not recorded, and requires browser/RTC play; Core/WebSocket-only requests report that requirement. See [the API contract, Walkie Talkie example and release notes](../homegames-core/docs/live-media.md).

## Protocol

The game frame includes **View exports** alongside navigation. It previews image,
audio, video and text files and lets joined players save the original bytes.
Games only call their injected `createExport(name, bytes)`; they receive initial
files as `userExports[name]`. The session owns persistence and paths.
`client.listExports()` returns `[{name, size}]`; `client.readExport(name)` returns
`{name, bytes}`; `client.viewExports()` opens the shared dialog. These operations
work with local, RTC and WebSocket hosts and do not require game-source access.
Files are shared with players throughout the room. Spectators must join as players.

Isolated Studio/downloaded players ask the explicit parent adapter to display
the same viewer and handle user-initiated downloads. Camera and microphone
recording also use that adapter's consent UI, while the game stays isolated.
Recorded clips use `media.record`; live Stream nodes are never saved as files.

Server → client messages are binary; the first byte is the type:

| Byte | Meaning |
|---|---|
| `1` | Asset bundle → `AssetManager.storeAssets` |
| `2` | Init: player id, aspect ratio, bezel info, squish version string (selects the `unsquish` implementation) |
| `3` | Game state frame (squished scene tree) → rendered on next frame |
| `5` / `6` | Port redirect (join / spectate) — client reconnects to a per-session port (game servers use the 8300–8400 range) |
| `9` | Aspect-ratio update |
| `10` / `11` | Browser save push / request |
| `12` | Local-play redirect with game/version identity |
| `14` / `15` | Project/export transfer control and acknowledged binary chunks |
| `16` | Recorded-media control for WebSocket clients |

Client → server messages are JSON strings: `ready` (with `clientInfo`: device type, aspect ratio, optional `requestedGame`), `keydown`/`keyup`, `click`/`mousemove`/`mouseup` (coordinates as 0–100 percentages), `onhover`/`offhover`, `input` (text, base64 file uploads, or gamepad state), and `clientInfo` on resize.

Coordinates throughout are percentages (0–100) of the canvas; the canvas renders at 2× CSS resolution with aspect-ratio-preserving letterboxing.

## Build

```sh
npm install     # postinstall runs homegames-common's link-squish.js to symlink squish versions
npm run build   # webpack → dist/homegames-client.js (UMD, global `HomegamesClient`)
npm run watch
```

Notes on the build:

- `homegames-common` is a `file:../homegames-common` dependency; the `postinstall` step symlinks its `squish-*` packages into this package's `node_modules` (npm doesn't hoist deps of `file:` deps), so a sibling checkout of `homegames-common` is required.
- Webpack injects the `buffer` polyfill as a global; `Buffer` is load-bearing in `LocalSession` frame capture (truncation vs. rounding of float coordinates).
- homegames-web bundles this package's **source** into its own `web/bundle.js`; the prebuilt `dist/` UMD is for standalone/external embedders.

## Related repos

- **[squish](../squish)** — the serialization protocol this client decodes (and runs locally in `LocalSession`)
- **[homegames-core](../homegames-core)** — the game server this client connects to
- **[homegames-web](../homegames-web)** — the Node server + page shell that serves this client to players
- **[homegames-common](../homegames-common)** — supplies the versioned squish packages

## Notes / caveats

- Local frames still pass through Squish serialization and decoding. The runtime uses `getPlayerFrame` and optional `flush`; its owned clock temporarily hides `tick` during the synchronous Squisher constructor, then restores the original property. See the architecture record for why 142 needs this.
- The browser version map currently differs from common's 142/143/145 map. This checkout's 144 alias resolves to a local 1.4.5 checkout; a successful local build does not prove a clean package install works. Align aliases/packages before release.
- Installed Squish Asset modules log caught `process is not defined` errors when loaded in a browser. This is a remaining dependency packaging issue; the session smoke tests still render and accept input.
- `packAssetBundle` is available for browser tooling that already has asset bytes. LocalSession does not fetch undeclared or missing assets itself.
- The GitHub remote is named `homegames-web-client`; the package and directory are `homegames-client`.

## License

GPL-3.0

## Gamepad support

Homepad reads and normalizes controllers. Homegames delivers those snapshots to the correct player in hosted and local sessions using the same `homegames-common/game-input.js` router. Games never import Homepad.

The simplest integration reuses a game's keyboard handlers:

```js
static metadata() {
    return {
        name: 'My Game', squishVersion: '142',
        gamepadBindings: {
            ArrowLeft: ['DIRECTION_LEFT', 'STICK_1_LEFT'],
            ArrowRight: ['DIRECTION_RIGHT', 'STICK_1_RIGHT'],
            ' ': 'FACE_1',
        },
    };
}
handleKeyDown(playerId, key) { /* same logic as keyboard play */ }
handleKeyUp(playerId, key) { /* clear held state */ }
```

Bindings are opt-in. Keys repeat while held, as with keyboard input. Releasing a controller cannot release a key held by another controller or the keyboard. For single-shot actions, track down/up transitions (the Gamepad Test example shows this).

For analog input, implement `handleGamepadInput(playerId, message)`. `message.input` contains Homepad's `{ buttons, sticks }` state; `message.gamepadIndex` identifies the browser controller slot; `pressed` and `released` are arrays of button names that changed on this delivery. `connected: false` carries a neutral state on disconnect, focus loss, hiding the page, or input detach. `deltaTime` is seconds since the preceding sample, capped at 0.1; it is zero on release. Callbacks repeat while held, up to 30 Hz, with a shared 60-message/second budget when multiple controllers belong to one player. Use `deltaTime` for analog movement speed. Old clients without the new fields still work (controller 0, 1/30 second default). Both raw and mapped hooks run if a game implements both; avoid applying the same movement in each.

Client options (`HomegamesClient` and `LocalSession`):

```js
new HomegamesClient({
    containerId: 'game', wsUrl: 'ws://localhost:8300',
    gamepad: { index: 0, deadzone: 0.1 },
});
// gamepad: false disables controller polling.
// index: null (default) routes all controllers to this player.
// mappings: [...] adds Homepad hardware mappings; onError reports polling failures.
```

`LocalSession.addPlayer(containerId, { gamepadIndex: 2 })` assigns a specific controller to an additional view. Without an explicit index it chooses the first unassigned slot; adding a second view pins the primary view to slot 0 unless it was explicitly assigned elsewhere. Multiple embedded clients should choose distinct indices. These indices are device slots, not authenticated player IDs; the session assigns the player.

Examples in homegames-core: `gamepad-test` demonstrates bindings, button edges and analog diagnostics; `move-test` demonstrates two analog sticks; `halloween-words` uses declarative bindings. In homegames-web, `?local=gamepad-test` runs the diagnostic without a server game session.

For this multi-repo development checkout, both the client and common runtime use `file:../homepad` (0.2.0). Keep the sibling checkout present, run each consumer's `npm install`, run the client's `npm run postinstall` to restore Squish links, and rebuild client bundles. The runner Docker build also copies Homepad. Publishing these packages requires publishing Homepad first and switching the development file dependencies to its released version.

## Manual RTC pairing

`HomegamesClient.ManualRtc` exposes `ManualHost`, `createManualGuest`, and
`readHandshake`. A `ManualHost` attaches remote seats to an existing
`LocalSession`; a guest's `transport` plugs into the normal client transport
option. Call `createOffer()`, transfer its complete JSON text privately, call
`createManualGuest(offer).answer()` on the guest, and paste that answer into the
host's `acceptAnswer()`. Use a separate offer/answer exchange for each guest.

`createManualPairing({container, getSession, join, onOpen, onClose})` builds the
shared copy/paste dialog. The portable HTML builders, isolated Studio preview,
and website player use it. It never registers a room or opens a signaling
WebSocket. SDP includes gathered ICE candidates, so trickle signaling is not
needed. Pending offers expire after ten minutes. Close/dispose pairing when its
owning game/page ends. The guest's old local game must stop before its renderer
connects to the host.

This path reuses bounded `RtcChannel` framing on the main thread and the existing
remote-player scene/assets/input protocol. It doesn't transfer editable game
files or support live camera/microphone tracks. Public Google STUN is the default;
`iceServers: []` disables STUN for LAN-only pairing. Some NAT/firewall combinations
still require a TURN relay; this dialog does not configure one. Host shutdown
ends play; reconnecting requires a new exchange. Handshakes are private
invitations that reveal candidate network addresses to their recipient.

Browser outage acceptance lives in `homegames-core/test/rtc-manual-browser.cjs`:
two downloaded HTMLs, blocked HTTP/WebSockets, manual negotiation, scene/image/
audio/input, invalid answer, cancellation/retry and host shutdown.
