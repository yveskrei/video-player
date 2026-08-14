# backend/ — agent contract

## What this is

Async FastAPI app (Python ≥3.11, FastAPI 0.109) serving on port **8702**, orchestrating **one FFmpeg subprocess per stream**. That single subprocess emits **two parallel outputs**: a re-encoded DASH ladder with a 300 s DVR window (for browsers) and a zero-copy progressive fMP4 remux on stdout (for the Rust library). It also ingests AI bounding boxes over REST and fans them out on a global WebSocket.

**No database.** All state lives in process memory (`utils/storage.py`) and is lost on restart.

## Commands

Driven by [moon](https://moonrepo.dev) from the repo root:

```bash
moon run backend:install    # uv sync
moon run backend:dev        # uv run python src/main.py  (persistent server)
moon run frontend:dev       # backend + frontend together — the everyday command
```

Equivalent by hand, from `backend/`: `uv sync` then `uv run python src/main.py`.

- **Always `uv run ...`.** Never `source .venv/bin/activate`, never bare `python` / `pip`.
- **The port comes from `APP_PORT`** in `backend/.env` (default `8702`), read by the `__main__` block at the bottom of `src/main.py`. moon injects it via `options.envFile: '.env'`. `.env` is gitignored (`*.env`); `.env.example` is committed.
- `src/main.py` passes uvicorn the **`"main:app"` import string**, not the app object — passing the object disables `reload=True`. It resolves because `src/` is on `sys.path`; see Layout.
- The `dev` task is `preset: 'server'` (persistent). It never exits; don't wait on it in a script.
- Only build/check this component when only backend files changed. Don't run frontend or `cargo` checks for a backend-only edit.

## Layout

All Python lives under `backend/src/`, which is a layered DAG — `utils` ← `managers` ← `routers` ← `main`. Runtime data dirs sit **beside** `src/`, not inside it.

```
backend/
  src/
    main.py                app, lifespan, CORS, media serving, /ws
    managers/  stream.py   FFmpeg spawn, ProgressiveHub, MP4 box parsing, lifecycle FSM
               video.py    upload, ffprobe metadata, VideoInfo, delete
               bbox.py     bbox ingest, PTS→wall-clock, retention, broadcast dispatch
               websocket.py connection registry, subscriptions, sync→async bridge
    routers/   videos.py  streams.py  bboxes.py
    utils/     storage.py  models.py  enums.py
  videos/  dash_streams/  progressive_streams/     runtime, gitignored
```

| File | Lines | Role |
|---|---|---|
| `main.py` | 216 | App construction, lifespan, CORS, DASH/progressive media endpoints, `/ws`, catch-all 404 |
| `managers/stream.py` | 571 | Core — FFmpeg command build + spawn, `ProgressiveHub` fan-out, MP4 box parsing, lifecycle FSM |
| `managers/video.py` | 184 | Upload, ffprobe metadata, `VideoInfo` assembly, delete |
| `managers/bbox.py` | 156 | Bbox ingest, PTS→wall-clock, retention window, broadcast dispatch |
| `managers/websocket.py` | 98 | Connection registry, per-video subscriptions, broadcast, sync→async bridge |
| `utils/storage.py` | 31 | In-memory singleton + the three storage path constants |
| `utils/models.py` | 42 | Four Pydantic v2 models |
| `utils/enums.py` | 27 | Three `str, Enum` classes |
| `routers/videos.py` | 36 | `/videos/*` |
| `routers/streams.py` | 28 | `/streams/*` |
| `routers/bboxes.py` | 26 | `/bboxes/*` |
| `pyproject.toml` | — | Deps, plus the hatchling build backend that puts `src/` on `sys.path` |
| `.python-version` | — | `3.11` |

## Module conventions

Every module follows this exact shape. Apply it to any file you add or touch.

```python
"""One-line module docstring."""
import asyncio
import logging
from pathlib import Path
from fastapi import HTTPException

# Custom modules
from utils.storage import storage
from utils.enums import StreamStatus

# Variables
logger = logging.getLogger(__name__)
DASH_SEGMENT_DURATION = 2
```

- Stdlib and third-party imports first, **no blank lines between them**.
- One blank line, then `# Custom modules`, then every internal import, no blank lines between them.
- One blank line, then `# Variables` (only if the module has module-level globals), then every global, no blank lines between them.
- **Exactly one blank line** between all top-level components thereafter — functions, classes, everything. This deviates from PEP 8's two-blank-line rule on purpose, so **do not run stock `black`/`ruff format`**; it would revert the whole file.
- Comments and docstrings stay short and to the point — one line where the intent isn't obvious. No per-parameter documentation. The exception is empirical rationale (see "Do not touch"): condense it, never delete it.

## Rules & conventions

- **State is 100 % in-memory.** ⚠️ **A restart DELETES EVERY UPLOADED VIDEO** — shutdown `rmtree`s `videos/`, `dash_streams/`, `progressive_streams/` (`main.py:40-48`). Under `--reload` this means **every code edit you make wipes the user's uploads.** Warn before touching backend files during a live demo.
- **POSIX-only**: `os.setsid` (`preexec_fn`), `os.getpgid`, `os.killpg`, `SIGTERM`/`SIGKILL`. No Windows support.
- `ffmpeg` and `ffprobe` must be on `PATH` and are **never checked at startup**. A missing binary surfaces as a `400 "Invalid video file: …"` on upload, or a `500` on stream start.
- Handlers in `routers/streams.py` are **sync `def` on purpose** (`routers/streams.py:10,17,24`) — FastAPI runs them in the threadpool, and `StreamManager` uses a blocking `threading.Lock`. **Do not convert them to `async def`.**
- `POST /bboxes/` is `async def` (`routers/bboxes.py:13`) because it needs the running loop for `asyncio.create_task`.
- **One environment variable: `APP_PORT`.** Every other knob is a module constant: `managers/stream.py:21-25` (`DASH_SEGMENT_DURATION=2`, `DASH_WINDOW_SIZE=150`, `INIT_TIMEOUT=20`), `utils/storage.py:9-12` (the three storage paths), `managers/bbox.py:24-26` (`RETENTION_MARGIN_SEC=5`, `RETENTION_PERIOD_MS`, `STANDARD_TIME_BASE=90000.0`).
- **`pyproject.toml` is the only dependency source.** `requirements.txt` was deleted — it duplicated the same five pins and drifted.
- **Imports never carry a `src.` prefix.** `pyproject.toml` declares a hatchling build with `sources = ["src"]`, so `uv sync` installs the project editable and drops a `.pth` pointing at `backend/src`. Write `from managers.stream import StreamManager`, `from utils.models import BBoxData`. **After adding a dependency or changing the build config, re-run `moon run backend:install`** or the path can go stale.
- **No `__init__.py` anywhere** — these are PEP 420 namespace packages. Don't add them: `.gitignore:5` ignores that filename repo-wide, so they would be silently untracked.
- **Storage paths are absolute, anchored to `backend/` via `__file__`** (`utils/storage.py:9-12`), so they do not depend on the CWD. Defined once — never re-spell the literals. `videos/`, `dash_streams/` and `progressive_streams/` always land beside `src/`.
- **`main.py` chdirs into `src/` before starting uvicorn**, so the reloader watches source only. uvicorn's `WatchFilesReload` *discards* any `reload_dirs` entry beneath `Path.cwd()` and watches the CWD instead (`watchfilesreload.py:70-75`), so making `src/` the CWD is the only way to scope it. Don't reintroduce a CWD-relative path — it would resolve inside `src/`.
- **Naming quirk:** `BBoxCreate.stream_id` (`utils/models.py:38`) **is the video_id** — used as `video_id = bbox_data.stream_id` (`managers/bbox.py:48`) — and the POST response calls it `source_id` (`managers/bbox.py:106`). Three names, one concept.
- bbox corners (`utils/models.py:31-32`) are **flattened 1-D pixel indices**: `y = idx // width`, `x = idx % width`. Not `(x, y)` pairs. The backend does **not** validate range or ordering; only `confidence` has a real validator (`ge=0, le=1`, `utils/models.py:34`).
- All PTS is **90 kHz** (`STANDARD_TIME_BASE = 90000.0`, `managers/bbox.py:26`). Must stay in lockstep with the library's `rational(1, 90_000)` (`library/client/src/mp4/ffmpeg.rs:510`, `:622`) and the frontend's five `PTS_TIMEBASE` declarations.
- **`BBoxData.id` is load-bearing, not decoration.** It is an optional caller-supplied string echoed back in the POST response, the WS broadcast and `GET /bboxes/{video_id}`. The Rust library's response decoder requires it and uses it to pair detections with `absolute_timestamp_ms`; drop the field and its `PostResultsCallback` silently never fires.
- **No tests, no CI.** Verification is manual: start a stream, load the frontend, watch the DVR seekbar populate, POST a bbox and confirm it renders.

## Do not touch without re-testing playback

Each of these is an empirical fix with an in-source post-mortem. Read the comment above the line before changing it.

| Thing | Location | Failure it prevents |
|---|---|---|
| `-extra_window_size 30` | `managers/stream.py:468` (rationale `:465-467`) | The earlier 5-segment (10 s) margin caused an **oldest-edge freeze** — dash.js requesting the oldest segment while ffmpeg had already unlinked it |
| `MIN_READY_SEGMENTS = 3` | `managers/stream.py:334` (rationale `:330-333`) | dash.js 5.1.1 race in `StreamController._composePeriods`: with a 1-segment MPD, `addDVRMetric` silently fails and `STREAMS_COMPOSED` never fires |
| `-probesize 5M -analyzeduration 5M` | `managers/stream.py:442-443` (rationale `:440-441`) | Reduced from 50M/100M — deep probing delayed the first segment by seconds and tripped `INIT_TIMEOUT` |
| `-c:v copy` on the progressive branch | `managers/stream.py:479` (rationale `:435-436`) | Reverts a ~2× CPU regression from running a second encoder for the progressive output |
| `_pending_broadcasts` strong-ref set | `managers/bbox.py:15` (used at `:102-103`) | Without it the GC dropped in-flight `create_task` broadcasts, so bboxes only appeared after a page refresh |

**Derived-constant rule:** `DASH_SEGMENT_DURATION * DASH_WINDOW_SIZE` (`managers/stream.py:21-22`) is the *single source* of the 300 s number. `dvr_window_seconds` reads it (`managers/stream.py:120`, `managers/video.py:91`) and bbox retention derives from it plus a 5 s margin (`managers/bbox.py:25`). Changing one auto-tunes the other — **keep it that way**; never hardcode 300 or 305000.

## Security posture

LAN dev tool, **not internet-facing**:

- **No authentication anywhere.** No API keys, no sessions.
- CORS is fully open: `allow_origin_regex=".*"` with `allow_credentials=True` (`main.py:58`).
- `GET /dash/{video_id}/{filename:path}` joins user input into a path with **no traversal guard** (`main.py:73`).
- `POST /bboxes/cleanup` is an unauthenticated destructive operation (`routers/bboxes.py:23`).
- The server binds `0.0.0.0`, so anyone on the network can upload, start/stop streams, and delete videos.

Don't "fix" these silently — they are intentional for LAN use. Flag them if the deployment target changes.

## Reference

Full detail: [`../docs/backend.md`](../docs/backend.md).

1. File-by-file breakdown
2. Data models
3. API surface
4. WebSocket protocol
5. FFmpeg orchestration
6. Progressive fMP4 pipeline
7. Concurrency model
8. Storage layout & cleanup
9. Configuration constants
10. End-to-end traces
11. Application lifecycle
12. Gotchas & limitations

Feature-level overview: [`README.md`](README.md).
