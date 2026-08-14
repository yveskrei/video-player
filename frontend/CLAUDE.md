# frontend/ — agent contract

## What this is

Vite 7 + React 19 + TypeScript + Tailwind 3 SPA. Two routes: **`/`** (Management — video library, upload, start/stop) and **`/viewer`** (dash.js DVR player + canvas bbox overlay + in-browser clip export + in-browser live recording). Talks to the FastAPI backend (default `http://localhost:8702`) over REST plus **one global WebSocket** at `/ws`.

No state library — no Redux, no Zustand, no Context. `pages/Viewer.tsx` is the single orchestrator; hot paths use refs.

## Commands

```bash
cd frontend && bun install       # install deps
cp .env.example .env             # sets VITE_BACKEND_URL=http://localhost:8702
bun run dev                      # dev server on 0.0.0.0:5174
bun run build                    # tsc -b && vite build  — type errors FAIL the build
bun run lint                     # eslint . (not wired into build)
```

Or via [moon](https://moonrepo.dev) from the repo root — the everyday path:

```bash
moon run frontend:dev            # starts the backend too (dep on backend:dev)
moon run frontend:install        # bun install only
```

- **Always `bun`.** Never npm, never yarn. No lockfile is committed.
- `frontend:dev` declares `backend:dev` as a dependency. Both are `preset: 'server'` (persistent), so moon runs them in parallel — this pair replaced the old `run_local.sh`.
- Only build/check this component when only frontend files changed. Don't run `cargo` or touch the backend for a frontend-only edit.

## Layout

| Path | Lines | Role |
|---|---|---|
| `src/main.tsx` | 10 | `createRoot` + `StrictMode` |
| `src/App.tsx` | 33 | `BrowserRouter`, `Toaster`, routes `/`, `/viewer`, `*`→`/` |
| `src/index.css` | 49 | Tailwind layers, Inter font, `.btn`/`.card`/`.input`, `skipFade` |
| `src/api/client.ts` | 40 | Base-URL resolution + axios instance |
| `src/api/streams.ts` | 45 | `listVideos`, `uploadVideo`, `deleteVideo`, `startStream`, `stopStream`, `listBboxes` |
| `src/types/index.ts` | 58 | All shared DTOs |
| `src/components/VideoPlayer.tsx` | 270 | dash.js lifecycle, `updateSettings`, watchdog, `[DVR-DRIFT]` interceptor |
| `src/components/BBoxOverlay.tsx` | 79 | Overlay canvas + its own RAF draw loop |
| `src/components/{Layout,Modal,StreamCard}.tsx` | 66/92/42 | Shell, generic modal, stream grid card |
| `src/components/player/PlayerControls.tsx` | 307 | Transport bar, LIVE/−MM:SS label, 4-state save button |
| `src/components/player/Seekbar.tsx` | 177 | DVR track geometry, `formatBehindLive` |
| `src/components/player/BBoxStrip.tsx` | 158 | 2 s detection clusters |
| `src/components/player/ClipOverlay.tsx` | 124 | Draggable clip range |
| `src/components/player/SettingsMenu.tsx` | 383 | main / confidence / speed views |
| `src/hooks/useDvrPlayer.ts` | 203 | `DvrState` math + absolute-seconds seek API |
| `src/hooks/useWebSocket.ts` | 116 | WS, 2 s reconnect, subscription replay, 500-msg bbox ring |
| `src/hooks/useClipExport.ts` | 122 | Main-thread half of clip export |
| `src/hooks/useLiveRecorder.ts` | 243 | 30 s rolling WebCodecs buffer + save |
| `src/pages/Management.tsx` | 467 | Library table + upload/delete/info modals |
| `src/pages/Viewer.tsx` | 896 | Player page — orchestrates everything |
| `src/utils/{confidence,drawing,mpdParser}.ts` | 33/92/95 | Thresholds, canvas drawing, MPD → `SegmentTemplateInfo` |
| `src/workers/exportClip.worker.ts` | 295 | Fetch → demux → decode → composite → encode → mux |
| `src/App.css`, `src/assets/react.svg` | — | **DEAD** — never imported |

## Rules & conventions

- **WebCodecs, Chromium-only.** Clip export and live recording use `VideoEncoder`/`VideoDecoder`/`OffscreenCanvas` with **no feature detection and no fallback**. There is **no `MediaRecorder` anywhere in this codebase** — don't "restore" one. On unsupported browsers the recorder fails into a `console.error` (`useLiveRecorder.ts:185-188`) and the save button just stays disabled.
- **Progressive fMP4 URLs are DISPLAY-ONLY.** `VideoInfo.prog_url` / `prog_init_url` are rendered as text in the Management info modal and nowhere else. `src/types/index.ts:14-16` says so explicitly: *"The frontend player does NOT consume them — DASH is the only playback path. Don't wire these into anything."*
- **Hot paths use refs, not state.** `bboxGroupsRef` (`Viewer.tsx:112`) is the source of truth, mutated in place. The `bboxGroups` **state** (`:113`) is a **500 ms throttled clone** (`scheduleStateMirror`, `:115-121`) that exists *only* so the Seekbar/BBoxStrip can render. 30 msg/s × Map-clone × Seekbar re-render was stuttering the `<video>` element.
- **`verbatimModuleSyntax: true`** (`tsconfig.app.json:14`) ⇒ **every type import must be `import type { … }`**. Getting it wrong is a build error.
- **`bun run build` runs `tsc -b` first**, so type errors fail the build. `noUnusedLocals`/`noUnusedParameters` are on.
- **StrictMode double-invokes effects in dev** (`main.tsx:7`). All setup/teardown here is idempotent by design — e.g. `VideoPlayer.tsx:25` bails when a player already exists. Keep it that way.
- **Dev port is 5174** (`vite.config.ts:8`), not 5173. `frontend/README.md:41` is wrong; the config is authoritative.
- **No `server.proxy`.** All API traffic is cross-origin to port 8702, so the backend's open CORS is a hard requirement.
- **Base URL:** `localStorage.getItem('backend_url')` **wins over** `VITE_BACKEND_URL` (`api/client.ts:5`); trailing slashes are stripped because `http://host//ws` is rejected by FastAPI (`:10`). `setBackendUrl` (`:31`) is exported but never called — a devtools escape hatch.
- **90 kHz PTS contract.** `PTS_TIMEBASE = 90000` is re-declared in **five** files: `pages/Viewer.tsx:19`, `components/player/PlayerControls.tsx:13`, `components/player/BBoxStrip.tsx:6`, `components/player/ClipOverlay.tsx:5`, `workers/exportClip.worker.ts:20`. Must stay in lockstep with `backend/src/managers/bbox.py:26` and the library's `rational(1, 90_000)` (`library/client/src/mp4/ffmpeg.rs:510`, `:622`). Matching works because the DVR stream's `video.currentTime` is on the same absolute presentation clock (`Viewer.tsx:444`).
- **bbox corners are flattened 1-D pixel indices**, not `(x, y)`: `y = floor(idx / originalWidth)`, `x = idx % originalWidth` (`utils/drawing.ts:55-58`). The backend does **not** validate them; the guard at `drawing.ts:43-50` is load-bearing — JS `%` preserves sign, so a negative index would paint a full-frame rectangle.
- **30 fps is assumed in three places** — `ptsPerFrame = 3000` (`Viewer.tsx:445`), `DEFAULT_FPS` (`exportClip.worker.ts:22`), `FPS` (`useLiveRecorder.ts:7`). None reads `VideoInfo.fps`. Fixing that means fixing all three together.
- **No tests, no CI.** Verification is manual: start a stream, open `/viewer`, watch the DVR seekbar populate, POST a bbox and confirm it renders on the right frame.

## Do not touch without re-testing playback

Each is an empirical fix with a written post-mortem in the source. **Read the comment above the line before changing it.**

| Thing | Location | Failure it prevents |
|---|---|---|
| The **entire `player.updateSettings` block** | `VideoPlayer.tsx:62-151` | Every field is a separate post-mortem — see below |
| ↳ `utcSynchronization: { enabled: false }` | `:87` (rationale `:63-86`) | The direct-UTC value was captured once at init, so `clientServerTimeShift` drifted more negative each second, freezing `range.end` — observed as **−90 s backward snaps** |
| ↳ `applyServiceDescription` / `applyProducerReferenceTime: false` | `:94-95` (rationale `:88-93`) | ffmpeg's `-ldash 1` advertises LL-DASH; dash.js auto-enables catch-up and drags the playhead to live, **breaking DVR seeks** |
| ↳ `delay.liveDelay: 6.0` + `useSuggestedPresentationDelay: false` | `:96` | Fixed 6 s target delay; also the `useDvrPlayer` fallback (`:68-70`) |
| ↳ the whole `liveCatchup` disable block | `:97-102` | No rate catch-up, `maxDrift: 0`, `playbackRate {min:0,max:0}` |
| ↳ the `gaps` block | `:113-118` (rationale `:104-112`) | GapController jumped forward at the oldest DVR edge into segments ffmpeg had already deleted — **jump to −3:30 then hard freeze**. `liveCatchup.enabled:false` does **NOT** cover this |
| ↳ `timeShiftBuffer.calcFromSegmentTimeline: false` | `:130` (rationale `:122-129`) | Pins wall-clock range derivation so a dash.js update can't silently switch to segment-timestamp mode and reintroduce live-edge jitter |
| ↳ the `buffer` block | `:143-149` (rationale `:132-142`) | The old 20 s `bufferToKeep` with no prune interval accumulated stale segments until **MSE hit its quota** — playability degraded from the oldest side toward live until even live froze |
| readyState watchdog (10 s / 3 retries) | `:177-198` (`:27`, `:34`) | dash.js 5.1.1 `_composePeriods` race: `STREAMS_COMPOSED` never fires and playback never starts |
| `[DVR-DRIFT]` currentTime interceptor | `:205-239` | **Intentional diagnostics, left installed on purpose.** Monkey-patches `currentTime` per player instance and never restores it. Paired with `markUserSeek()` (`useDvrPlayer.ts:160-163`) |
| Monotonic `maxDeletionPtsRef` GC | `Viewer.tsx:235-251` | A backward dip in `dvrStart` would permanently delete bboxes still inside the backend's retention window (30 s cushion, threshold only advances) |
| 500 ms state-mirror throttle | `Viewer.tsx:115-121` | Per-message setState cascades stuttered the `<video>` element |
| Blob-URL worker timer in the recorder | `useLiveRecorder.ts:132-142` | RAF is throttled in background tabs, which froze the 30 s rolling buffer. A `setInterval` inside a worker keeps ticking |
| `dvrWindowSize` capping | `useDvrPlayer.ts:61-63` + `Viewer.tsx:98-101` | dash.js's `getDvrWindow().size` jitters by tens of seconds; the cap comes from backend-advertised `VideoInfo.dvr_window_seconds`. **Never hardcode 300** |
| No stall / buffer-empty seek-to-live handler | `VideoPlayer.tsx:168-175` | Those events fire on every normal seek round-trip; seeking to live on them bounced every DVR click back to live |
| `decoderConfig` re-attach on save | `useLiveRecorder.ts:208-213` | Without it, every save after the first 30 s produces an undecodable MP4 |

## Reference

Full detail: [`../docs/frontend.md`](../docs/frontend.md).

1. File-by-file breakdown
2. Type definitions
3. API layer
4. Routing & pages
5. DASH / DVR playback
6. Bounding-box pipeline
7. Clip export (WebCodecs)
8. Live recording
9. State management
10. Styling
11. Build / dev / env
12. Gotchas & limitations

Feature-level overview: [`README.md`](README.md).
