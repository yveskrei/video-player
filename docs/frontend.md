# Frontend Reference

Exhaustive technical reference for `frontend/`. For the short operational contract, see [`frontend/CLAUDE.md`](../frontend/CLAUDE.md). For the feature-level overview, see [`frontend/README.md`](../frontend/README.md).

**What it is:** a Vite 7 + React 19 + TypeScript SPA styled with Tailwind 3. Two routes: `/` (Management — video library, upload, start/stop) and `/viewer` (a dash.js DVR player with a canvas bounding-box overlay, in-browser clip export and in-browser live recording). It talks to the FastAPI backend (default `http://localhost:8702`) over REST plus **one global WebSocket** at `/ws`.

There is **no state library** — no Redux, no Zustand, no React Context. Cross-component state is prop-drilled; hot paths use refs.

Everything media-related past the `<video>` element is **WebCodecs** (`VideoEncoder` / `VideoDecoder` / `VideoFrame`) plus `mp4box` and `mp4-muxer`. There is **no `MediaRecorder` anywhere in this codebase**.

---

## Table of contents

1. [File-by-file breakdown](#1-file-by-file-breakdown)
2. [Type definitions](#2-type-definitions)
3. [API layer](#3-api-layer)
4. [Routing & pages](#4-routing--pages)
5. [DASH / DVR playback](#5-dash--dvr-playback)
6. [Bounding-box pipeline](#6-bounding-box-pipeline)
7. [Clip export (WebCodecs)](#7-clip-export-webcodecs)
8. [Live recording](#8-live-recording)
9. [State management](#9-state-management)
10. [Styling](#10-styling)
11. [Build / dev / env](#11-build--dev--env)
12. [Gotchas & limitations](#12-gotchas--limitations)

---

## 1. File-by-file breakdown

| File | Lines | Role |
|---|---|---|
| `src/main.tsx` | 10 | Entry point — `createRoot` + `StrictMode` |
| `src/App.tsx` | 33 | `BrowserRouter`, `Toaster`, three routes |
| `src/App.css` | 42 | **DEAD** — Vite scaffold leftovers, never imported anywhere |
| `src/index.css` | 49 | Tailwind directives, Inter webfont, `@layer components` classes, `skipFade` keyframes |
| `src/vite-env.d.ts` | 9 | `ImportMetaEnv.VITE_BACKEND_URL` typing |
| `src/api/client.ts` | 40 | Base-URL resolution + the shared axios instance |
| `src/api/streams.ts` | 45 | Six typed REST wrappers |
| `src/types/index.ts` | 58 | All shared DTO/domain types |
| `src/components/Layout.tsx` | 66 | Sticky header, two nav tabs, `<main>` container |
| `src/components/Modal.tsx` | 92 | Generic modal (backdrop, Escape, body-scroll lock, 4 sizes) |
| `src/components/StreamCard.tsx` | 42 | 16∶9 clickable card for a live stream |
| `src/components/BBoxOverlay.tsx` | 79 | Absolutely-positioned canvas + its own RAF draw loop |
| `src/components/VideoPlayer.tsx` | 270 | dash.js lifecycle, the whole `updateSettings` block, watchdog, drift interceptor |
| `src/components/player/Seekbar.tsx` | 177 | DVR track, playhead fill, hover label, pointer-capture scrubbing |
| `src/components/player/BBoxStrip.tsx` | 158 | 2-second detection clusters above the seekbar |
| `src/components/player/ClipOverlay.tsx` | 124 | Draggable amber clip-range rectangle |
| `src/components/player/PlayerControls.tsx` | 307 | Transport bar, LIVE / −MM:SS label, 4-state save button |
| `src/components/player/SettingsMenu.tsx` | 383 | Three-view popover: main / confidence / speed |
| `src/hooks/useWebSocket.ts` | 116 | Global WS, reconnect, subscription replay, bbox ring buffer |
| `src/hooks/useDvrPlayer.ts` | 203 | `DvrState` derivation and all absolute-seconds seek functions |
| `src/hooks/useClipExport.ts` | 122 | Main-thread half of clip export (MPD parse, worker, download) |
| `src/hooks/useLiveRecorder.ts` | 243 | 30 s rolling WebCodecs encode buffer + `saveRecording` |
| `src/pages/Management.tsx` | 467 | Library table, upload/delete/info modals, start/stop |
| `src/pages/Viewer.tsx` | 896 | The player page — orchestrates everything above |
| `src/utils/confidence.ts` | 33 | `ConfidenceSettings` + resolver + key normalizer |
| `src/utils/drawing.ts` | 92 | `COLORS` + `drawBBoxes` (1-D index decoding) |
| `src/utils/mpdParser.ts` | 95 | `DOMParser`-based MPD → `SegmentTemplateInfo` |
| `src/workers/exportClip.worker.ts` | 295 | Fetch → demux → decode → composite → encode → mux |
| `src/assets/react.svg` | — | **DEAD** — never imported |

### `main.tsx`

`createRoot(document.getElementById('root')!)` wrapped in `<StrictMode>` (`main.tsx:6-10`); imports `./index.css` (`:3`). **StrictMode double-invokes effects in development** — every `useEffect` in this codebase runs twice on mount in `bun run dev`, which is why the WebSocket, the dash.js player and the recorder all have idempotent setup/teardown.

### `App.tsx`

- `<Router>` = `BrowserRouter` aliased at `:2`.
- `<Toaster position="top-right">` with a hardcoded dark style `{background:'#18181b', color:'#fff', border:'1px solid #27272a'}` (`:12-21`).
- Routes (`:23-27`): `/` → `Management`, `/viewer` → `Viewer`, `*` → `<Navigate to="/" replace />`.

### `index.css`

- `@import` of the Inter webfont **from Google Fonts** (`:1`) — the only external network dependency of the built bundle.
- `@layer base` sets `body` to `bg-background text-zinc-100 antialiased` + Inter (`:7-12`).
- `@layer components` defines `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-danger`, `.btn-ghost`, `.card`, `.input` (`:14-42`).
- `@keyframes skipFade` (`:44-49`) — used only by the ±skip feedback badge (`Viewer.tsx:822`, `animate-[skipFade_700ms_ease-out_forwards]`).

### `components/Layout.tsx`

`Layout({children}: {children: React.ReactNode})`. Tabs are a literal array (`:13-16`): `Management → /` (`LayoutDashboard`), `Stream Viewer → /viewer` (`Tv`). Active tab is decided by `location.pathname === tab.path` (`:38`) — exact match, so no nested-route highlighting. Header is `sticky top-0 z-50` (`:21`); content is capped at `max-w-7xl` (`:61`).

### `components/Modal.tsx`

Props (`:5-12`): `isOpen`, `onClose`, `title`, `children`, `footer?`, `size?: 'sm'|'md'|'lg'|'xl'` (default `'md'`). One effect (`:24-38`) adds a `keydown`→Escape listener and sets `document.body.style.overflow='hidden'` **only when open**, but its cleanup sets `document.body.style.overflow='unset'` **unconditionally on every run** (`:36`). Returns `null` when closed (`:40`). Max height `90vh` with a scrolling body (`:61`, `:79`).

### `components/StreamCard.tsx`

`StreamCardProps { stream: VideoInfo; onSelect: (id:number)=>void }` (`:5-8`). A `<button>` with `aspect-video`, an always-on pulsing green "Live" badge (`:18-21`), a hover-scaled play glyph (`:24-28`), and a bottom gradient strip showing `#id`, name and `width×height · fps` (`:31-39`). No thumbnail — there is no thumbnail endpoint in the backend.

### `components/BBoxOverlay.tsx`

Props (`:6-28`): `bboxesRef`, `versionRef?`, `originalWidth`, `originalHeight`, `confidenceRef`, `show`, `width`, `height`, `offsetX?`, `offsetY?`.

The effect (`:43-65`) grabs a `2d` context with `alpha: true`, clears and bails when `show` is false (`:49-52`), otherwise installs a `requestAnimationFrame` loop that clears and calls `drawBBoxes(...)` every frame (`:55-63`). Deps: `[bboxesRef, confidenceRef, originalWidth, originalHeight, show, width, height]`.

Two documented decisions:
- **RAF, not `setInterval`** (`:7-12`): `setInterval` was throttled under CPU pressure (MPD parse, `appendBuffer`, large React re-renders) and the overlay visibly halted for seconds even while `bboxesRef` kept updating.
- **`versionRef` is accepted and ignored** (`:14-17`): it is not even destructured (`:30-40`). Deciding whether to redraw was never cheaper than redrawing 30–50 rects.

The canvas is `absolute pointer-events-none`, positioned by `left/top = offsetX/offsetY` px (`:68-77`) — that is the letterbox offset computed in `Viewer.tsx`.

### `components/player/*`

Covered in detail in [§5](#5-dash--dvr-playback) (Seekbar geometry), [§6](#6-bounding-box-pipeline) (BBoxStrip) and [§9](#9-state-management) (controls). Summary:

| Component | Exports | Notes |
|---|---|---|
| `Seekbar.tsx` | `Seekbar`, **`formatBehindLive`** (`:9`) | Owns `timeToX`/`xToTime` and passes them down; `ResizeObserver` on the track (`:49-58`) |
| `BBoxStrip.tsx` | `BBoxStrip` | 2 s buckets, dominant-class icon, hover card |
| `ClipOverlay.tsx` | `ClipOverlay` | Pointer-capture drag with invariant clip length |
| `PlayerControls.tsx` | `PlayerControls` | 27-prop transport bar; local `settingsOpen` state only |
| `SettingsMenu.tsx` | `SettingsMenu` | `View = 'main'|'confidence'|'speed'` (`:21`); outside-click + Escape close (`:46-60`) |

`formatBehindLive(secBehind)` returns `'LIVE'` for `≤ 0.5 s`, else `-MM:SS` or `-H:MM:SS` (`Seekbar.tsx:9-17`).

`SettingsMenu` constants: `SPEED_PRESETS = [0.5, 1, 1.5, 2]`, `SPEED_MIN = 0.25`, `SPEED_MAX = 2`, `SPEED_STEP = 0.05` (`:23-26`). At live the slider max is clamped to `1` and `>1×` presets are disabled (`:169`, `:188`) — fast playback at the live edge would drain dash.js's ~6 s forward buffer and stall (`:164-168`). The frame-retention slider is `min=1 max=30 step=1` (`:113-121`). New confidence overrides are seeded at `0.5` (`:273`).

### `hooks/`, `utils/`, `workers/`, `pages/`

Each has a dedicated section: [§3](#3-api-layer) (`useWebSocket`), [§5](#5-dash--dvr-playback) (`useDvrPlayer`), [§6](#6-bounding-box-pipeline) (`drawing`, `confidence`), [§7](#7-clip-export-webcodecs) (`useClipExport`, `mpdParser`, `exportClip.worker`), [§8](#8-live-recording) (`useLiveRecorder`), [§4](#4-routing--pages) and [§9](#9-state-management) (`Management`, `Viewer`).

---

## 2. Type definitions

### `src/types/index.ts`

**`StreamStatus`** (`:1`) — `'stopped' | 'initializing' | 'streaming' | 'terminating'`. Mirrors the backend `utils/enums.py:4`.

**`VideoInfo`** (`:3-20`)

| Field | Type | Notes |
|---|---|---|
| `id` | `number` | |
| `name` | `string` | |
| `file_path` | `string` | Server-side path; displayed nowhere |
| `created_at` | `string` | ISO, local time, no timezone |
| `width` / `height` | `number` | Source resolution (**not** necessarily the decoded DASH resolution) |
| `fps` | `number` | |
| `stream_status` | `StreamStatus` | |
| `stream_start_time_ms` | `number \| null` | |
| `dash_manifest_url` | `string \| null` | The **only** URL the player consumes |
| `prog_url` | `string \| null` | **DISPLAY-ONLY** |
| `prog_init_url` | `string \| null` | **DISPLAY-ONLY** |
| `dvr_window_seconds` | `number \| null \| undefined` | Backend-authoritative DVR capacity |

The comment at `:14-16` is a standing instruction: *"The frontend player does NOT consume them — DASH is the only playback path. Don't wire these into anything."* They are rendered as copyable text in the Management info modal (`Management.tsx:445-460`) and nowhere else.

**`BBox`** (`:22-27`) — `top_left_corner: number`, `bottom_right_corner: number`, `class_name: string`, `confidence: number`. Note there is **no `pts` field** on the frontend `BBox`: pts lives only in the `Map` key. (The backend does send `pts` and `absolute_timestamp_ms` inside each element; both are simply ignored by the type.)

**`BBoxMessage`** (`:29-36`) — `type:'bbox_update'`, `video_id`, `pts`, `bboxes: BBox[]`, `stream_start_time_ms?`, `timestamp?`.

**`VideoUpdateMessage`** (`:38-42`) — `type:'video_update'`, `reason: 'created'|'deleted'|'stream_initializing'|'stream_started'|'stream_stopped'|'stream_error'`, `video?: VideoInfo & { id: number }`.

**`BBoxGroup`** (`:44-47`) — `{ pts, bboxes }`. **`BBoxHistoryResponse`** (`:49-53`) — `{ video_id, stream_start_time_ms, groups }`.

**`ClipSelection`** (`:55-58`) — `{ startPts: number; endPts: number }`, both in **90 kHz absolute presentation units**.

### Exported types outside `types/index.ts`

| Type | Location | Shape |
|---|---|---|
| `ConfidenceSettings` | `utils/confidence.ts:6-9` | `{ default: number; overrides: Record<string, number> }` — override keys are **lowercased** class names |
| `TimelineEntry` | `utils/mpdParser.ts:5-9` | `{ number, startSec, durationSec }` |
| `SegmentTemplateInfo` | `utils/mpdParser.ts:11-18` | `{ initUrl, mediaTemplate, timescale, startNumber, timeline, baseUrl }` |
| `DvrState` | `hooks/useDvrPlayer.ts:8-17` | See below |

**`DvrState`** — *all times are absolute presentation seconds*, the same scale as `video.currentTime` on a live DASH stream (`useDvrPlayer.ts:4-7`):

| Field | Meaning |
|---|---|
| `playhead` | `video.currentTime`, absolute |
| `duration` | Absolute presentation time of the **live edge** (not a media duration) |
| `dvrStart` | Absolute presentation time of the window start |
| `dvrWindowSize` | `duration - dvrStart` (after capping) |
| `behindLive` | `duration - playhead`, clamped at 0 |
| `isLive` / `isPaused` / `isReady` | booleans; `isReady` is `video.readyState >= 1` |

### Notable inline (non-exported) types

| Type | Location | Purpose |
|---|---|---|
| `ExportArgs` | `hooks/useClipExport.ts:8-18` | `videoId`, `manifestUrl`, `startPts`, `endPts`, `bboxGroups`, `showBBoxes`, `confidence`, `originalWidth`, `originalHeight` |
| `WorkerMessage` | `hooks/useClipExport.ts:20-23` | `progress` \| `done` \| `error` |
| `ExportJob` | `workers/exportClip.worker.ts:24-36` | Structured-clonable job; `bboxEntries: Array<[number, BBox[]]>` |
| `Sample` | `workers/exportClip.worker.ts:101-107` | `{ data, cts, timescale, duration, is_sync }` |
| `TrackInfo` | `workers/exportClip.worker.ts:110` | `{ id, timescale, codec, width, height }` |
| `BufferChunk` | `hooks/useLiveRecorder.ts:22-25` | `{ chunk: EncodedVideoChunk; meta?: EncodedVideoChunkMetadata }` |
| `DragState` | `components/player/ClipOverlay.tsx:16-23` | Drag anchor + `viewWindowSec` |
| `Bucket` | `components/player/BBoxStrip.tsx:21-25` | `{ seconds, classCounts: Map<string,number>, total }` |
| `SaveButtonArgs` | `components/player/PlayerControls.tsx:233-241` | Args of the 4-state `renderSaveButton` |
| `View` | `components/player/SettingsMenu.tsx:21` | `'main' \| 'confidence' \| 'speed'` |

---

## 3. API layer

### Base-URL resolution — `api/client.ts`

```ts
let url = localStorage.getItem('backend_url') || import.meta.env.VITE_BACKEND_URL;   // :5
```

**`localStorage` WINS over the build-time env var.** Because Vite inlines `import.meta.env.VITE_BACKEND_URL` at build time, `localStorage.backend_url` is the only way to retarget a built bundle at runtime.

Then (`:7-16`):
1. `url.trim().replace(/\/+$/, '')` — trailing slashes are stripped because concatenation would otherwise produce `http://host:port//ws`, **which FastAPI rejects** (comment at `:8-9`).
2. If it starts with neither `http` nor `/`, prefix `http://`.
3. `console.warn('VITE_BACKEND_URL is not defined in .env file')` when empty (`:20-22`) — the app then issues **same-origin relative requests**, which fail against the Vite dev server (no proxy, see [§11](#11-build--dev--env)).

| Export | Line | Notes |
|---|---|---|
| `apiClient` | `:24-29` | `axios.create({ baseURL, headers: {'Content-Type': 'application/json'} })` |
| `setBackendUrl(url)` | `:31-38` | Normalizes, writes `localStorage.backend_url`, mutates `apiClient.defaults.baseURL`. **Never called anywhere in `src/`** — a devtools-only escape hatch |
| `getBackendUrl()` | `:40` | `apiClient.defaults.baseURL || ''`. Used to build the WS URL, absolute manifest URLs and the info-modal display URLs |

### REST wrappers — `api/streams.ts`

| Function | Line | Method + path | Payload | Returns | Callers |
|---|---|---|---|---|---|
| `listVideos()` | `:4` | `GET /videos/` | — | `VideoInfo[]` | `Management.fetchVideos` (`:85`), `Viewer.fetchStreams` (`:255`) |
| `uploadVideo(file, name, onProgress?)` | `:9` | `POST /videos/upload` | `FormData{file,name}` | `void` (204) | `Management.handleUploadSubmit` (`:121`) |
| `deleteVideo(videoId)` | `:30` | `DELETE /videos/{id}` | — | `void` | `Management.handleDeleteSubmit` (`:142`) |
| `startStream(videoId)` | `:34` | `POST /streams/start` | `{ video_id }` | `void` | `Management.handleStartStream` (`:154`) |
| `stopStream(videoId)` | `:38` | `POST /streams/stop/{id}` | — | `void` | `Management.handleStopStream` (`:163`) |
| `listBboxes(videoId)` | `:42` | `GET /bboxes/{id}` | — | `BBoxHistoryResponse` | `Viewer` history hydration (`:332`) |

`uploadVideo` sets `Content-Type: multipart/form-data` explicitly (`:21`) — axios detects the `FormData` body and rewrites it with the boundary. `onProgress` receives a **fraction on [0, 1]**, not a percentage: `Math.min(1, e.loaded / (e.total ?? file.size))` (`:22-26`). `Management` renders `Math.round(uploadProgress * 100)` and switches to "Processing… / analyzing video on server…" at `>= 1` (`Management.tsx:331-335`, `:374-378`) — because the backend's ffprobe pass happens after the bytes land.

There is **no wrapper for** `GET /videos/{id}`, `GET /streams/status/{id}`, `POST /bboxes/`, `POST /bboxes/cleanup`, `/dash/*` (dash.js and the export worker `fetch` those directly) or `/progressive/*` (never fetched at all).

No interceptors, no retry, no timeout: every call inherits axios's default (no timeout). Errors surface as rejected promises handled per-call site with `toast.error`.

### WebSocket lifecycle — `hooks/useWebSocket.ts`

`useWebSocket({ onVideoUpdate? })` returns `{ isConnected, bboxBuffer, subscribe, unsubscribe }` (`:110-115`). `bboxBuffer` is the **ref itself** (`bboxBufferRef`), not its value — consumers drain it in place.

**URL derivation** (`:29`):
```ts
const wsUrl = backendUrl.replace(/^http/, 'ws').replace(/^https/, 'wss') + '/ws';
```
The second `.replace` is **dead code**: after `^http → ws`, an `https://…` URL has already become `wss://…`, and `^https` can no longer match. The result is correct anyway.

| Behaviour | Line | Detail |
|---|---|---|
| Connect on mount | `:94-108` | `mountedRef = true`, `connect()`; cleanup nulls `onclose` **before** `close()` so teardown doesn't schedule a reconnect |
| Reconnect | `:70-76` | `onclose` → `setTimeout(connect, 2000)`, guarded by `mountedRef` |
| Subscription replay | `:43-45` | On **every** `onopen`, every id in `subscribedIdsRef` is re-sent as `subscribe_video`. This is what makes `subscribe()` safe to call before the socket is open, and what restores subscriptions after a reconnect |
| `subscribe(videoId)` | `:79-84` | Adds to `subscribedIdsRef`, sends immediately **if** `readyState === OPEN` |
| `unsubscribe(videoId)` | `:86-92` | Removes, sends if open, and **clears the whole bbox buffer** (`:91`) |
| bbox ring buffer | `:52-56` | `push`, then `shift()` while `length > 500` — **drop-oldest**, capped at 500 pending messages |
| `video_update` | `:57-59` | Dispatched straight to `onVideoUpdateRef.current` (kept fresh by the effect at `:21-23`, so a changing callback never re-opens the socket) |
| Parse failure | `:61-63` | `console.error`, message dropped, socket left open |
| `isConnected` | `:34-35`, `:66-68`, `:70-72` | `true` on open; `false` on error and on close |

**No ping is ever sent.** The backend implements `{"type":"ping"}` → `{"type":"pong"}` (`backend/src/main.py`), and the client comment at `:60` says *"pong handled implicitly"*, but nothing in this hook or anywhere else in `src/` sends one. Liveness relies entirely on the browser's TCP/WS defaults and the 2 s reconnect.

**Two independent sockets exist when both pages have been mounted** — `Management` calls `useWebSocket` at `:80` and `Viewer` at `:212`. They are separate hook instances, so navigating between tabs opens a new socket and closes the old one. Under StrictMode in dev, each mount opens/closes twice.

---

## 4. Routing & pages

`BrowserRouter` (`App.tsx:11`) — real paths, no hash routing, so a production deploy needs an SPA fallback rewrite.

| Path | Element | Line |
|---|---|---|
| `/` | `<Management />` | `App.tsx:24` |
| `/viewer` | `<Viewer />` | `App.tsx:25` |
| `*` | `<Navigate to="/" replace />` | `App.tsx:26` |

### The `?stream_id=` deep link

- **Producer:** the Management table's "Watch Stream" button (only rendered when `isStreaming`) calls `navigate(\`/viewer?stream_id=${video.id}\`)` (`Management.tsx:261`).
- **Consumer:** `Viewer` reads `parseInt(searchParams.get('stream_id') ?? '') || null` (`Viewer.tsx:26`). `parseInt('')` is `NaN`, and `NaN || null` is `null`, so garbage values degrade to "no auto-select". Note `stream_id=0` would also degrade to `null` — harmless, backend ids start at 1.
- **One-shot auto-select** (`Viewer.tsx:360-367`): the effect bails if `autoSelectedRef.current` is already true, if there is no `autoStreamId`, or if a stream is already selected. It waits for the stream to appear in the `streams` list *with* a `dash_manifest_url`, then sets `autoSelectedRef.current = true` and calls `handleStreamSelect`. `autoSelectedRef` is **never reset to false** — so after the user stops watching, the URL param cannot re-trigger a selection in that page instance.
- **URL writes** always use the functional form with `{ replace: true }` — set on select (`Viewer.tsx:307-311`), delete on stop (`Viewer.tsx:168-172`) — so the browser Back button doesn't accumulate one entry per stream switch.

### Page shapes

- **`Management.tsx`** — header + actions (`:181-196`), stats cards (`:199-218`), the video table (`:221-314`), then three `Modal`s: upload (`:319`), delete (`:385`), info (`:403`). Row actions are `opacity-0 group-hover:opacity-100` (`:258`). Enablement rules: Watch only when `streaming` (`:259`); Start when `stopped`, otherwise Stop, disabled while `initializing`/`terminating` (`:269-286`); Info disabled unless `streaming` (`:290`); Delete disabled unless `stopped` (`:299`) — mirroring the backend's 400 "stop the stream first".
- **`Viewer.tsx`** — early-returns a **grid view** when `selectedStreamId === null` (`:708-749`), otherwise renders the **player view** (`:754-895`). The grid lists only `stream_status === 'streaming'` videos (`:256`) and is refreshed on mount, on the Refresh button, and on every WS reconnect edge (`:262-266`).

---

## 5. DASH / DVR playback

This is the most load-bearing part of the frontend. Every setting below is an empirical fix with a written post-mortem in the source; the failures they prevent are real and were observed.

### 5.1 Player construction — `components/VideoPlayer.tsx`

`VideoPlayer` is a `forwardRef<HTMLVideoElement, VideoPlayerProps>` (`:12`) whose imperative handle is simply the internal `videoRef.current` (`:17`), so the parent gets the raw `<video>` element.

Props (`:5-10`): `manifestUrl`, `onResolutionChange(w,h)`, `onError?(msg)`, `onPlayerReady?(player)`.

The whole lifecycle lives in **one effect keyed on `[manifestUrl]`** (`:23-258`). It bails if there is no URL or no video element, and — critically — **bails if `playerRef.current` is already set** (`:25`), which is what makes StrictMode's double-invoke harmless. `onPlayerReady` is read through a ref (`:15`, `:19-21`) so changing the callback never re-creates the player.

`player.initialize(videoRef.current, manifestUrl, true)` (`:153`) — the third argument is **autoPlay = true**. `onPlayerReadyRef.current?.(player)` fires immediately after (`:155`), handing the player to `useDvrPlayer.setPlayer`.

### 5.2 The `player.updateSettings` block (`:62-151`)

| Setting | Value | Line | The exact failure it prevents |
|---|---|---|---|
| `streaming.utcSynchronization.enabled` | `false` | `:87` | The previous config used `urn:mpeg:dash:utc:direct:2014` with `value: new Date().toISOString()` **captured once at init**. dash.js treats that static value as THE reference time for every re-sync, so `clientServerTimeShift = parse(staticValue) - Date.now()` grows more negative every second. It feeds `range.end = (Date.now() - AST + shift*1000)/1000`, which collapses to the constant `(init_time - AST)/1000` — a **frozen live edge**. Playback advances past it, then dash.js's wallclock tick `updateCurrentTime()` snaps `currentTime` **backwards**; captured live as **−90 s jumps** in `[DVR-DIAG/set]` traces. With `enabled:false`, `clientServerTimeShift` stays 0 and `range.end` advances monotonically at 1×. Also offline-safe: the backend MPD advertises no `<UTCTiming>` element, and with sync off dash.js won't try its default Akamai fallback (rationale `:63-86`) |
| `streaming.applyServiceDescription` | `false` | `:94` | The backend emits `-ldash 1`, so the MPD advertises **LL-DASH** via `ServiceDescription` + `SuggestedPresentationDelay`. dash.js auto-enables its low-latency catch-up path on such manifests and drags the playhead toward live whenever it decides we're "too far behind" — the user seeks to −1:00 and drifts back to live over a few seconds, **breaking DVR seeks** (rationale `:88-93`) |
| `streaming.applyProducerReferenceTime` | `false` | `:95` | Same manifest-directive opt-out, producer-reference-time flavour |
| `streaming.delay.liveDelay` | `6.0` | `:96` | Fixed 6 s target live delay. Also the fallback used by `useDvrPlayer` when `getTargetLiveDelay` is unavailable (`useDvrPlayer.ts:68-70`) |
| `streaming.delay.useSuggestedPresentationDelay` | `false` | `:96` | Ignore the MPD's own `SuggestedPresentationDelay`; the 6 s above is authoritative |
| `streaming.liveCatchup.mode` | `'liveCatchupModeDefault'` | `:98` | — |
| `streaming.liveCatchup.enabled` | `false` | `:99` | No playback-rate catch-up at all |
| `streaming.liveCatchup.maxDrift` | `0` | `:100` | |
| `streaming.liveCatchup.playbackRate` | `{min:0, max:0}` | `:101` | Belt-and-braces: even if catch-up re-enabled itself, the allowed rate deviation is zero |
| `streaming.gaps.jumpGaps` | `false` | `:114` | dash.js's `GapController` auto-seeks **forward** when it thinks the playhead is in an unbuffered gap. Sitting at the oldest DVR edge (−5:00) while the MPD slides makes the playhead fall behind the new window start; GapController then jumps forward into a region ffmpeg may have just deleted — **symptom: a spontaneous jump to −3:30 followed by a hard freeze**. `liveCatchup.enabled:false` does **NOT** cover this; `gaps.*` governs discontinuity-based seeks, catch-up governs rate (rationale `:104-112`) |
| `streaming.gaps.jumpLargeGaps` | `false` | `:115` | Same |
| `streaming.gaps.enableSeekFix` | `false` | `:116` | Same |
| `streaming.gaps.enableStallFix` | `false` | `:117` | Same |
| `streaming.manifestUpdateRetryInterval` | `1000` | `:119` | Fast MPD retry — the manifest is rewritten every 2 s segment |
| `streaming.retryIntervals.MPD` | `1000` | `:120` | |
| `streaming.retryAttempts.MPD` | `2` | `:121` | |
| `streaming.timeShiftBuffer.calcFromSegmentTimeline` | `false` | `:130` | Forces wall-clock derivation of `range.start`/`range.end` regardless of MPD shape. The backend emits `-use_timeline 1`, so the MPD *does* carry a `SegmentTimeline`; dash.js 5.x defaults to wall-clock anyway, but pinning it prevents a future dash.js version from silently switching to segment-timestamp-driven range calculation, which lags ffmpeg and **reintroduces live-edge jitter** (rationale `:122-129`) |
| `streaming.abr.limitBitrateByPortal` | `true` | `:131` | No-op in practice — the backend publishes a single 2 Mbit representation |
| `streaming.buffer.bufferTimeAtTopQuality` | `15` | `:144` | Forward buffer trimmed; 15 s is plenty at 2 s segments |
| `streaming.buffer.bufferTimeAtTopQualityLongForm` | `30` | `:145` | |
| `streaming.buffer.bufferToKeep` | `10` | `:146` | The old **20 s `bufferToKeep` with no explicit `bufferPruningInterval`** let dash.js accumulate stale segments behind the playhead for minutes. On a long DVR session **MSE eventually hit its quota**, manifesting as "playable segments become unplayable" spreading from the oldest side toward live, ending with **even live frozen** (rationale `:132-142`) |
| `streaming.buffer.bufferPruningInterval` | `4` | `:147` | The tight prune interval that actually evicts it |
| `streaming.buffer.fastSwitchEnabled` | `true` | `:148` | |

**Deliberate omissions**, documented at `:168-175`: there is **no `PLAYBACK_STALLED` / `BUFFER_EMPTY` handler**. Those events fire on every brief unbuffered moment — including the normal seek → fetch → decode round-trip — and seeking to live on them turned every DVR click into "bounced back to live", hiding the user's chosen position. With `GapController` off, genuine stalls are rare and the honest recovery is a page refresh.

**Error handling** (`:157-166`): `capability`, `mediasource`, `key_session` → `toast.error`; everything else → `console.error`; `download` additionally calls `onError('Stream stopped')`, which in `Viewer` toasts and tears the player down (`Viewer.tsx:776`).

### 5.3 The readyState watchdog (`:177-198`)

`MAX_RETRIES = 3` (`:27`), `READY_TIMEOUT_MS = 10000` (`:34`).

dash.js 5.1.1 has a race in `StreamController._composePeriods`: `_initializeForFirstStream` throws because the stream's adapter isn't loaded yet (`Promise.all` resolves before `stream.initialize()` finishes). The uncaught rejection prevents `STREAMS_COMPOSED` from ever firing, so playback never starts. (This is the browser-side twin of the backend's `MIN_READY_SEGMENTS = 3` gate.)

After 10 s the watchdog checks `video.readyState >= 1` (`HAVE_METADATA`) — **any sign of life counts as progress** and it returns without touching the player (`:192`). Otherwise it decrements `retriesLeft`, calls `player.reset()` inside a `try/catch`, nulls `playerRef` and recurses into `createAndInit()`. The `canplay` listener clears the watchdog (`:53-55`, `:243`).

The comment at `:29-33` notes 4 s was too aggressive — it fired on healthy-but-slow inits — and 10 s is long enough that only the real bug trips it.

### 5.4 The `[DVR-DRIFT]` currentTime interceptor (`:205-239`)

Installed unconditionally, right after `createAndInit()`. It reads the `currentTime` accessor pair off `HTMLMediaElement.prototype` and `Object.defineProperty`-s a **per-element** override (`:217-234`) that:

- forwards `get` to the original getter,
- on `set`, computes `delta = val - current`, checks `video.__userSeekingUntil` against `performance.now()`, and `console.warn`s `[DVR-DRIFT] AUTO seek delta=…s` **plus a captured stack trace** for any non-user write with `|delta| > 0.5` (`:225-231`),
- then forwards to the original setter.

`__userSeekingUntil` is stamped `performance.now() + 500` by `useDvrPlayer.markUserSeek()` (`useDvrPlayer.ts:160-163`), which every public seek function calls first.

Two properties worth knowing before touching this: it **monkey-patches a DOM property per player instance and never restores it** (the effect cleanup at `:245-257` does not `delete video.currentTime`), and the header comment says *"leave in until you've verified the fix"* — it is **intentional diagnostics still in place**, not a leftover. In steady state it should print nothing.

### 5.5 `useDvrPlayer` — deriving `DvrState`

`useDvrPlayer(videoRef, maxDvrWindowSec?)` (`:34-37`). `maxDvrWindowSec` comes from `VideoInfo.dvr_window_seconds`, defaulting to `300` at the call site (`Viewer.tsx:101`).

**`readState()`** (`:41-100`) — the live branch (`player.isDynamic()`, `:46`):

```ts
const win    = player.getDvrWindow();      // :57
const inWin  = player.timeInDvrWindow();   // :58
if (!win || !win.size || win.size <= 0) return null;               // :59
const cappedSize = maxDvrWindowSec > 0 ? Math.min(win.size, maxDvrWindowSec) : win.size;  // :61-63
const duration   = win.end;                // :64  absolute live edge — AUTHORITATIVE
const dvrStart   = duration - cappedSize;  // :65  stable left edge
const playhead   = win.start + inWin;      // :66  == video.currentTime, absolute
const behindLive = Math.max(0, duration - playhead);               // :67
```

Why `win.start` is **not** trusted (comment `:47-56`): dash.js clamps `range.start` against period ranges, so it can **jitter by tens of seconds across MPD refreshes** — visible as the seekbar's left-edge hover label bouncing between −05:00 and −08:00 on a 300 s stream. Only `win.end` is wall-clock-derived and monotonic (once UTC sync is off), so the window is reconstructed as `end - min(size, backendMax)`. This degrades gracefully on young streams where `win.size < maxDvrWindowSec` and the real size passes through. Note `playhead` still uses the raw `win.start + inWin` — that sum equals `video.currentTime` regardless of clamping.

`targetDelay = player.getTargetLiveDelay?.() ?? 6` (`:68-70`); `LIVE_SLACK_SEC = 2` (`:32`); then:

```ts
const isLive = !isPaused && behindLive <= targetDelay + LIVE_SLACK_SEC;   // :72
```

So **paused is never live**, and the badge tolerates 2 s of jitter on top of dash.js's own target delay before dropping out of LIVE.

`isReady` is `video.readyState >= 1` (`:81`). The VoD branch (`:84-96`) is reserved for future uploaded-file playback and is unreachable today — every stream the frontend can select is dynamic.

Any throw returns `null` (`:97-99`); `null` means "leave the previous state alone".

**`flush()`** (`:102-117`) — `readState()` then a `setState` that returns `prev` unchanged when all three booleans match **and** `playhead`, `duration`, `dvrStart`, `behindLive` are each within a **0.05 s dead-band** (`:106-114`). Without it, sub-frame float noise would re-render the entire controls tree on every tick.

**`setPlayer(p)`** (`:119-137`) — detaches the four listeners from the previous player, resets state to `INITIAL`, then binds `PLAYBACK_TIME_UPDATED`, `PLAYBACK_PAUSED`, `PLAYBACK_STARTED`, `PLAYBACK_SEEKED` → `flush` (`:132-135`).

**The 500 ms polling safety net** (`:143-146`): `setInterval(flush, 500)`. `PLAYBACK_TIME_UPDATED` stops firing when `currentTime` isn't advancing, but dash.js's internal 100 ms tick keeps sliding `range.start`/`range.end` — so **while paused, `behindLive` must keep growing**, and only the poll notices.

### 5.6 Absolute-seconds vs DVR-relative seeking

The whole hook's public surface is in **absolute presentation seconds**; `player.seek()` wants an **offset relative to `DVRWindow.start`**. The conversion happens once, at the boundary (comment `:165-171`):

| Function | Line | Implementation |
|---|---|---|
| `seekTo(absoluteSec)` | `:172-181` | `markUserSeek()`; `rel = Math.max(0, Math.round(absoluteSec - (win?.start ?? 0)))`; `p.seek(rel)` — note it uses the **raw** `win.start`, not the capped `dvrStart`, because that is the origin dash.js itself clamps against |
| `seekBy(deltaSec)` | `:183-191` | `markUserSeek()`; `p.seek(Math.max(0, Math.round(p.timeInDvrWindow() + deltaSec)))` |
| `seekToLive()` | `:193-200` | `markUserSeek()`; `p.seekToOriginalLive()` |
| `play` / `pause` / `togglePlay` | `:148-155` | Direct on the `<video>` element; `play()` rejections swallowed |

Targets are **rounded to whole seconds** deliberately: the display label has integer resolution, so fractional seeks add no accuracy but complicate the behind-live readout at the moment of the seek (`:169-171`).

### 5.7 Seekbar geometry

`Seekbar` maps the axis to exactly `[dvrStart, duration]` in absolute seconds (`Seekbar.tsx:66-67`, comment `:62-65`):

```
timeToX(t) = ((t - viewStart) / dvrWindowSize) * trackWidth     // :69-72
xToTime(x) = viewStart + (clamp(x,0,trackWidth)/trackWidth) * dvrWindowSize   // :74-78
```

`playheadX` is clamped into `[0, trackWidth]` (`:80-82`). Click/drag uses **pointer capture** on the track so the drag survives leaving the element (`:92-111`), and every move while captured issues a seek — i.e. scrubbing is live, not deferred to pointer-up. At live the fill is drawn to the full track width in red instead of at `playheadX` (`:160`, `:157`). The hover label shows `formatBehindLive(viewEnd - hoverSec)` (`:115-116`, `:131-138`).

### 5.8 Tab visibility

`Viewer.tsx:601-617`: on `visibilitychange`, if the document is being hidden the current `isLive` is latched into `wasAtLiveWhenHiddenRef`; on return, if it was live, `seekToLive()` fires and the latch resets. Rationale (`:589-596`): browsers throttle background-tab video (Chrome ~1 fps) while dash.js's `range.end` keeps advancing at wall-clock, so `currentTime` falls behind by the hidden duration. **DVR positions are deliberately not touched** — the user chose those.

---

## 6. Bounding-box pipeline

### 6.1 End-to-end path

```
backend WS  bbox_update
   │
   ▼  useWebSocket.onmessage                      (hooks/useWebSocket.ts:52-56)
bboxBufferRef            Array<BBoxMessage>, cap 500, drop-oldest
   │
   ▼  drainBboxBuffer()  — once per animation frame (Viewer.tsx:214-225, called at :434)
bboxGroupsRef            Map<pts, BBox[]>   ◄── THE HOT-PATH SOURCE OF TRUTH
   │                          ▲
   │                          └── history hydration via listBboxes()   (Viewer.tsx:324-353)
   │                          └── monotonic retention GC               (Viewer.tsx:237-251)
   │
   ├──► scheduleStateMirror() → setBboxGroups(new Map(...)) at most every 500 ms
   │        └──► PlayerControls → Seekbar → BBoxStrip   (React render path only)
   │
   ▼  RAF PTS-window match                        (Viewer.tsx:444-460)
activeBBoxesRef  +  recorderBBoxesRef
   │                    └──► useLiveRecorder composite (§8)
   ▼
BBoxOverlay's own RAF loop → drawBBoxes()        (BBoxOverlay.tsx:55-63, utils/drawing.ts:13)
```

### 6.2 `bboxGroupsRef` vs the `bboxGroups` state mirror

```ts
const bboxGroupsRef = useRef<Map<number, BBox[]>>(new Map());              // Viewer.tsx:112
const [bboxGroups, setBboxGroups] = useState(bboxGroupsRef.current);       // :113
const scheduleStateMirror = useCallback(() => {                           // :115-121
    if (stateMirrorTimerRef.current !== null) return;                     // leading-edge guard
    stateMirrorTimerRef.current = setTimeout(() => {
        stateMirrorTimerRef.current = null;
        setBboxGroups(new Map(bboxGroupsRef.current));
    }, 500);
}, []);
```

The ref is mutated in place by drain, GC and history merge. The state is a **≤2 Hz throttled clone**, consumed only by the React render path (`PlayerControls` → `Seekbar` → `BBoxStrip`). Rationale at `:105-111`: **30 bbox messages/sec × a full `Map` clone × a `Seekbar` re-render was saturating the main thread enough to stutter the `<video>` element.** The timer is cleared on unmount (`:122-124`).

### 6.3 `drainBboxBuffer` (`Viewer.tsx:214-225`)

Called first thing in the RAF loop (`:434`), so at most once per animation frame:

```ts
for (const msg of buf) {
    const existing = groups.get(msg.pts);
    if (existing) existing.push(...msg.bboxes);
    else groups.set(msg.pts, msg.bboxes);      // :221 — stores the payload array BY REFERENCE
}
buf.length = 0;                                 // :223 — truncate in place, same array identity
scheduleStateMirror();
```

Note the aliasing at `:221`: for a *new* pts the message's own `bboxes` array is adopted, and a later message for the same pts then `push`es into that same array — mutating an object that came off the WebSocket. Harmless here (nothing else retains the message), but it means `bboxGroupsRef` entries are not defensive copies.

### 6.4 Monotonic retention GC (`Viewer.tsx:235-251`)

```ts
const BBOX_CLEANUP_BUFFER_SEC = 30;                                        // :235
const minPts = Math.max(0, (dvr.state.dvrStart - 30) * PTS_TIMEBASE);      // :239
if (minPts <= maxDeletionPtsRef.current) return;                           // :240  MONOTONIC
maxDeletionPtsRef.current = minPts;
for (const pts of groups.keys()) if (pts < minPts) { groups.delete(pts); changed = true; }
```

Two guards, both deliberate (rationale `:227-234`):
- **`maxDeletionPtsRef` only ever advances.** A backward dip in `dvrStart` therefore **can never delete anything** — once bboxes are deleted they're gone until a page refresh, so the code refuses to act on backward movement.
- **A 30 s cushion below `dvrStart`**, so a small rewind or an MPD re-poll that momentarily nudges `dvrStart` forward doesn't evict pts that will shortly be visible again.

The ref is reset to `0` on stream select (`:288`) and on stop-watching (`:160`).

### 6.5 PTS ↔ `currentTime` synchronisation (`Viewer.tsx:431-473`)

One RAF loop, installed once, deps `[drainBboxBuffer, videoRef]`:

```ts
const currentPts = video.currentTime * PTS_TIMEBASE;   // :444   PTS_TIMEBASE = 90000  (:19)
const ptsPerFrame = 3000;                              // :445   90000/30 → HARDCODED 30 fps
const tolerance   = ptsPerFrame;                       // :446
const retentionWindow = ptsPerFrame * Math.max(0, retentionFramesRef.current - 1);  // :451
const lo = currentPts - retentionWindow;               // :452
const hi = currentPts + tolerance;                     // :453
```

Then a linear scan of `bboxGroupsRef` collecting every group whose key is in `[lo, hi]` into a fresh array, assigned to `activeBBoxesRef` and (gated on `showBBoxes`) to `recorderBBoxesRef`, bumping `activeVersionRef` (`:455-463`). When no stream is selected the arrays are emptied once (`:464-468`).

Three things to internalise:

1. **`video.currentTime * 90000` matches the backend's PTS only because the DVR stream's `currentTime` sits on the same absolute presentation clock** as the 90 kHz PTS the library posts. This is cross-component contract #1 — the same constant is declared in the library (`library/client/src/mp4/ffmpeg.rs:510`, `:622`), `backend/src/managers/bbox.py:26`, and **five** frontend files (`Viewer.tsx:19`, `PlayerControls.tsx:13`, `BBoxStrip.tsx:6`, `ClipOverlay.tsx:5`, `exportClip.worker.ts:20`).
2. **`ptsPerFrame = 3000` hardcodes 30 fps.** On a 25 fps or 60 fps source the retention window is the wrong number of frames (see [§12](#12-gotchas--limitations)).
3. **The window semantics:** `retentionFrames = N` shows the current frame plus `N−1` prior frames, and always carries a **1-frame forward tolerance** so bboxes that arrive a tick before the matching video frame still render (`:447-450`).

The loop is **deliberately not gated on `currentTime` having changed** (`:438-443`): browsers stutter their `currentTime` reporting even during active playback, and gating left the overlay painting a stale frame for **seconds**. Per-tick iteration is cheap (~9 000 keys max at 300 s × 30 fps).

### 6.6 `utils/drawing.ts`

**`COLORS`** (`:4-11`) — `person #0096FF`, `car #00C800`, `truck #FF6400`, `dog #C800C8`, `cat #FF0064`, `default #00C8C8`. Lookup is `COLORS[String(class_name).toLowerCase()] || COLORS.default` (`:52`).

**`drawBBoxes(ctx, bboxes, originalWidth, originalHeight, width, height, confidence)`** (`:13-92`):

1. Bail if any dimension is 0 (`:22-24`); compute `scaleX = width/originalWidth`, `scaleY = height/originalHeight` (`:26-27`).
2. Per bbox: skip if `bbox.confidence < resolveConfidence(bbox.class_name, confidence)` (`:34`).
3. **Validity guard** (`:43-50`) — skip when `!Number.isFinite(tl|br)`, `tl < 0`, `br < 0`, `tl >= maxIdx`, `br > maxIdx`, or `br <= tl`, where `maxIdx = originalWidth * originalHeight` (`:31`). The comment at `:36-40` explains why this matters: **JS `%` preserves sign**, so a negative index yields negative floor/mod results and would paint a rectangle across the whole frame; out-of-range values do the same at the right/bottom edge.
4. **1-D index → 2-D decode** (`:55-58`):
   ```
   y1 = Math.floor(tl / originalWidth)      x1 = tl % originalWidth
   y2 = Math.floor(br / originalWidth)      x2 = br % originalWidth
   ```
   This is cross-component contract #2. The backend performs **no** validation of these indices (`backend/src/utils/models.py:31-32`).
5. Scale, skip degenerate boxes (`w <= 0 || h <= 0`, `:69`), stroke at `lineWidth = 3` (`:72-74`), then draw a filled label `"<class> <confidence.toFixed(2)>"` in `bold 14px Arial` above the box (`:77-88`).

`ctx.save()`/`ctx.restore()` bracket the whole loop (`:29`, `:91`). The signature is `CanvasRenderingContext2D`, and the export worker casts its `OffscreenCanvasRenderingContext2D` through `as unknown as CanvasRenderingContext2D` (`exportClip.worker.ts:226`).

### 6.7 `utils/confidence.ts`

- **`ConfidenceSettings`** (`:6-9`) — `{ default, overrides }`; override keys are **lowercased** class names (invariant, `:3-5`).
- **`DEFAULT_CONFIDENCE`** (`:11-14`) — `{ default: 0.5, overrides: {} }`.
- **`resolveConfidence(className, settings)`** (`:19-26`) — `String(className).toLowerCase()`, look up `overrides`, else `default`. Everything goes through `String()` first **by design** so a numeric class ID like `12` and the literal `"12"` typed into the sub-menu match (`:16-18`).
- **`normalizeClassKey(raw)`** (`:30-33`) — `String(raw).trim().toLowerCase()`, `null` when empty. Used only by the confidence panel's add-override input (`SettingsMenu.tsx:249`).

### 6.8 `BBoxStrip` — 2-second clusters

Constants: `PTS_TIMEBASE = 90000`, `BUCKET_SEC = 2`, `UNKNOWN = '__unknown__'` (`:6-8`). `CLASS_ICON` maps `person/car/truck/dog/cat` to lucide icons (`:10-16`); anything else renders `HelpCircle` (`:19`).

The bucketing `useMemo` (`:66-94`) walks `bboxGroups`, converts each key to `sec = pts / 90000`, skips anything outside `[viewStart, viewEnd]` (`:71`), and buckets by `Math.floor(sec / 2)`. Confidence filtering happens **per bbox inside the bucket loop** (`:75`), and the bucket object is created lazily so a bucket where every detection is filtered out never appears (`:77-86`). `seconds` is stored as the **bucket centre**: `id * 2 + 1` (`:80`). Deps include `trackWidth` and `show`, so the memo recomputes on resize and on toggle.

`pickDominant` (`:43-50`) returns the **known** class with the highest count, and only falls back to `UNKNOWN` when no known class is present — known classes always beat unknowns even if outnumbered.

Rendering (`:100-120`): markers off-track by more than 8 px are culled (`:102`); each is a 16 px circular button positioned at `left: timeToX(b.seconds)` with `-translate-x-1/2`. Clicking **seeks to `bucketCenter − 1 s`** — i.e. the bucket's start — and stops propagation so the underlying track doesn't also seek (`:109`); `onPointerDown` is likewise stopped (`:110`). When hidden the component still renders a 16 px spacer so the controls don't reflow (`:96`).

`HoverCard` (`:126-158`) sorts rows by count descending with `UNKNOWN` forced last (`:131-135`) and clamps itself inside the track (`CARD_W = 54`, `:139-140`).

---

## 7. Clip export (WebCodecs)

Two halves: `hooks/useClipExport.ts` (main thread) and `workers/exportClip.worker.ts` (worker). The split exists for one concrete reason.

### 7.1 Why the MPD is parsed on the main thread

**`DOMParser` does not exist in a Web Worker.** This is stated at the very top of `utils/mpdParser.ts:1-3` and repeated at `useClipExport.ts:48-50` and `exportClip.worker.ts:25-28`. So `useClipExport` fetches the manifest, calls `parseMpd`, and hands the resulting **plain, structured-clonable object** (`SegmentTemplateInfo`) to the worker inside the job payload (`:105-117`). Everything after that — segment fetches, demux, decode, composite, encode, mux — happens off the main thread.

A parse/fetch failure here toasts and returns `false` **before the worker is even created** (`:55-60`).

### 7.2 `parseMpd(xml, manifestUrl)` (`utils/mpdParser.ts:30-87`)

**Selector cascade** (`:32-35`), first match wins:
1. `Representation SegmentTemplate`
2. `AdaptationSet SegmentTemplate`
3. `SegmentTemplate`

No match → `throw new Error('MPD has no SegmentTemplate — unsupported format')` (`:36`).

`repId` comes from the first `<Representation id>`, defaulting to `'stream0'` (`:38-39`). Both `initialization` and `media` have `$RepresentationID$` substituted (`:41-42`) — note **`.replace()` without `/g`, so only the first occurrence is substituted**, which is fine for ffmpeg's `init-$RepresentationID$.m4s` / `chunk-$RepresentationID$-$Number%05d$.m4s`.

Attribute defaults: `timescale` → `1000`, `startNumber` → `1`, `duration` → `0` (`:43-45`). `baseUrl` is the manifest URL truncated after its last `/` (`:47`).

**SegmentTimeline expansion** (`:49-67`): iterate `<S>` elements; `t` (when present) resets `currentTime`, `d` is the duration, `r` is the **repeat count** — so each `<S>` emits `r + 1` entries, each advancing `currentTime` by `d` and `number` by 1. Entries carry `startSec = currentTime/timescale` and `durationSec = d/timescale`.

**Fallback** (`:68-77`): with no `SegmentTimeline` but a fixed `duration` attribute, it synthesises exactly **200 segments** (`:70`) starting at `startNumber`. That cap is hardcoded and unrelated to the real DVR depth; it never triggers against this backend, which always emits `-use_timeline 1`.

**`formatSegmentUrl(tpl, number)`** (`:89-95`) matches `/\$Number(?:%0(\d+)d)?\$/`, zero-pads to the captured width, and resolves against `tpl.baseUrl`. **It is exported but never imported anywhere** — the worker carries its own copy (`exportClip.worker.ts:50-56`), because the shared `resolveDashUrl` falls back to `window.location.href` (`mpdParser.ts:25`) which does not exist in a worker; the worker's version uses `self.location.href` (`:44`).

### 7.3 `useClipExport` (main thread)

Returns `{ isExporting, progress, exportClip }` (`:121`). `progress` is `number | null` — `null` when idle, which is what `PlayerControls` tests to switch the save button into its "Saving… N%" state (`PlayerControls.tsx:249`).

| Step | Line | Detail |
|---|---|---|
| Re-entrancy guard | `:38` | `if (isExporting) return false` |
| Toast | `:41` | `toast.loading('Exporting clip… 0%')`, id reused for every later update |
| Absolute URL | `:44-46` | Prefixes `getBackendUrl()` unless already absolute |
| MPD fetch + parse | `:52-60` | Main thread; failure short-circuits |
| Worker | `:62-65` | `new Worker(new URL('../workers/exportClip.worker.ts', import.meta.url), { type: 'module' })` — Vite bundles it as a real ES-module worker |
| `progress` | `:79-81` | Updates state **and** the toast text |
| `done` | `:82-93` | `new Blob([buffer], {type:'video/mp4'})` → object URL → synthetic `<a download="clip-<ISO>.mp4">` appended, clicked, removed, **`URL.revokeObjectURL(url)` immediately after `click()`** |
| `error` / `onerror` | `:94-103` | `toast.error`, resolve `false` |
| Unmount | `:32-35` | Terminates any in-flight worker, so navigating away doesn't leave a transcode running |

The job payload (`:105-117`) contains `tpl`, `startPts`, `endPts`, `bboxEntries: Array.from(args.bboxGroups.entries())` (a `Map` is not structured-clonable across all paths here, and the array form is explicit), `showBBoxes`, `confidence`, `originalWidth`, `originalHeight`. **`args.videoId` is required by `ExportArgs` (`:9`) but is never sent and never used.**

### 7.4 The worker pipeline (`workers/exportClip.worker.ts`)

Constants: `PTS_TIMEBASE = 90000` (`:20`), `MAX_CLIP_DURATION_SEC = 300` (`:21`), `DEFAULT_FPS = 30` (`:22`).

1. **Validation** (`:87-92`) — `durationSec <= 0` → "Empty clip selection"; `> 300` → "Clip exceeds 300s cap"; non-positive resolution → "Video resolution not yet available". (`Viewer` also pre-checks the 300 s cap at `:553-556` with its own `MAX_CLIP_SEC`.)
2. **Covering-segment selection** (`:94-97`) — `tpl.timeline.filter(seg => seg.startSec + seg.durationSec > startSec && seg.startSec < endSec)`; empty → "No DASH segments available for the selected range".
3. **Init segment** (`:99`) — `fetchBuffer(tpl.initUrl)`.
4. **mp4box demux setup** (`:109-145`) — `createFile()`, then a promise around `file.onReady`: pick `info.videoTracks[0]` (or the first `type === 'video'`), record `TrackInfo`, then extract the **codec description**:
   ```ts
   const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];      // :129
   const avcC  = entry?.avcC ?? entry?.hvcC;                       // :130  H.264 or HEVC
   const stream = new Mp4DataStream(undefined, 0, Mp4DataStream.BIG_ENDIAN);  // :132
   avcC.write(stream);
   description = new Uint8Array(stream.buffer).slice(8);           // :134-135
   ```
   The `.slice(8)` strips the 8-byte box header (`size` + `type`) that `write()` emits, leaving the raw `AVCDecoderConfigurationRecord` — exactly what `VideoDecoder.configure({description})` expects. Then `setExtractionOptions(track.id, null, { nbSamples: 100 })` and `file.start()` (`:137-138`).
   Missing track info or description → "Failed to parse DASH init segment" (`:147`).
5. **Sample accumulation** (`:151-161`) — `file.onSamples` pushes `{data, cts, timescale, duration, is_sync}` into `samples`.
6. **Segment fetch loop** (`:164-176`) — each segment gets a monotonically advancing `fileStart` offset before `appendBuffer`. **A failed fetch is `console.warn`ed and skipped, not fatal** (`:172-174`) — a clip that straddles the DVR edge still exports with a hole. Progress is reported as `0.3 * ((i+1)/covering.length)` (`:175`). `file.flush()` (`:177`), then "No video samples decoded from DASH segments" if nothing landed (`:179`).
7. **Composite target** (`:181-183`) — `new OffscreenCanvas(originalWidth, originalHeight)`, `2d` context with `alpha: false`.
8. **Muxer** (`:185-190`) — `Mp4Muxer.Muxer` with `ArrayBufferTarget`, `video: {codec:'avc', width, height}`, `firstTimestampBehavior:'offset'`, `fastStart:'in-memory'`.
9. **Encoder** (`:192-207`) — output pipes straight into `muxer.addVideoChunk`. Config: `avc1.42001e` (Baseline 3.0) at `bitrate 4_000_000`, `framerate: DEFAULT_FPS`; if `isConfigSupported` says no, fall back to **`avc1.4d002a`** (Main 4.2) (`:204-206`).
10. **Decoder drive loop** (`:212-270`) — for each `output` frame:
    - `framePtsStreamUnits = frame.timestamp * track.timescale / 1e6`, then `framePts90k = framePtsStreamUnits * 90000 / track.timescale` (`:215-216`).
    - **Trim with ±3000 units (±1 frame at 30 fps) of slack** (`:217`): outside `[startPts−3000, endPts+3000]` the frame is closed and dropped.
    - `ctx.drawImage(frame, …)`, then if `showBBoxes`, `findClosestBboxGroup(bboxGroups, framePts90k, 6000)` (`:223`) — nearest pts group **within 6000 units ≈ 66 ms** (`:64-76`, linear scan, closest wins) — and `drawBBoxes` with the same confidence settings the live overlay uses.
    - **Re-timing to t = 0**: `relMicros = max(0, (framePtsStreamUnits − startPtsStreamUnits) * 1e6 / track.timescale)` where `startPtsStreamUnits = Math.round(startSec * track.timescale)` (`:210`, `:234`). So the exported MP4 starts at zero regardless of where in the DVR window the clip came from.
    - `new VideoFrame(canvas, {timestamp: relMicros, duration: 1e6/30})` (`:235-238`), `keyFrame = encodedFrames % 60 === 0` (`:239`) — a keyframe every 60 encoded frames (2 s at 30 fps).
    - The whole body is wrapped in try/catch that closes the frame and logs (`:244-247`), so one bad frame doesn't abort the export.
    - Decoder is configured with `{codec: track.codec, codedWidth/Height: track.width/height, description: desc}` (`:252-257`).
    - The feed loop converts each sample's `cts`/`duration` to microseconds and emits `EncodedVideoChunk` with `type: is_sync ? 'key' : 'delta'` (`:259-268`), posting progress **every 30th sample** as `0.3 + 0.6 * (i/samples.length)` (`:269`).
11. **Finish** (`:272-281`) — `decoder.flush()`, `encoder.flush()`, `muxer.finalize()`, both closed, `progress: 1`, return `target.buffer`.
12. **Transfer** (`:289`) — `post({type:'done', buffer}, [buffer])`. The `ArrayBuffer` is **transferred**, not copied: it is detached inside the worker, but the worker is terminated by the main thread immediately afterwards anyway.

**Progress fractions:** `0 → 0.3` segment fetch, `0.3 → 0.9` decode/encode, `1` on completion.

---

## 8. Live recording

`hooks/useLiveRecorder.ts`. **There is no `MediaRecorder` and no `captureStream()` here** — this is a hand-rolled WebCodecs `VideoEncoder` feeding `mp4-muxer`, exactly like the export worker, which is what makes bbox compositing possible.

Constants (`:7-10`): `FPS = 30`, `BITRATE = 8_000_000`, `BUFFER_SEC = 30`, `FRAME_INTERVAL_MS = 1000/30 ≈ 33.33`.

Props (`:12-20`): `videoRef`, `bboxesRef`, `originalWidth`, `originalHeight`, `confidence`, `showBBoxes`, `enabled`. Returns `{ recordingDuration, saveRecording }` (`:242`).

`confidence` and `showBBoxes` are mirrored into refs (`:49-52`) so slider changes never tear down the encoder.

### 8.1 Setup effect (`:73-192`)

Bails to `cleanup()` when `!enabled` or dimensions are unknown (`:74-77`); **keeps a running encoder if the canvas already matches the requested dimensions** (`:79-83`) so unrelated re-renders don't restart the buffer.

`enabled` is passed as **`isLive && selectedStreamId !== null`** (`Viewer.tsx:141`) — so the recorder is **torn down the instant the user seeks into DVR**, and rebuilt when they return to live. `recordingDuration` resets to 0 in `cleanup` (`:70`), which is why the save button reverts to its disabled "Save last 30s" form (`PlayerControls.tsx:262-273`).

The encoder's `output` callback (`:100-110`) is where the rolling buffer lives:

```ts
if (meta?.decoderConfig) decoderConfigRef.current = meta.decoderConfig;   // :101  cache it
chunksRef.current.push({ chunk, meta });
const cutoffUs = chunk.timestamp - BUFFER_SEC * 1_000_000;                // :105
while (buf.length > 0 && buf[0].chunk.timestamp < cutoffUs) buf.shift();  // :107  front-prune
setRecordingDuration(Math.min(30, Math.round(buf.length / FPS)));         // :109
```

Pruning is **relative to the newest chunk**, not to wall-clock — so a stalled encoder keeps its last 30 s rather than draining to empty.

**Codec choice** (`:114-124`): `avc1.42001e` — **Baseline profile, chosen explicitly so there are no B-frames**: chunks then sort cleanly by timestamp and there is no reorder delay to unwind at save time (comment `:114-115`). Fallback to `avc1.4d002a` when `isConfigSupported` rejects it.

### 8.2 The inline Blob-URL worker

```ts
const workerSrc = `
    let id;
    self.onmessage = (e) => {
        if (e.data === 'start') id = setInterval(() => self.postMessage('tick'), 33.33…);
        else if (e.data === 'stop') { clearInterval(id); id = null; }
    };
`;                                                                        // :135-141
const worker = new Worker(URL.createObjectURL(new Blob([workerSrc], {type:'text/javascript'})));  // :142
```

**Why a worker at all:** `requestAnimationFrame` is throttled (often to ~1 fps, sometimes stopped) in background tabs, which would freeze the rolling buffer exactly when a user is most likely to want the last 30 s. A `setInterval` inside a worker keeps ticking (comment `:132-134`).

Each `tick` (`:147-182`) bails unless the encoder is `configured` and `video.readyState >= 2` (`:152-153`), applies its own `FRAME_INTERVAL_MS − 2` rate limit (`:156`), then:

1. `ctx.drawImage(video, 0, 0, canvasW, canvasH)` (`:159`) — full source resolution.
2. If `showBBoxesRef.current`, `drawBBoxes(...)` with `bboxesRef.current ?? []` (`:160-170`) — that ref is `recorderBBoxesRef`, fed by the Viewer's RAF loop (`Viewer.tsx:462`) and already emptied when the overlay is toggled off.
3. `timestampUs = (performance.now() − startPerfRef.current) * 1000` (`:172`) — the recording clock is **wall-clock since encoder start**, not presentation time.
4. `keyFrame = frameCount % (FPS * 2) === 0` → **every 60 frames**, "so the buffer stays seekable after pruning" (`:177-178`).

The object URL created at `:142` is **never `revokeObjectURL`'d**, in `cleanup` (`:54-71`) or anywhere else.

### 8.3 `saveRecording()` (`:194-240`)

1. `await enc.flush()` when configured (`:196-198`); bail on an empty buffer (`:200`).
2. Sort a **copy** by timestamp (`:202`) — cheap insurance even though Baseline shouldn't reorder.
3. `firstKeyIdx = sorted.findIndex(c => c.chunk.type === 'key')`; **if there is no keyframe at all, return silently** (`:203-204`). Slice from there (`:205`).
4. **The subtle correctness fix** (`:208-213`): if the surviving first chunk lost its `decoderConfig` to pruning, re-attach the cached one:
   ```ts
   if (!valid[0].meta?.decoderConfig && decoderConfigRef.current)
       valid[0].meta = { ...valid[0].meta, decoderConfig: decoderConfigRef.current };
   ```
   Without this the muxer cannot write a valid `avcC` and the resulting MP4 is undecodable — and it happens on **every** save after the first 30 s, because the chunk carrying the original metadata is the very first one pruned.
5. Mux (`:216-226`) with the same options as the export worker; `dur = chunk.duration || 1e6/FPS`.
6. Download (`:228-236`) — `live-<ISO with : and . replaced by ->.mp4`, object URL revoked right after `click()`.
7. **Failures are reported only via `console.error('[LiveRecorder] mux failed', e)`** (`:238`) — no toast, unlike the export path.

---

## 9. State management

**No context, no store, no reducer.** `Viewer.tsx` is the single orchestrator: 15 `useState` hooks and ~20 refs, prop-drilled into `PlayerControls` (27 props) and `BBoxOverlay`.

### 9.1 Every `Viewer` ref and why it exists

| Ref | Line | Why it is a ref and not state |
|---|---|---|
| `confidenceRef` | `:39` | Read by `BBoxOverlay`'s RAF loop; state would re-install the loop on every slider nudge |
| `hideControlsTimeoutRef` | `:69` | Timer handle |
| `skipFeedbackTimeoutRef` / `skipFeedbackKeyRef` | `:72-73` | Timer handle + a monotonically increasing React `key` that restarts the CSS animation |
| `videoRef` | `:82` | The `<video>` element (via `VideoPlayer`'s imperative handle) |
| `containerRef` | `:83` | Letterbox measurement target |
| `playerBoxRef` | `:84` | Fullscreen request target |
| `selectedStreamIdRef` | `:85` | Lets WS callbacks and async continuations read the *current* selection without being in their dep arrays |
| `bboxGroupsRef` | `:112` | **Hot-path source of truth**; mutated in place |
| `stateMirrorTimerRef` | `:114` | 500 ms throttle handle |
| `activeBBoxesRef` | `:130` | Per-frame active set, consumed by the overlay's RAF |
| `activeVersionRef` | `:131` | Change counter; passed to `BBoxOverlay` and **ignored** there |
| `recorderBBoxesRef` | `:132` | Same set, but gated on `showBBoxes`, consumed by the recorder worker tick |
| `historyFetchedForRef` | `:152` | One-shot latch per stream for `listBboxes` |
| `maxDeletionPtsRef` | `:236` | Monotonic GC threshold ([§6.4](#64-monotonic-retention-gc-viewertsx235-251)) |
| `autoSelectedRef` | `:272` | One-shot latch for `?stream_id=` auto-select |
| `showBBoxesRef` / `retentionFramesRef` / `selectedStreamIdForAnimRef` | `:424-429` | Read inside the RAF loop, which must not be re-installed on every toggle |
| `prevConnectedRef` | `:262` | Edge-detects WS reconnects to trigger one refetch |
| `dvrRef` | `:597` | Gives the visibility listener the latest `dvr` object without re-registering it |
| `wasAtLiveWhenHiddenRef` | `:600` | Latches live-ness across a tab hide |

Elsewhere: `useWebSocket` keeps `wsRef`, `bboxBufferRef`, `reconnectTimeoutRef`, `mountedRef`, `onVideoUpdateRef`, `subscribedIdsRef`; `useDvrPlayer` keeps `playerRef`; `useLiveRecorder` keeps `encoderRef`, `decoderConfigRef`, `chunksRef`, `canvasRef`, `ctxRef`, `workerRef`, `frameCountRef`, `startPerfRef`; `useClipExport` keeps `activeWorkerRef`; `VideoPlayer` keeps `videoRef`, `playerRef`, `onPlayerReadyRef`.

### 9.2 The `playerReady` latch

```ts
useEffect(() => {                                     // Viewer.tsx:493-497
    if (selectedStreamId === null) return;
    if (!dvr.state.isReady || !dvr.state.isLive) return;
    setPlayerReady(true);
}, [selectedStreamId, dvr.state.isReady, dvr.state.isLive]);
```

**Set once, never demoted** — seeking into DVR does not flip it back (comment `:489-492`). It gates: the video's opacity transition (`:769`), the "Connecting to live…" spinner (`:783-790`), the click-to-play layer (`:795-801`, disabled while loading so a mis-click can't pause an invisible video), and `shouldShowControls` (`:703`). Reset to `false` only on stream select (`:306`) and stop-watching (`:167`).

`shouldShowControls = playerReady && (showControls || isPaused || !!clipSelection || exportProgress !== null)` (`:703`) — controls stay pinned while paused, while a clip selection exists, and for the whole duration of an export.

### 9.3 Letterboxing geometry

The effect at `:372-417` (deps `[selectedStreamId, originalRes]`) runs on mount, on `ResizeObserver` fire, and on the video's `loadedmetadata`/`resize`. It compares `containerAspect` to `videoAspect` (`:387`) and computes the **displayed** video rect plus the letterbox offset:

- container wider → full height, `xOffset = (containerW − displayW)/2`
- container taller → full width, `yOffset = (containerH − displayH)/2`

`setContainerSize` becomes the overlay canvas's `width`/`height` attributes and `setVideoOffset` its `left`/`top` (`:803-814` → `BBoxOverlay.tsx:68-77`). This is what keeps boxes aligned to the picture rather than to the black bars — the `<video>` itself uses `objectFit: 'contain'` (`VideoPlayer.tsx:265`).

### 9.4 Auto-hide controls

`CONTROLS_HIDE_MS = 3000` (`:22`). `resetHideControls()` (`:641-646`) shows the controls, clears any pending timer, and **returns early without re-arming when paused** — so a paused player keeps its controls. It is wired to `onMouseMove` on the player box (`:762`) and on the controls themselves (with `stopPropagation`, `:860`), plus every keyboard transport action. The controls container also stops `click`/`dblclick` propagation (`:861-862`) so clicking a button doesn't toggle play or fullscreen.

### 9.5 Keyboard shortcuts (`:659-687`)

Registered on `window` while a stream is selected, and ignored when the event target is an `INPUT`, `TEXTAREA` or `contentEditable` element (`:662-664`).

| Key | Action | Line |
|---|---|---|
| `Space` | Toggle play + reset hide timer | `:666-670` |
| `f` / `F` | Toggle fullscreen | `:670-673` |
| `Escape` | Cancel clip selection (if any) | `:673-675` |
| `ArrowLeft` | `handleSeekBy(-5)` + skip feedback | `:675-679` |
| `ArrowRight` | `handleSeekBy(+5)` + skip feedback | `:679-683` |

**±10 s is mouse-only** — the two `SkipBack`/`SkipForward` buttons (`PlayerControls.tsx:148-167`) have no keyboard binding, and the forward one is disabled at live. `handleSeekBy` also refuses forward seeks while live (`Viewer.tsx:529`). `frontend/README.md:72` says "arrow keys seek / skip", which is imprecise: arrows are ±5 s only.

### 9.6 Per-stream reset semantics

`handleStreamSelect(id)` (`:274-316`) — everything below is **per-stream, not global**:

| Reset | Line | Note |
|---|---|---|
| Unsubscribe the previous stream | `:281-283` | Only when switching, not on first select |
| `autoSelectedRef = true` | `:285` | Blocks the URL auto-select from firing later |
| `bboxGroupsRef` / `bboxGroups` / `historyFetchedForRef` / `maxDeletionPtsRef` | `:286-291` | Full bbox reset |
| `clipSelection = null` | `:292` | |
| `confidence = DEFAULT_CONFIDENCE` | `:295` | Overrides for one stream's class set aren't meaningful on another (`:293-294`) |
| `playbackRate = 1` | `:297` | Back to real time |
| `analyticsLocked = true`, `showBBoxes = false` | `:301-302` | Hides the overlay + strip until history lands, so the user never sees a partially-filled strip (`:298-300`) |
| `playerReady = false` | `:306` | |
| URL `stream_id` | `:307-311` | `{replace: true}` |
| `subscribe(id)` | `:312` | |

History is **not** fetched here — it is deferred to the effect at `:324-353`, which waits for `dvr.state.isReady`, because parsing a multi-megabyte bbox dump on the main thread while dash.js is booting is what made first-frame feel like "forever" (`:313-315`, `:318-323`). Its `finally` releases `analyticsLocked` and turns `showBBoxes` back on **whether the fetch succeeded or failed** (`:345-350`).

`handleStopWatching` (`:154-173`) performs the same resets and deletes the URL param; `handleStopWatchingWithUnsub` (`:355-358`) wraps it with the WS unsubscribe.

Other coordinated effects: playback rate is written to `video.playbackRate` (`:623-626`) and **auto-reset to 1× whenever the playhead reaches live** (`:628-636`, covers both "fast-forwarded into live" and "pressed Back to Live while at 2×"); the clip selection is dropped when the playhead goes live (`:503-505`) and when it slides off the left DVR edge (`:511-518`, otherwise the amber box renders at a negative pixel offset).

---

## 10. Styling

### Tailwind config (`tailwind.config.js`)

`content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"]` (`:5-8`). Extended palette (`:11-30`):

| Token | Value | Note |
|---|---|---|
| `background` | `#09090b` | Zinc 950 — the page background |
| `surface` | `#18181b` | Zinc 900 — cards, header, modals |
| `surface-hover` | `#27272a` | Zinc 800 |
| `border` | `#27272a` | Zinc 800 |
| `primary.DEFAULT` | `#6366f1` | Indigo 500 — the accent, and the playhead colour |
| `primary.hover` | `#4f46e5` | Indigo 600 |
| `primary.foreground` | `#ffffff` | |
| `success` | `#22c55e` | Declared; components mostly use raw `green-*` utilities |
| `warning` | `#f59e0b` | Declared; clip UI uses raw `amber-*` |
| `danger` | `#ef4444` | Used by `.btn-danger` |
| `info` | `#3b82f6` | Declared |

`fontFamily.sans = ['Inter','system-ui','sans-serif']` (`:31-33`); `plugins: []` (`:36`).

**The theme is hardcoded dark.** There is **no `darkMode` key**, no `dark:` variant anywhere, and no light palette — `body` is painted from `background` in `index.css:9`.

### `@layer components` classes (`index.css:14-42`)

`.btn` (base), `.btn-primary`, `.btn-secondary`, `.btn-danger`, `.btn-ghost`, `.card`, `.input`. Used across both pages; the player controls deliberately bypass them and use ad-hoc utilities so they can be translucent over video.

### z-index ladder inside the player (`Viewer.tsx`)

| Layer | z | Line |
|---|---|---|
| `<video>` (via `VideoPlayer`) | auto (0) | `:766-771` |
| Click-to-play surface | `z-[1]` | `:797` |
| Loading overlay ("Connecting to live…") | `z-[2]` | `:784` |
| Skip feedback badge (±Ns) | `z-[3]` | `:820` |
| Title overlay / bottom controls | `z-10` | `:833`, `:857` |

The overlay canvas sits between the video and the click surface with no explicit z-index (`BBoxOverlay.tsx:72`) — DOM order puts it above both, and `pointer-events-none` keeps clicks flowing through. Inside the controls: `BBoxStrip` markers `z-10`, its hover card `z-30` (`BBoxStrip.tsx:113`, `:144`), the seekbar hover label `z-20` (`Seekbar.tsx:133`), `ClipOverlay` `z-20` (`ClipOverlay.tsx:99`), `SettingsMenu` `z-50` (`SettingsMenu.tsx:65`). The app header is `z-50` (`Layout.tsx:21`) and `Modal` is `z-50` (`Modal.tsx:50`).

### Semantic colour coding

| Colour | Meaning | Examples |
|---|---|---|
| **Red** | Live | LIVE badge and live seekbar fill (`PlayerControls.tsx:100`, `Seekbar.tsx:157`), BACK TO LIVE (`:179-180`), "Save last 30s" (`:277`) |
| **Indigo (`primary`)** | Playhead / active DVR position, sliders, active nav tab | `Seekbar.tsx:157`, `SettingsMenu.tsx:120`, `Layout.tsx:46` |
| **Amber** | Clip selection | Clip range chip (`PlayerControls.tsx:107`), `ClipOverlay` box (`ClipOverlay.tsx:99`), "Save clip" (`:289`) |
| **Green** | Streaming / live in the library | `StatusBadge` streaming (`Management.tsx:15`), StreamCard "Live" (`StreamCard.tsx:18`), Start action (`Management.tsx:272`) |
| **Orange** | Transitioning (`initializing` / `terminating`) | `Management.tsx:23`, `:31`, Stop action (`:281`) |
| **Zinc** | Stopped / disabled | `Management.tsx:38` |

Detection-box colours are a **separate palette** in `utils/drawing.ts:4-11` and are not Tailwind tokens.

---

## 11. Build / dev / env

### Scripts (`package.json:6-11`)

| Script | Command | Notes |
|---|---|---|
| `dev` | `vite` | Dev server on `0.0.0.0:5174` |
| `build` | `tsc -b && vite build` | **`tsc -b` runs first — any type error fails the build** |
| `lint` | `eslint .` | Flat config |
| `preview` | `vite preview` | Serves `dist/` |

**Package manager is `bun`** — `bun install`, `bun run dev`, `bun run build`. Never npm or yarn. moon's `frontend:dev` task runs `bun run dev` and pulls in `backend:dev`. No lockfile is committed (all lockfiles are gitignored repo-wide).

### `vite.config.ts`

```ts
plugins: [react()],
server: { host: '0.0.0.0', port: 5174 }
```

- `host: '0.0.0.0'` — reachable from the LAN (matching the backend's bind).
- **Port 5174.** `frontend/README.md:41` says 5173; **the config is authoritative**.
- **There is no `server.proxy`.** All API traffic goes cross-origin directly to `http://localhost:8702`, so the backend's permissive CORS (`allow_origin_regex=".*"`) is a hard requirement, not a convenience.

### Environment

Only one variable, typed at `src/vite-env.d.ts:3-5`:

| Variable | Default in `.env.example` | Read at |
|---|---|---|
| `VITE_BACKEND_URL` | `http://localhost:8702` | `api/client.ts:5` |

`cp .env.example .env` before the first `bun run dev`. Vite **inlines** the value at build time; the only runtime override is `localStorage.backend_url` ([§3](#3-api-layer)).

### TypeScript

Solution-style: `tsconfig.json` has `files: []` and references `tsconfig.app.json` (`include: ["src"]`) and `tsconfig.node.json` (`include: ["vite.config.ts"]`).

App options (`tsconfig.app.json`): `target/lib ES2022` + `DOM`, `module ESNext`, `moduleResolution: "bundler"`, `jsx: "react-jsx"`, `noEmit`, `strict`, `noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`, `noFallthroughCasesInSwitch`, `noUncheckedSideEffectImports`, `skipLibCheck`, `allowImportingTsExtensions`, `moduleDetection: "force"`.

> **`verbatimModuleSyntax: true`** (`tsconfig.app.json:14`) — type-only imports are **not** elided automatically, so **every type import must be written `import type { … }`**. This is why the codebase reads `import type { VideoInfo } from '../types'` (`api/streams.ts:2`) and `import { resolveConfidence, type ConfidenceSettings } from './confidence'` (`utils/drawing.ts:2`) everywhere. Getting it wrong is a build error, not a warning.

`noUnusedLocals` + `noUnusedParameters` are also why the "unused" items in [§12](#12-gotchas--limitations) are *exports* and *props* — those don't trip the compiler.

`types: ["vite/client"]` (`tsconfig.app.json:8`) plus the DOM lib is what supplies the WebCodecs typings (`VideoEncoder`, `VideoDecoder`, `VideoFrame`, `EncodedVideoChunk`, `OffscreenCanvas`).

### ESLint (`eslint.config.js`)

Flat config: `globalIgnores(['dist'])`, applied to `**/*.{ts,tsx}` with `js.configs.recommended`, `tseslint.configs.recommended`, `reactHooks.configs.flat.recommended`, `reactRefresh.configs.vite`; `ecmaVersion: 2020`, `globals.browser`. **Not wired into `build`** — `bun run lint` is a separate, manual step.

### Dependencies

| Package | Version | Purpose |
|---|---|---|
| `react` / `react-dom` | `^19.2.0` | UI runtime |
| `react-router-dom` | `^7.9.6` | `BrowserRouter`, `useSearchParams`, `useNavigate`, `Link` |
| `dashjs` | `^5.1.1` | DASH/DVR playback. **The two documented races (`_composePeriods`, GapController) are specific to this line** |
| `axios` | `^1.13.2` | REST client + upload progress events |
| `mp4box` | `^2.3.0` | Demuxing DASH segments and extracting `avcC`/`hvcC` in the export worker |
| `mp4-muxer` | `^5.2.2` | MP4 muxing for both clip export and live recording |
| `react-hot-toast` | `^2.6.0` | All user-facing notifications |
| `lucide-react` | `^0.554.0` | Every icon, including the bbox-strip class glyphs |
| `clsx` | `^2.1.1` | Conditional class strings |
| `tailwind-merge` | `^3.4.0` | **UNUSED** — not imported anywhere in `src/` |

Dev: `vite ^7.2.4`, `@vitejs/plugin-react ^5.1.1`, `typescript ~5.9.3`, `tailwindcss ^3.4.18`, `postcss ^8.5.6`, `autoprefixer ^10.4.22`, `eslint ^9.39.1` + `@eslint/js`, `typescript-eslint ^8.46.4`, `eslint-plugin-react-hooks ^7.0.1`, `eslint-plugin-react-refresh ^0.4.24`, `globals ^16.5.0`, `@types/node ^24.10.1`, `@types/react ^19.2.5`, `@types/react-dom ^19.2.3`.

`postcss.config.js` is the standard `{ tailwindcss: {}, autoprefixer: {} }`. `index.html` is minimal: `<div id="root">` + `<script type="module" src="/src/main.tsx">`, title "Video Player", favicon `/vite.svg`.

---

## 12. Gotchas & limitations

### Platform / capability

- **WebCodecs + `OffscreenCanvas` are required for clip export and live recording, and there is NO feature detection and no fallback.** In practice this means **Chromium only**. In Firefox/Safari, `new VideoEncoder(...)` throws inside `useLiveRecorder`'s async IIFE, gets swallowed by `catch (e) { console.error('[LiveRecorder] init failed', e); cleanup(); }` (`useLiveRecorder.ts:185-188`), `recordingDuration` stays 0, and the "Save last 30s" button simply **stays disabled forever with no explanation** (`PlayerControls.tsx:262-273`). Clip export at least surfaces a toast via the worker's `error` message. Nothing tells the user their browser is unsupported.
- **The `<video>` element is not muted and has no `playsInline`, while `autoPlay` is enabled** (`VideoPlayer.tsx:153` third arg `true`; the element at `:261-266` sets only `disablePictureInPicture` and styling). Chrome's autoplay policy blocks unmuted autoplay without a prior user gesture — playback never starts, `isLive` never becomes true, and the **"Connecting to live…" spinner persists indefinitely** (because `playerReady` is gated on `isReady && isLive`). The stream *is* audio-less (`-an` on both ffmpeg outputs), so `muted` would cost nothing.
- **30 fps is assumed in three independent places**: `ptsPerFrame = 3000` (`Viewer.tsx:445`), `DEFAULT_FPS = 30` (`exportClip.worker.ts:22`), `FPS = 30` (`useLiveRecorder.ts:7`). None of them consults `VideoInfo.fps`, which the backend does provide. On a 25 fps or 60 fps source the retention window covers the wrong number of frames, exported clips are re-timed at the wrong nominal rate, and `recordingDuration` (`buf.length / 30`) misreports the buffered seconds.

### Known bugs / dead code

- `App.css` (42 lines) and `src/assets/react.svg` are **never imported** — Vite scaffold leftovers.
- `tailwind-merge` is a **declared dependency that is never imported**.
- `tailwind.config.js:2` does `const colors = require('tailwindcss/colors')` — a **CommonJS `require()` in a file that then uses `export default`**, in a `"type": "module"` package. The binding is never used. It works today only because Tailwind's config loader tolerates it; it is a latent breakage.
- `api/client.ts:31` exports `setBackendUrl`, which is **never called** anywhere in `src/`.
- `utils/mpdParser.ts:89` exports `formatSegmentUrl`, which is **never imported** — the worker duplicates it (`exportClip.worker.ts:50`) because the shared `resolveDashUrl` references `window.location.href` (`mpdParser.ts:25`), absent in workers.
- `useWebSocket.ts:29`: `.replace(/^https/, 'wss')` is **unreachable** — the preceding `.replace(/^http/, 'ws')` already consumed the prefix. Behaviour is still correct.
- `ExportArgs.videoId` (`useClipExport.ts:9`) is a **required field that is never used** — it isn't in the worker job payload.
- `BBoxOverlay`'s `versionRef` prop is passed (`Viewer.tsx:805`) and **deliberately ignored** (`BBoxOverlay.tsx:14-17`, not destructured at `:30-40`).
- `Management.tsx:199` declares `grid-cols-1 md:grid-cols-3` but renders only **two** stat cards, so the row is always short one column on `md+`.
- The live recorder's inline worker object URL (`useLiveRecorder.ts:142`) is **never `revokeObjectURL`'d** — one leaked blob URL per recorder (re)initialisation.
- `useClipExport.ts:91` calls `URL.revokeObjectURL(url)` **synchronously right after `a.click()`**. It works in current Chromium (the download is already queued) but is racy by spec; the same pattern is in `useLiveRecorder.ts:236`.
- `saveRecording` reports failures **only to `console.error`** (`useLiveRecorder.ts:238`) — inconsistent with the toast-driven export path. A silent no-op also occurs when there is no keyframe in the buffer (`:204`) or the buffer is empty (`:200`).
- `drainBboxBuffer` (`Viewer.tsx:221`) stores the WebSocket message's `bboxes` array **by reference** for a new pts, then `push`es into that same array for later messages — aliasing the received payload.
- `Modal.tsx:36` resets `document.body.style.overflow = 'unset'` in **every** cleanup run, including when the modal was closed and never locked scroll. With two modals open in sequence, the later cleanup can unlock scroll while another modal is still open. (In practice `Management` shows one at a time.)
- `frontend/README.md:41` says the dev server is on **5173**; `vite.config.ts:8` says **5174**.
- `frontend/README.md:72` says "arrow keys seek / skip"; arrows are **±5 s only** — ±10 s is mouse-only.
- The `[DVR-DRIFT]` interceptor (`VideoPlayer.tsx:211-238`) monkey-patches `currentTime` on the element and **never restores the original descriptor**; the effect cleanup (`:245-257`) doesn't `delete` it. Harmless because the element is discarded with the component, but it means every player instance leaves a patched accessor behind.

### Architectural limits

- **No error boundary** anywhere. A render-time throw blanks the app.
- **No loading skeletons** on the Viewer grid; an empty list and a not-yet-fetched list look identical.
- **No pagination or virtualisation** — `Management` renders every video as a table row, `BBoxStrip` renders a DOM button per 2-second bucket (up to ~150 at a full 300 s window).
- **Two WebSocket connections** exist across a session (one per page component), and neither ever sends a ping.
- **All bbox state is per-page-load.** Navigating from `/viewer` to `/` and back unmounts `Viewer`, drops `bboxGroupsRef`, and re-hydrates only the retained backend window.
- **No accessibility pass**: the seekbar is a `div` with pointer handlers (no `role="slider"`, no keyboard focus), the click-to-play surface is a bare `div`, and `BBoxStrip` markers carry only a generic `aria-label="bbox cluster"`.
- **No tests, no CI** anywhere in the repo. Verification is manual.

### Edge cases handled well — **preserve these**

These look like they could be simplified. They cannot; each is a fix for an observed failure.

| Behaviour | Location | Why it must stay |
|---|---|---|
| **Monotonic bbox GC** with a 30 s cushion | `Viewer.tsx:235-251` | A backward dip in `dvrStart` would otherwise permanently delete bboxes that are still inside the backend's retention window — irrecoverable without a page refresh |
| **`dvrWindowSize` capping** by `VideoInfo.dvr_window_seconds` | `useDvrPlayer.ts:61-63`, `Viewer.tsx:98-101` | dash.js's `getDvrWindow().size` jitters by tens of seconds; capping pins the seekbar's left edge |
| **0.7 s hysteresis** on the behind-live label | `PlayerControls.tsx:75-80` | `behindLive` jitters ~50–100 ms because `duration` ticks on dash.js's 100 ms wallclock and `playhead` on the frame cadence; a naive round flips the displayed integer every tick |
| **0.05 s dead-band** in `flush()` | `useDvrPlayer.ts:106-114` | Stops float noise from re-rendering the whole controls tree on every event |
| **`decoderConfig` re-attach** on save | `useLiveRecorder.ts:208-213` | Without it, every save after the first 30 s produces an undecodable MP4 |
| **Malformed 1-D index guards** | `utils/drawing.ts:43-50` | The backend does not validate corners; a negative index would paint a full-frame rectangle |
| **Subscription replay on every WS (re)open** | `useWebSocket.ts:43-45` | Makes `subscribe()` safe before the socket opens and restores state after every 2 s reconnect |
| **Export tolerates missing segments** | `exportClip.worker.ts:172-174` | A clip straddling the DVR edge still exports instead of failing outright |
| **Deferred history hydration** | `Viewer.tsx:324-353` | Parsing a large bbox dump while dash.js boots made first frame feel like "forever" |
| **RAF (not `setInterval`) for the overlay** | `BBoxOverlay.tsx:7-12` | `setInterval` was throttled under CPU pressure and the overlay stalled for seconds |
| **Worker `setInterval` for the recorder** | `useLiveRecorder.ts:132-142` | RAF is throttled in background tabs, which froze the rolling buffer |
| **500 ms state mirror throttle** | `Viewer.tsx:115-121` | 30 msg/s × Map-clone × Seekbar re-render was stuttering the `<video>` element |
| **No stall/buffer-empty seek-to-live handler** | `VideoPlayer.tsx:168-175` | Bounced every DVR seek back to live |
