# Video Player — repo guide

A video streaming/playing application in three components. A server orchestrates FFmpeg to expose each uploaded video over two parallel protocols; a browser UI plays the DASH feed with full DVR and renders AI detections as synced overlays; a native C library consumes the low-latency feed and pushes analytics back.

| Component | Language / stack | Docs |
|---|---|---|
| [`backend/`](backend/CLAUDE.md) | Python 3.11, FastAPI, FFmpeg subprocesses | [`docs/backend.md`](docs/backend.md) |
| [`frontend/`](frontend/CLAUDE.md) | Vite, React 19, TypeScript, Tailwind, dash.js | [`docs/frontend.md`](docs/frontend.md) |
| [`library/`](library/CLAUDE.md) | Rust (cdylib), statically-linked decoder-only FFmpeg, + Python & Rust wrappers | [`docs/library.md`](docs/library.md) |

Each component has its own `CLAUDE.md` (the operational contract — read it before editing that component) and a matching exhaustive reference under `docs/`. The `README.md` files are the human-facing feature descriptions and are kept separate from these.

The library is the only component that is not a single flat crate. Its layout is load-bearing — the build scripts, the Rust wrapper's `SO_PATH`, and the Python wrapper's `parents[3]` resolution all assume this exact nesting:

```
library/
  client/      the cdylib crate (src/, build.rs, Cargo.toml)
  wrappers/    python-wrapper/ and rust-wrapper/ — example hosts
  assets/      the workflow diagram
  *.sh         the three build phases: download → dependencies → library
```

---

## Architecture

```
                       ┌──────────────────────────────────────────┐
   upload .mp4  ────►   │  backend  (FastAPI, port 8702)           │
                       │                                          │
                       │   ONE ffmpeg subprocess per stream        │
                       │        │                                  │
                       │        ├─ output 1: DASH  (libx264)       │
                       │        │    ./dash_streams/<id>/*.mpd     │
                       │        │    2s segments, 300s DVR window  │
                       │        │                                  │
                       │        └─ output 2: fMP4  (-c:v copy)     │
                       │             stdout ─► ProgressiveHub      │
                       │             200ms fragments, fan-out      │
                       └───────┬──────────────────────┬────────────┘
                               │                      │
             GET /dash/<id>/manifest.mpd    GET /progressive/<id>/prog.m4s
                               │                      │
                    ┌──────────▼─────────┐   ┌────────▼──────────────┐
                    │     frontend       │   │       library         │
                    │  dash.js + DVR     │   │  libclient_video.so   │
                    │  canvas overlay    │   │  H.264/HEVC → RGB24   │
                    └──────────▲─────────┘   └────────┬──────────────┘
                               │                      │
                     WS /ws  bbox_update     POST /bboxes/  {stream_id, bboxes[]}
                               │                      │
                               └──────── backend ◄────┘
                                    (stores 305s, broadcasts)
```

The browser **never** touches the progressive fMP4 path — DASH is its only playback route. The library **never** touches DASH. The two paths come from the same ffmpeg process but are otherwise independent.

---

## Cross-component contracts

Three invariants span all three components. Breaking any of them breaks the system silently — no type checker or test will catch it.

### 1. The 90 kHz PTS clock

Every presentation timestamp in the system is in MPEG-TS 90 kHz units. The same constant is declared independently in all three components and **must stay in lockstep**:

| Component | Declaration |
|---|---|
| library | `rational(1, 90_000)` — `library/client/src/mp4/ffmpeg.rs:510` (stream default) and `:622` (`av_rescale_q` target in `rescale_90k`) |
| backend | `STANDARD_TIME_BASE = 90000.0` — `backend/src/managers/bbox.py:26` |
| frontend | `PTS_TIMEBASE = 90000`, re-declared in **five** files — `pages/Viewer.tsx:19`, `components/player/PlayerControls.tsx:13`, `components/player/BBoxStrip.tsx:6`, `components/player/ClipOverlay.tsx:5`, `workers/exportClip.worker.ts:20` |

The chain: the library decodes a frame, converts its PTS to 90 kHz, and hands it to the host's frame callback. The host puts that exact value in the bbox JSON. The backend stores it and derives `absolute_timestamp_ms = stream_start_time_ms + pts/90000*1000`. The frontend matches it against `video.currentTime * 90000` — which works only because the DVR stream's `currentTime` sits on the same absolute presentation clock.

### 2. Bounding-box corner encoding

`top_left_corner` and `bottom_right_corner` are **flattened 1-D pixel indices**, not `(x, y)` pairs:

```
y = idx // width          x = idx % width
```

Decoded in `frontend/src/utils/drawing.ts`. The backend does **not** validate them — it stores whatever it is given. The frontend guards defensively against non-finite, negative, out-of-range and inverted values, because a negative index would otherwise paint a full-frame rectangle (JS `%` preserves sign).

`confidence` is the one field with real validation: `ge=0, le=1` in `backend/src/utils/models.py`, enforced as a 422.

**The `id` round-trip.** Each bbox carries an optional caller-supplied `id` (the wrappers send a uuid4). The backend stores it and echoes it back in the `POST /bboxes/` response, the `bbox_update` WebSocket event, and `GET /bboxes/{video_id}`. This is not cosmetic: the library's `PostResultsCallback` pairs each detection with its `absolute_timestamp_ms` by id, and its response decoder requires the field. Remove `id` from `BBoxData` and that callback goes permanently silent while everything else still appears to work.

### 3. The 300-second DVR window

The number is derived **once**, in the backend, as `DASH_SEGMENT_DURATION × DASH_WINDOW_SIZE` (2 × 150). It is then:

- passed to ffmpeg as `-window_size 150`,
- served to clients as `VideoInfo.dvr_window_seconds`,
- used by the frontend to **cap** `dash.js`'s jittery `getDvrWindow().size` so the seekbar's left edge stops bouncing,
- and used by the backend to derive bbox retention as that value **+ 5 s margin** = 305 000 ms.

Retuning the encoder window automatically retunes retention and the UI. Keep it derived — never hardcode 300 anywhere.

### Naming quirk worth knowing

One concept, three names. `BBoxCreate.stream_id` (request) → `video_id` (internal) → `source_id` (response, and the library's FFI argument). They are all the same integer.

---

## Running the whole thing

The dev loop is driven by [**moon**](https://moonrepo.dev) (`.moon/workspace.yml`). There is no `run_local.sh` — it was replaced by moon tasks.

```bash
# backend + frontend together — this is the everyday command
moon run frontend:dev
```

`frontend:dev` depends on `frontend:install`, `backend:install` and `backend:dev`. Both `dev` tasks are `preset: 'server'` (persistent), so moon runs the two servers side by side rather than waiting for one to exit.

```bash
moon run backend:dev     # backend alone
moon run :install        # sync both dependency sets, start nothing
```

`install` tasks run `uv sync` / `bun install` automatically, so there is no separate setup step. Copy `frontend/.env.example` → `frontend/.env` once; `backend/.env` already exists (`APP_PORT=8702`).

Only `backend` and `frontend` are registered as moon projects. The library is built by shell scripts and is deliberately outside the dev loop — see [`library/CLAUDE.md`](library/CLAUDE.md).

### Ports

| Service | Port | Notes |
|---|---|---|
| backend | **8702** | binds `0.0.0.0`; overridable via `APP_PORT` in `backend/.env` |
| frontend dev server | **5174** | binds `0.0.0.0`; `frontend/README.md` says 5173 — the config is authoritative |
| library → backend | 8702 | baked in at **compile time** from the `B2B_URL` env var (`library/client/src/state.rs:20`); `./build_library.sh` hard-fails if unset. Must be a **bare origin with no path prefix** — `http://127.0.0.1:8702` |

> Changing `APP_PORT` does **not** reach the library: its URL is fixed at build time, so a port change requires rebuilding the `.so` with a matching `B2B_URL`.

---

## Conventions

**Python — always `uv`.** `uv run <cmd>`, `uv sync`, `uv add`. Never `source .venv/bin/activate`, never bare `python`/`pip`.

**Frontend — always `bun`.** `bun install`, `bun run dev`, `bun run build`. Never npm or yarn.

**Build only what you touched.** Changed only frontend files? Don't run `cargo` or touch the backend. Changed only the library? Don't run the frontend build. Each component builds independently.

**READMEs describe features, not internals.** They name shell scripts and user-facing config, not internal `.py`/`.ts`/`.rs` paths. Keep implementation detail in `docs/` and `CLAUDE.md`.

---

## Repo-wide facts

- **No tests anywhere. No CI.** Verification is manual: start a stream, load the viewer, watch the DVR seekbar populate, POST a bbox, confirm it renders on the right frame.
- **No authentication on any surface**, and backend CORS is fully open (`allow_origin_regex=".*"` with credentials). Anyone reachable on the LAN can upload, start/stop streams, POST analytics and delete videos. This is a LAN dev tool, not an internet-facing service.
- **No database.** All backend state is in-process memory. A backend restart — including a `--reload` restart on any code edit — **deletes every uploaded video** and all retained bboxes.
- **Media is transient.** `.gitignore` excludes `*.mp4`, `*.so`, `*.mpd`, `*.m4s`, `Cargo.lock`, `library/dependencies/`, `target/`, `node_modules/`, and all lockfiles (`uv.lock`, `bun.lock*`, `package-lock.json`).
- `test_videos/` holds sample inputs (gitignored contents).
- `assets/` holds the screenshots referenced by the root README.
- External binaries required on `PATH` for the backend: **`ffmpeg` and `ffprobe`**. Neither is checked at startup.
- The backend is **POSIX-only** (`os.setsid`, `os.getpgid`, `os.killpg`, `preexec_fn`).

---

## Where to look

| Question | Go to |
|---|---|
| How does an FFmpeg command get built, and why each flag? | [`docs/backend.md` §5](docs/backend.md#5-ffmpeg-orchestration) |
| What does the WebSocket protocol look like in both directions? | [`docs/backend.md` §4](docs/backend.md#4-websocket-protocol) |
| Why is that dash.js setting there? | [`docs/frontend.md`](docs/frontend.md) — DASH/DVR section |
| How do bboxes get from the network onto the canvas? | [`docs/frontend.md`](docs/frontend.md) — bbox pipeline section |
| What's the C API, and where's the header? | [`docs/library.md`](docs/library.md) — C ABI reference |
| How do I build the Rust library offline? | [`docs/library.md`](docs/library.md) — build system section |
| What breaks if I "simplify" this constant? | The **Do not touch** section of the relevant `CLAUDE.md` |
