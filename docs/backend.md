# Backend Reference

Exhaustive technical reference for `backend/`. For the short operational contract, see [`backend/CLAUDE.md`](../backend/CLAUDE.md). For the feature-level overview, see [`backend/README.md`](../backend/README.md).

**What it is:** an async FastAPI app (Python ≥3.11, FastAPI 0.109) that orchestrates one FFmpeg subprocess per stream. That single subprocess produces **two parallel outputs**: a re-encoded DASH ladder with a 300-second DVR window (for browsers), and a zero-copy progressive fMP4 remux on stdout (for the Rust client library). It also ingests AI bounding boxes over REST and fans them out over a global WebSocket.

There is **no database**. All state is in-process memory and is lost on restart.

---

## Table of contents

1. [File-by-file breakdown](#1-file-by-file-breakdown)
2. [Data models](#2-data-models)
3. [API surface](#3-api-surface)
4. [WebSocket protocol](#4-websocket-protocol)
5. [FFmpeg orchestration](#5-ffmpeg-orchestration)
6. [Progressive fMP4 pipeline](#6-progressive-fmp4-pipeline)
7. [Concurrency model](#7-concurrency-model)
8. [Storage layout & cleanup](#8-storage-layout--cleanup)
9. [Configuration constants](#9-configuration-constants)
10. [End-to-end traces](#10-end-to-end-traces)
11. [Application lifecycle](#11-application-lifecycle)
12. [Gotchas & limitations](#12-gotchas--limitations)

---

## 1. File-by-file breakdown

All Python lives under `backend/src/`. Paths in this document are relative to that
directory. The layering is a strict DAG — `utils` ← `managers` ← `routers` ← `main`
— and there are no import cycles.

```
backend/
  src/
    main.py
    managers/  stream.py  video.py  bbox.py  websocket.py
    routers/   videos.py  streams.py  bboxes.py
    utils/     storage.py  models.py  enums.py
  videos/  dash_streams/  progressive_streams/     runtime data, beside src/
```

| File | Lines | Role |
|---|---|---|
| `main.py` | 216 | App construction, lifespan, CORS, media-serving endpoints, WebSocket endpoint, catch-all 404 |
| `managers/stream.py` | 571 | The core — FFmpeg orchestration, `ProgressiveHub` fan-out, MP4 box parsing, lifecycle FSM |
| `managers/video.py` | 184 | Upload handling, ffprobe metadata extraction, `VideoInfo` assembly, delete |
| `managers/bbox.py` | 156 | Bbox ingest, PTS→wall-clock conversion, retention window, broadcast dispatch |
| `managers/websocket.py` | 98 | Connection registry, per-video subscriptions, broadcast, sync→async bridge |
| `utils/storage.py` | 31 | In-memory singleton + the three storage path constants |
| `utils/models.py` | 42 | Four Pydantic v2 models |
| `utils/enums.py` | 27 | Three `str, Enum` classes |
| `routers/videos.py` | 36 | `/videos/*` endpoints |
| `routers/streams.py` | 28 | `/streams/*` endpoints |
| `routers/bboxes.py` | 26 | `/bboxes/*` endpoints |

### Module conventions

Every module in `src/` follows one shape. Match it in anything you add.

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

| Rule | Detail |
|---|---|
| Import order | Stdlib and third-party first, **no blank lines between them** |
| `# Custom modules` | One blank line, then the label, then every internal import with no blank lines between them |
| `# Variables` | One blank line, then the label, then every module-level global with no blank lines between them. Present only when the module has globals |
| Spacing | **Exactly one blank line** between all top-level components — functions, classes, everything |
| Docstrings | One line per module and per non-obvious function. No per-parameter documentation |
| Comments | Short and to the point. The one exception is empirical rationale (see [§12](#12-gotchas--limitations)) — condense it, never delete it |

> The one-blank-line rule deviates from PEP 8, which mandates two. A stock
> `black` or `ruff format` run would revert every file, so the project does not
> use one.

**Imports never carry a `src.` prefix.** `pyproject.toml` declares a hatchling
build with `sources = ["src"]`, so `uv sync` installs the project editable and
writes a `.pth` pointing at `backend/src`. Modules are therefore imported as
`managers.stream`, `utils.models`, `routers.videos`.

### `utils/enums.py`

All three are `str, Enum` subclasses, so they JSON-serialize as bare strings and compare `==` against raw strings arriving over the wire.

- **`StreamStatus`** (`utils/enums.py:4`) — `STOPPED="stopped"`, `INITIALIZING="initializing"`, `STREAMING="streaming"`, `TERMINATING="terminating"`.
- **`WebSocketEventType`** (`utils/enums.py:10`) — server→all: `VIDEO_UPDATE="video_update"`; server→subscribers: `BBOX_UPDATE="bbox_update"`; client→server: `SUBSCRIBE_VIDEO`, `UNSUBSCRIBE_VIDEO`, `PING`; server reply: `PONG="pong"`.
- **`VideoUpdateReason`** (`utils/enums.py:21`) — `CREATED`, `DELETED`, `STREAM_INITIALIZING`, `STREAM_STARTED`, `STREAM_STOPPED`, `STREAM_ERROR`.

### `utils/storage.py`

`class Storage` is a plain in-memory singleton, instantiated at import time as the module global `storage` (`utils/storage.py:32`).

| Field | Type | Contents |
|---|---|---|
| `videos` | `Dict[int, dict]` | video_id → raw dict (`id`, `name`, `file_path`, `created_at`, `width`, `height`, `fps`). Note: raw dicts, **not** `VideoInfo` — that is built on demand. |
| `active_streams` | `Dict[int, dict]` | video_id → `{status, process, pid, start_time_ms, dash_manifest_url, prog_init_ready, hub}` (written at `managers/stream.py:497-505`) |
| `bboxes` | `Dict[int, Dict[int, List[dict]]]` | video_id → pts → list of enriched bbox dicts |
| `next_video_id` | `int` | starts at `1` |
| `video_storage_path` | `Path` | `VIDEO_STORAGE_PATH` — absolute, `backend/videos`. `mkdir(exist_ok=True)` runs **at import time** (`utils/storage.py:25`), before the lifespan hook |

`get_next_video_id()` (`utils/storage.py:27`) returns the current value then increments. Not lock-protected — safe only because all callers run on the event loop.

### `managers/websocket.py`

**Module globals:**
- `_event_loop` (`:12`), set once by `set_event_loop(loop)` (`:14`) from the lifespan hook.
- **`broadcast_sync(coro)`** (`:18`) — the bridge that lets **sync threads** (the FFmpeg monitor threads) schedule a coroutine on the event loop: `asyncio.run_coroutine_threadsafe(coro, _event_loop)`, guarded by `if _event_loop and not _event_loop.is_closed()`. Fire-and-forget — the returned `Future` is discarded, so exceptions inside the coroutine are swallowed.

**`class ConnectionManager`** (`:23`), instantiated as the module global `manager` (`:98`):

| Method | Line | Behaviour |
|---|---|---|
| `connect(ws)` | `:31` | `await ws.accept()`, then add to `connections` under `_lock` |
| `disconnect(ws)` | `:36` | Discard from `connections` **and from every** video subscription set; deletes emptied sets |
| `subscribe(ws, video_id)` | `:44` | Add to `video_subscriptions[video_id]` |
| `unsubscribe(ws, video_id)` | `:50` | Remove; delete the key when the set empties |
| `_send_to_connections(conns, msg)` | `:57` | `json.dumps` once, then **sequentially** `await ws.send_text(...)` per socket. Failures mark the socket dead; dead sockets are then purged from `connections` and all subscription sets under the lock |
| `broadcast_video_update(video_id, reason, video_data)` | `:78` | Builds `{"type","reason","video"}` and sends to a **copy** of all connections. `video_id` is accepted but never used |
| `broadcast_bbox(video_id, data)` | `:93` | Sends `data` verbatim to a copy of `video_subscriptions[video_id]` (empty set if none) |

### `managers/video.py`

`class VideoManager` — all static methods, never instantiated.

- **`_get_video_properties(file_path) -> dict`** (`:22`) — blocking `subprocess.run` of:
  ```
  ffprobe -v error -select_streams v:0 -show_entries stream=width,height,avg_frame_rate -of json <file>
  ```
  Parses `streams[0]`, splits `avg_frame_rate` as `"num/den"`, computes `fps = num/den`. Raises `ValueError` for: no streams, missing or `"0/0"` frame rate, `den == 0`, width/height falsy or ≤0, `fps <= 0`, `CalledProcessError`, `JSONDecodeError`, or anything else (all wrapped). Returns `{"width": int, "height": int, "fps": float}`.
- **`_build_video_info(video_id) -> VideoInfo`** (`:70`) — merges `storage.videos[video_id]` with the live `active_streams` record. With no active stream, `stream_status=STOPPED` and `stream_start_time_ms` / `dash_manifest_url` / `prog_url` / `prog_init_url` are all `None`. `dvr_window_seconds` is **always** `DASH_SEGMENT_DURATION * DASH_WINDOW_SIZE` = 300.
- **`create_video(file, name)`** (`:92`) — async; see [trace 10.1](#101-upload-a-video).
- **`get_video(video_id)`** (`:144`) — 404 if unknown.
- **`list_videos()`** (`:150`) — iterates `list(storage.videos.keys())` (snapshot, to avoid mutation-during-iteration).
- **`delete_video(video_id)`** (`:154`) — 404 if unknown; **400 if `video_id in storage.active_streams`** ("stop the stream first"); unlinks the file; deletes from `storage.videos`; `storage.bboxes.pop(video_id, None)`; broadcasts `deleted` with a **partial** payload `{"id", "stream_status"}`, not a full `VideoInfo`.

### `managers/bbox.py`

Module global **`_pending_broadcasts: set[asyncio.Task]`** (`:13`) — holds strong references so the GC cannot drop in-flight `create_task` broadcasts. The comment at `:9-12` documents the bug this fixed: bboxes only appearing after a page refresh.

Class constants:

| Constant | Value | Line |
|---|---|---|
| `RETENTION_MARGIN_SEC` | `5` | `:28` |
| `RETENTION_PERIOD_MS` | `(DASH_SEGMENT_DURATION * DASH_WINDOW_SIZE + RETENTION_MARGIN_SEC) * 1000` = **305 000** — symbolic on purpose, so retuning the encoder window auto-retunes retention | `:29` |
| `STANDARD_TIME_BASE` | `90000.0` (MPEG-TS 90 kHz) | `:30` |

| Method | Line | Behaviour |
|---|---|---|
| `_pts_to_ms(pts)` | `:33` | `int((pts / 90000.0) * 1000)` |
| `_cleanup_old_bboxes(video_id, now_ms)` | `:37` | cutoff = `now_ms - 305000`; deletes any pts group whose **first** element's `absolute_timestamp_ms` is below cutoff |
| `add_bboxes(bbox_data, ws_manager)` | `:50` | See [trace 10.3](#103-bbox-post--websocket--client) |
| `list_bboxes(video_id)` | `:120` | Returns `{"video_id", "stream_start_time_ms", "groups": [{"pts","bboxes"}]}` sorted by pts ascending. 404 if the video is unknown |
| `cleanup_all_old_bboxes()` | `:142` | Drops whole `storage.bboxes[video_id]` entries for videos that no longer exist; otherwise runs `_cleanup_old_bboxes` per video |

### `managers/stream.py`

`logging.basicConfig(level=logging.INFO)` at `:16` — the module configures **root** logging globally on import.

**`class ProgressiveHub`** (`:29`) — one-producer / many-consumer fan-out:

| Method | Line | Behaviour |
|---|---|---|
| `subscribe()` | `:45` | New `queue.Queue(maxsize=200)`, added under `_lock`; immediately `put_nowait(self._latest)` if a cached fragment exists, so a joining client gets video without waiting a full `frag_duration` |
| `unsubscribe(q)` | `:57` | `discard` |
| `publish(fragment)` | `:61` | Caches as `_latest`, snapshots the subscriber list under the lock, then `put_nowait` per queue **outside** the lock. `queue.Full` is swallowed → a slow consumer drops **only its own** fragments, never backpressures FFmpeg or other clients |
| `close()` | `:71` | Snapshots + clears subs, then pushes a `None` **sentinel** into each so every HTTP generator exits |

**`class StreamManager`** (`:82`) — class-level state `_monitor_threads: dict` and `_stream_locks: dict`.

| Method | Line | Behaviour |
|---|---|---|
| `_get_lock(video_id)` | `:92` | Lazily creates a per-video `threading.Lock`. Never removed |
| `_validate_video(video_data)` | `:98` | HTTP 400 on width/height/fps falsy or ≤0 |
| `_build_video_payload(video_id)` | `:110` | The WS `video` object. Uses `.get()` defaults so it still works after the video is gone from `storage.videos` |
| `_read_mp4_box(stdout)` | `:140` | Reads one full MP4 box — see [§6](#6-progressive-fmp4-pipeline) |
| `_read_mp4_init(stdout)` | `:181` | Accumulates boxes until `moov`; aborts with `RuntimeError` past **10 MB** |
| `_stderr_reader(video_id, proc)` | `:204` | Daemon thread draining stderr at DEBUG level, so FFmpeg never blocks on a full pipe |
| `_fragment_publisher(video_id, proc)` | `:215` | Daemon thread; sole stdout drainer after init |
| `_do_terminate(...)` | `:255` | Hub close → `killpg` SIGTERM → 5 s grace → SIGKILL → thread joins → `rmtree` both dirs → `active_streams.pop` |
| `_monitor(video_id)` | `:297` | The 4-phase lifecycle thread |
| `start_stream(video_id)` | `:431` | classmethod; see [trace 10.2](#102-start-a-stream) |
| `stop_stream(video_id)` | `:552` | classmethod; 404/409 checks, set `TERMINATING`, immediate `killpg` SIGTERM to unblock the monitor's blocking read |
| `get_stream_status(video_id)` | `:576` | 404 if the video is unknown |
| `cleanup_all_streams()` | `:590` | Stops every active stream, then joins every monitor thread with `timeout=8` |

`stream_manager = StreamManager()` at `:604` is **dead code** — every call site uses the class directly.

### Routers

Three `APIRouter`s with prefixes `/videos`, `/streams`, `/bboxes`, included in that order at `main.py:66-68`.

- `routers/streams.py` — all three handlers are **sync `def`**, so FastAPI runs them in the threadpool. This is deliberate: `StreamManager` uses a blocking `threading.Lock`.
- `routers/bboxes.py` — `POST /bboxes/` is `async def` because it needs the running loop for `asyncio.create_task`.
- There is **no `__init__.py` anywhere** (the filename is gitignored repo-wide), so `routers`, `managers` and `utils` are PEP 420 implicit namespace packages. They resolve because the editable install puts `backend/src` on `sys.path` — not because of the CWD.

---

## 2. Data models

### `VideoInfo` (`utils/models.py:8`)

| Field | Type | Default |
|---|---|---|
| `id` | `int` | required |
| `name` | `str` | required |
| `file_path` | `str` | required |
| `created_at` | `str` | required — `datetime.now().isoformat()`, **local time, no timezone** |
| `width` | `int` | required |
| `height` | `int` | required |
| `fps` | `float` | required |
| `stream_status` | `StreamStatus` | `STOPPED` |
| `stream_start_time_ms` | `Optional[int]` | `None` |
| `dash_manifest_url` | `Optional[str]` | `None` |
| `prog_url` | `Optional[str]` | `None` |
| `prog_init_url` | `Optional[str]` | `None` |
| `dvr_window_seconds` | `Optional[int]` | `None` — always populated as `300` in practice |

The comment at `utils/models.py:20-22` states that `dvr_window_seconds` is the authoritative DVR capacity so the frontend never hardcodes it.

### `BBoxData` (`utils/models.py:24`)

| Field | Type | Constraint |
|---|---|---|
| `id` | `Optional[str]` | Default `None`. Caller-supplied detection id, echoed back verbatim — see below |
| `pts` | `int` | "Presentation timestamp in raw stream units (90kHz)" |
| `top_left_corner` | `int` | A **flattened 1-D pixel index**: `y = idx // width`, `x = idx % width` |
| `bottom_right_corner` | `int` | Same encoding |
| `class_name` | `str` | — |
| `confidence` | `float` | `ge=0, le=1` — **the only real validator in the codebase**; out of range → 422 |

There is **no** server-side validation that the corner indices fall within `width*height` or that `br > tl`. The frontend guards against this defensively at draw time (`frontend/src/utils/drawing.ts:41-50`).

> **`id` exists for the Rust client library.** Its wrappers generate a uuid4 per detection and send it both inside the bbox and as a parallel C array; the library's response decoder declares `struct ResultBBox { id: String, absolute_timestamp_ms: i64 }` with no `serde(default)`, and uses the id to pair each detection with its timestamp. If `id` were removed from `BBoxData`, Pydantic would silently drop it on input, it would never appear in the response, `serde` would fail with `missing field 'id'`, and the library's `PostResultsCallback` would **never fire** — while bbox storage and the WebSocket broadcast continued to look perfectly healthy. The frontend ignores the field.

### `BBoxCreate` (`utils/models.py:36`)

- `stream_id: int` — **naming quirk: this is actually the video_id.** Used directly as `video_id = bbox_data.stream_id` (`managers/bbox.py:48`).
- `bboxes: List[BBoxData]` — may be empty, which produces an empty `stored_bboxes` and no broadcast.

### `StreamConfig` (`utils/models.py:41`)

- `video_id: int` — the sole field; the request body of `POST /streams/start`.

### Stored bbox dict

Not a Pydantic model — built at `managers/bbox.py:72-80`:

```
{"id", "pts", "absolute_timestamp_ms", "top_left_corner", "bottom_right_corner", "class_name", "confidence"}
```
where `absolute_timestamp_ms = stream_start_time_ms + pts_ms`.

---

## 3. API surface

### `/videos`

| Endpoint | Success | Errors |
|---|---|---|
| `POST /videos/upload` | `204`, empty body | `400` extension not in `(.mp4, .avi, .mov, .mkv)` (case-insensitive, `managers/video.py:97`); `500` "Failed to save file: …"; `400` "Invalid video file: …" when ffprobe fails; `422` if `file` is missing |
| `GET /videos/` | `200`, `list[VideoInfo]` | — |
| `GET /videos/{video_id}` | `200`, `VideoInfo` | `404` "Video {id} not found"; `422` non-int id |
| `DELETE /videos/{video_id}` | `204`, empty | `404` unknown; `400` "Cannot delete video {id}: stop the stream first" |

`POST /videos/upload` takes multipart: `file: UploadFile = File(...)`, `name: Optional[str] = Form(None)` (falls back to `file.filename`). It returns **no body** — the created video is delivered only via the WS `video_update`/`created` event or a subsequent `GET /videos/`.

`GET /videos/` requires the trailing slash; FastAPI 307-redirects `/videos`.

### `/streams`

| Endpoint | Body | Success | Errors |
|---|---|---|---|
| `POST /streams/start` | `StreamConfig` `{"video_id": int}` | `204` | `404` video not found; `400` invalid width/height/fps; `409` `"Stream is already {status}"` |
| `POST /streams/stop/{video_id}` | — | `204` | `404` "No active stream for video {id}"; `409` "Stream is already terminating" |
| `GET /streams/status/{video_id}` | — | `200` | `404` if the video doesn't exist |

`POST /streams/start` returns as soon as FFmpeg is spawned and the status is `INITIALIZING`. Success or failure of initialization arrives **later, over WebSocket** as `stream_started` or `stream_stopped`.

`GET /streams/status/{video_id}` returns `{"video_id", "status": "stopped"}` when not streaming, or `{"video_id", "status", "pid", "start_time_ms"}` when it is.

### `/bboxes`

| Endpoint | Success | Errors |
|---|---|---|
| `POST /bboxes/` | `200` `{"source_id", "stream_start_time_ms", "bboxes"}` | `404` "Video {id} not found"; `400` "Video {id} is not currently streaming"; `422` schema/confidence violations |
| `GET /bboxes/{video_id}` | `200` `{"video_id", "stream_start_time_ms", "groups"}` | `404` unknown video |
| `POST /bboxes/cleanup` | `200` `{"cleaned_videos", "total_pts_removed", "retention_period_ms": 305000}` | — |

Note the asymmetry: the **request** key is `stream_id`, the **response** key is `source_id`, and neither is `video_id`. All three refer to the same thing.

The `400` guard only checks membership in `active_streams`, so `POST /bboxes/` **also succeeds while a stream is merely `INITIALIZING`** — bboxes can be stored before any DASH segment exists.

`GET /bboxes/{video_id}` is the DVR-window history replay the frontend uses on (re)load.

### Media serving (`main.py`)

| Endpoint | Line | Behaviour |
|---|---|---|
| `GET /dash/{video_id}/{filename:path}` | `:72` | `FileResponse` from `dash_streams/<id>/<filename>`. Media type from `{".mpd": "application/dash+xml", ".m4s": "video/iso.segment", ".mp4": "video/mp4"}`, else `application/octet-stream`. Always `Cache-Control: no-cache, no-store, must-revalidate`. `404` "DASH file not found" |
| `GET /progressive/{video_id}/progressive.mp4` | `:86` | The cached fMP4 **init segment** (`ftyp`+`moov`). `404` "Progressive init segment not yet available" until the monitor writes it |
| `GET /progressive/{video_id}/prog.m4s` | `:99` | The live fragment stream — infinite chunked `StreamingResponse` |

**`prog.m4s` connection sequence** (`main.py:96-150`):

1. `404` if `storage.active_streams` has no entry for the id.
2. `503` "Progressive stream not initialised" if `prog_init_ready` is missing.
3. `await loop.run_in_executor(None, init_ready.wait, 15.0)` — blocks up to **15 s**; `503` "Timed out waiting for progressive stream init" on timeout.
4. Re-fetch the record; `404` "Stream ended before progressive consumer could connect" if it vanished.
5. `503` "Progressive stream hub missing" if the hub is gone.
6. `hub.subscribe()` → a per-client `Queue(maxsize=200)`.
7. Generator loop: `consumer_queue.get(timeout=2.0)` in the executor. `queue.Empty` → break if the stream is gone, else continue. `None` sentinel → break. Otherwise `yield chunk` (one whole `moof`+`mdat` pair).
8. `finally: hub.unsubscribe(consumer_queue)`.

The response has **no `Content-Length`** and never ends normally — it terminates on stream stop or client disconnect.

### Utility

- `GET /` — `{"message", "docs", "total_videos", "active_streams", "websocket_endpoint", "dash_endpoint", "progressive_init_endpoint", "progressive_stream_endpoint"}`.
- `GET /health` — `{"status": "healthy"}`.
- **Catch-all** (`main.py:207`) — `@app.api_route("/{full_path:path}", methods=["GET","POST","PUT","DELETE","HEAD","PATCH"])` always raises `404 "Route not found: /{full_path}"`. Registered last so it only fires on genuine misses. `OPTIONS` is deliberately excluded so CORS preflight still works. Side effect: method-mismatch cases that would be `405` become `404`.

---

## 4. WebSocket protocol

Single global endpoint at **`/ws`** (`main.py:155`). Loop: `data = await websocket.receive_json()`, dispatch on `data.get("type")`.

### Client → server

| Message | Behaviour |
|---|---|
| `{"type": "subscribe_video", "video_id": <int>}` | Only honoured when `isinstance(video_id, int)`; **silently ignored** otherwise. No ack |
| `{"type": "unsubscribe_video", "video_id": <int>}` | Same |
| `{"type": "ping"}` | Server replies `{"type": "pong"}` |
| anything else / malformed JSON | Falls into a bare `except Exception: pass` and **closes the connection** with no diagnostic |

### Server → client

**`video_update`** — sent to **all** connections, unconditionally, no subscription needed:

```json
{
  "type": "video_update",
  "reason": "created|deleted|stream_initializing|stream_started|stream_stopped|stream_error",
  "video": {
    "id": 1, "name": "...", "file_path": "...", "created_at": "...",
    "width": 1920, "height": 1080, "fps": 30.0,
    "stream_status": "streaming",
    "stream_start_time_ms": 1700000000000,
    "dash_manifest_url": "/dash/1/manifest.mpd",
    "prog_url": "/progressive/1/prog.m4s",
    "prog_init_url": "/progressive/1/progressive.mp4",
    "dvr_window_seconds": 300
  }
}
```

For `reason: "deleted"` the `video` object is only `{"id": N, "stream_status": "stopped"}`.

**`bbox_update`** — sent only to subscribers of that `video_id`, **one message per pts group**:

```json
{
  "type": "bbox_update",
  "video_id": 1,
  "pts": 900000,
  "bboxes": [{
    "id": "3f1c2b9e-7a4d-4e11-9b0a-1d2e3f4a5b6c",
    "pts": 900000,
    "absolute_timestamp_ms": 1700000010000,
    "top_left_corner": 12345,
    "bottom_right_corner": 67890,
    "class_name": "person",
    "confidence": 0.91
  }],
  "stream_start_time_ms": 1700000000000,
  "timestamp": 1700000010123
}
```

**`pong`** — `{"type": "pong"}`.

There is no server-initiated heartbeat and no per-connection send lock.

---

## 5. FFmpeg orchestration

### Probing (ffprobe)

```
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,avg_frame_rate -of json <file>
```
(`managers/video.py:27-34`). Blocking; run via `asyncio.to_thread` from the upload path.

### The single streaming command

Built at `managers/stream.py:437-484`. `keyframe_interval = str(int(fps * 2))` (`:450`) — the GOP length in frames equals exactly one DASH segment.

```
ffmpeg
  -v warning
  -probesize 5M  -analyzeduration 5M
  -err_detect ignore_err
  -re
  -stream_loop -1
  -fflags +genpts
  -i <video_data["file_path"]>

  # --- output 1: DASH (re-encoded) ---
  -map 0:v:0
  -an
  -vf fps=fps=<fps>
  -c:v libx264
  -pix_fmt yuv420p
  -preset veryfast
  -tune zerolatency
  -b:v 2M  -maxrate 2M  -bufsize 4M
  -g <int(fps*2)>
  -f dash
  -seg_duration 2
  -window_size 150
  -extra_window_size 30
  -remove_at_exit 1
  -streaming 1
  -ldash 1
  -use_template 1
  -use_timeline 1
  ./dash_streams/<video_id>/manifest.mpd

  # --- output 2: progressive fMP4 → stdout (remux only) ---
  -map 0:v:0
  -an
  -c:v copy
  -f mp4
  -movflags frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset
  -frag_duration 200000
  pipe:1
```

### Per-flag rationale

| Flag | Why (rationale recorded in the source comments) |
|---|---|
| `-probesize 5M -analyzeduration 5M` | Reduced from 50M/100M (rationale `:464-467`, flags `:468-469`): deep probing delayed the first output segment by seconds and tripped `INIT_TIMEOUT` before the DVR could populate |
| `-re` | Real-time pacing, so a file behaves like a live source |
| `-stream_loop -1` | Infinite loop of the source file, turning a finite file into an endless "live" stream |
| `-fflags +genpts` | Regenerates monotonic PTS across loop boundaries |
| `-err_detect ignore_err` | Tolerate minor container errors rather than aborting the stream |
| `-vf fps=fps=<fps>` | Pin the output frame rate to the probed source rate |
| `-tune zerolatency`, `-streaming 1`, `-ldash 1` | Low-latency DASH — chunked/CMAF-style output with the MPD rewritten as segments land |
| `-g fps*2` | Keyframe every 2 s so `-seg_duration 2` produces cleanly independently decodable segments |
| `-b:v 2M -maxrate 2M -bufsize 4M` | CBR-ish 2 Mbit single representation. **No ABR ladder** |
| `-an` (both outputs) | No audio anywhere in the system |
| `-window_size 150` | × `seg_duration 2` = the **300 s advertised DVR window** |
| `-extra_window_size 30` | 30 extra segments (60 s) retained on disk past the advertised window (`:491-498`). The earlier 5-segment (10 s) margin caused an "oldest-edge freeze" — dash.js requesting the oldest segment while ffmpeg unlinked it |
| `-remove_at_exit 1` | ffmpeg deletes its own DASH artifacts on clean exit (belt-and-braces with the explicit `rmtree`) |
| `-c:v copy` (progressive) | Remux only. `:456-460` records that this reverted a ~2× CPU regression from an earlier design running a second encoder |
| `-movflags empty_moov` | Makes the leading `moov` sample-free, so `ftyp`+`moov` is a standalone init segment |
| `-movflags default_base_moof+omit_tfhd_offset` | Makes fragments self-contained and position-independent — required for a client that joins mid-stream and prepends a cached init |
| `-frag_duration 200000` | 200 000 µs = **200 ms** fragments → ~5 fragments/s of latency granularity |

### Process spawn

```python
subprocess.Popen(cmd, stdout=PIPE, stderr=PIPE, stdin=DEVNULL, bufsize=-1, preexec_fn=os.setsid)
```
(`managers/stream.py:486-517`)

`os.setsid` puts FFmpeg in its **own process group**, so `killpg` reaps ffmpeg and any children it spawned. `stdin=DEVNULL` prevents ffmpeg from consuming the server's stdin. Both pipes must be drained continuously — that is precisely what `_stderr_reader` and `_fragment_publisher` exist for.

### Lifecycle FSM (`_monitor`, `managers/stream.py:281`)

| Phase | Behaviour |
|---|---|
| **0 — Init extraction** | Start `_stderr_reader`; `_read_mp4_init(process.stdout)` → write `progressive_streams/<id>/progressive.mp4` → `prog_init_ready.set()`. On exception: log and set `status = TERMINATING`, skipping phases 1 and 2 entirely. Then start `_fragment_publisher` |
| **1 — `INITIALIZING`** | Loop until `time.time() + 20` (`INIT_TIMEOUT`), sleeping 0.5 s. Breaks on missing record or `TERMINATING`. If `process.poll() is not None` → "FFmpeg died during initialization (rc=…)" + `TERMINATING`. If `manifest.mpd` exists **and** ≥3 `chunk-*.m4s` files exist → `STREAMING` + broadcast `stream_started`. The `while/else` at `:382` handles deadline exhaustion → "Initialization timeout" + `TERMINATING` |
| **2 — `STREAMING`** | 1 s poll on `process.poll()`. On death → "FFmpeg died during streaming", `TERMINATING`, broadcast `stream_error`, break |
| **3 — Terminate** | `_do_terminate`, then broadcast `stream_stopped` (guarded by `if video_id in storage.videos`), pop the monitor thread |

The **3-segment gate** (`MIN_READY_SEGMENTS = 3`, `managers/stream.py:334`) is documented at `:346-352` as a workaround for a dash.js 5.1.1 race in `StreamController._composePeriods`: with a one-segment MPD, `addDVRMetric` fails and `STREAMS_COMPOSED` never fires.

### Kill sequence (`_do_terminate`, `:255`)

`hub.close()` → `os.killpg(os.getpgid(pid), SIGTERM)` → `process.wait(timeout=5)` → on `TimeoutExpired`, `SIGKILL` the group and `wait()` unbounded. `ProcessLookupError`/`OSError` are swallowed. Joins the stderr thread (2 s) and the publisher thread (2 s). `shutil.rmtree(..., ignore_errors=True)` on both per-stream directories. Finally `storage.active_streams.pop(video_id, None)`.

---

## 6. Progressive fMP4 pipeline

### `_read_mp4_box(stdout) -> tuple[str, bytes]` (`managers/stream.py:126`)

Reads exactly one MP4 box:

1. 8-byte header loop; `box_size = struct.unpack(">I", header[:4])[0]`, `box_type = header[4:8].decode("ascii", errors="ignore")`.
2. `box_size == 1` → read 8 more bytes as a 64-bit `>Q` extended size; `remaining = box_size - 16`.
3. `box_size == 0` (extends to EOF) → `RuntimeError`, unsupported.
4. Otherwise `remaining = box_size - 8`.
5. Payload read in ≤64 KiB chunks.

Returns header **plus** content, so callers can forward raw on-wire bytes untouched. Raises `RuntimeError` on any short read or EOF.

### `_read_mp4_init(stdout) -> bytes` (`:181`)

Loops `_read_mp4_box`, accumulating bytes until it sees `moov`. Aborts with `RuntimeError` if the accumulation exceeds **10 MB** (`:195`).

### `_fragment_publisher` (`:215`)

Daemon thread; the **sole stdout drainer** after init. While `process.poll() is None`:

1. Read a box, expect `moof`.
2. Read the next box, expect `mdat`.
3. Publish `first_bytes + second_bytes` as one fragment to the hub.

Unexpected box types log a warning and `continue` (skip). `RuntimeError` (EOF) breaks the loop. It also breaks if the stream record or hub disappears.

### Fan-out summary

```
1 FFmpeg stdout
   → 1 publisher thread (strict moof→mdat pairing)
      → ProgressiveHub._latest (cached, primes joiners)
      → N per-client Queue(maxsize=200)   [lossy: put_nowait, Full swallowed]
         → N StreamingResponse generators
```

A joining client is immediately primed with `hub._latest`, then receives whole fragments. At ~5 fragments/s, 200 queue slots ≈ 40 s of buffer before a stalled consumer starts dropping.

---

## 7. Concurrency model

### Threads per active stream (3)

| Thread | Work |
|---|---|
| `_monitor` (daemon) | The lifecycle FSM. Blocking `stdout.read` during phase 0, then 0.5 s / 1.0 s polling |
| `_stderr_reader` (daemon) | Pipe drain only, so FFmpeg never blocks on a full stderr pipe |
| `_fragment_publisher` (daemon) | The sole stdout drainer post-init and the hub's sole producer |

### Locks

| Lock | Type | Guards |
|---|---|---|
| `StreamManager._stream_locks[video_id]` | `threading.Lock` | Mutual exclusion of `start_stream` / `stop_stream` for the same video |
| `ProgressiveHub._lock` | `threading.Lock` | `_subs` / `_latest`. `publish()` releases it before `put_nowait` so a subscriber can never block the producer |
| `ConnectionManager._lock` | `asyncio.Lock` | `connections` / `video_subscriptions`. `_send_to_connections` sends **outside** the lock and only re-acquires it to purge dead sockets |

### Async ↔ thread bridges

- **Sync → async:** `broadcast_sync(coro)` → `asyncio.run_coroutine_threadsafe`, using the loop captured at startup. Used by `_monitor` and by `VideoManager.delete_video`.
- **Async → sync:** `loop.run_in_executor(None, ...)` in `serve_progressive_stream` — for `init_ready.wait(15.0)` and for **every** `queue.get(timeout=2.0)`. Also `asyncio.to_thread` for the upload copy and for ffprobe.

> **Executor starvation risk.** Each in-flight progressive client permanently occupies a default-executor thread (blocked up to 2 s at a time). The default `ThreadPoolExecutor` is `min(32, cpu_count+4)` workers, and FastAPI's **sync endpoints share it** (`GET /videos/`, all of `/streams/*`, `/dash/*` `FileResponse` work). Enough simultaneous `prog.m4s` consumers will starve the pool and stall sync REST handlers. This is the most likely first bottleneck.

### Background asyncio tasks

`asyncio.create_task(broadcast_bbox(...))` is spawned **per distinct pts** in a bbox payload, with strong references held in `_pending_broadcasts` and released via `task.add_done_callback(_pending_broadcasts.discard)` (`managers/bbox.py:92-103`). Deliberately not awaited, so a slow WS subscriber cannot stall the ingest POST.

> **Consequence:** `bbox_update` ordering **across pts groups is not guaranteed** under load. Clients must key off `pts`, not arrival order.

The WebSocket fan-out itself is sequential — `_send_to_connections` awaits `send_text` per socket, so one slow socket delays the rest of that single broadcast.

---

## 8. Storage layout & cleanup

All three paths are **absolute**, anchored to `backend/` via `__file__`
(`utils/storage.py:9-12`), so they do not depend on the process CWD. They are defined
once there; nothing else spells the literals.

This matters because `main.py` **chdirs into `src/`** before calling `uvicorn.run`
(see [§9](#9-configuration-constants)). The data directories still sit beside `src/`,
never inside it.

```
backend/
  src/                             # all Python lives here
  videos/                          # created at import time (utils/storage.py:25)
    <video_id>.mp4                 # ALWAYS .mp4 regardless of source extension
  dash_streams/                    # recreated in lifespan startup
    <video_id>/
      manifest.mpd
      init-stream0.m4s
      chunk-stream0-00001.m4s ...  # rolling; monitor counts via glob("chunk-*.m4s")
  progressive_streams/             # recreated in lifespan startup
    <video_id>/
      progressive.mp4              # ftyp+moov init segment, written by the monitor thread
```

**There is no on-disk persistence of metadata** — no JSON, no SQLite. `storage.videos`, `storage.bboxes`, `storage.active_streams`, and `next_video_id` are pure process memory.

| When | What is cleaned |
|---|---|
| **Startup** | `dash_streams/` and `progressive_streams/` are `rmtree`'d then recreated (`main.py:26-30`). `videos/` is **not** cleared — but since metadata is gone and `next_video_id` restarts at 1, leftover files are orphaned and will be overwritten |
| **Per stream stop** | `dash_streams/<id>` and `progressive_streams/<id>` removed (`_do_terminate`, `:285-291`), plus ffmpeg's own `-remove_at_exit 1` |
| **Shutdown** | `cleanup_all_streams()`, then `rmtree` of `videos/`, `dash_streams/`, `progressive_streams/` (`main.py:40-48`). **Every uploaded video is deleted on every shutdown**, including a `--reload` restart |
| **bbox retention** | Sliding 305 s window, enforced opportunistically on every `POST /bboxes/` and on demand via `POST /bboxes/cleanup`. Nothing runs it periodically, so a stream that stops posting leaves its last window resident indefinitely |

---

## 9. Configuration constants

**One environment variable: `APP_PORT`** (default `8702`), read only by the `__main__` block at the bottom of `main.py` and supplied by moon from `backend/.env`.

That same block calls `os.chdir(Path(__file__).parent)` before `uvicorn.run`, so the
reloader watches `backend/src` and nothing else. This is not cosmetic: uvicorn's
`WatchFilesReload.__init__` drops every `reload_dirs` entry that has `Path.cwd()` in its
parents and then appends `Path.cwd()` itself, so a `reload_dirs=["src"]` from a CWD of
`backend/` silently watches all of `backend/` — including `.venv/`. Making `src/` the CWD
is the only way to narrow it, and it is safe because the storage paths are absolute. Every other knob is a hardcoded module constant. (`VITE_BACKEND_URL` is frontend-only; the Rust library bakes its backend URL in at compile time from `B2B_URL` — `library/client/src/state.rs:20`.)

| Constant | Value | Location |
|---|---|---|
| `DASH_OUTPUT_DIR` | `./dash_streams` | `managers/stream.py:20` |
| `PROGRESSIVE_OUTPUT_DIR` | `./progressive_streams` | `managers/stream.py:21` |
| `DASH_SEGMENT_DURATION` | `2` s | `managers/stream.py:21` |
| `DASH_WINDOW_SIZE` | `150` segments | `managers/stream.py:21` |
| DVR window (derived) | `300` s | `managers/stream.py:120`, `managers/video.py:91` |
| `extra_window_size` | `30` segments (60 s) | `managers/stream.py:468` |
| `INIT_TIMEOUT` | `20` s | `managers/stream.py:21` |
| `MIN_READY_SEGMENTS` | `3` (function-local) | `managers/stream.py:334` |
| Init-segment safety cap | `10 MB` | `managers/stream.py:181` |
| `frag_duration` | `200000` µs | `managers/stream.py:482` |
| Video bitrate | `2M` / maxrate `2M` / bufsize `4M` | `managers/stream.py:458-460` |
| Hub queue depth | `200` | `managers/stream.py:39` |
| Progressive init wait | `15.0` s | `main.py:112` |
| Progressive queue-get timeout | `2.0` s | `main.py:131` |
| `RETENTION_MARGIN_SEC` | `5` | `managers/bbox.py:24` |
| `RETENTION_PERIOD_MS` | `305000` | `managers/bbox.py:25` |
| `STANDARD_TIME_BASE` | `90000.0` | `managers/bbox.py:26` |
| SIGTERM grace → SIGKILL | `5` s | `managers/stream.py:255-260` |
| Thread join timeouts | `2` s (stderr/publisher), `8` s (monitor at shutdown) | `:280-282`, `:600` |
| Host / port | `0.0.0.0` / `8702` | `main.py:213` |
| Log level | `INFO` via `logging.basicConfig` | `managers/stream.py:20` |
| CORS | `allow_origin_regex=".*"`, credentials on, all methods/headers | `main.py:58` |
| App metadata | title "Video Stream Management API", version "4.0.0" | `main.py:51-56` |

**External binaries required on PATH:** `ffmpeg` and `ffprobe`. Neither is checked at startup — a missing binary surfaces as a `400` "Invalid video file" on upload, or a `FileNotFoundError` (500) on stream start.

**Platform:** POSIX-only — `os.setsid`, `os.getpgid`, `os.killpg`, `preexec_fn`, `signal.SIGTERM/SIGKILL`.

**Dependencies** are pinned in `pyproject.toml` (the only source; `requirements.txt` was deleted): `fastapi==0.109.", `pydantic==2.10.3`, `python-multipart==0.0.6`, `uvicorn[standard]==0.27.0`, `websockets==12.0`. `.python-version` is `3.11`.

---

## 10. End-to-end traces

### 10.1 Upload a video

1. `POST /videos/upload` (multipart) → `videos.upload_video` → `VideoManager.create_video(file, name or file.filename)`.
2. Extension check against `(.mp4, .avi, .mov, .mkv)`, lowercased → else `400`.
3. `video_id = storage.get_next_video_id()`; `file_path = ./videos/<video_id>.mp4`.
4. `await asyncio.to_thread(_copy_upload)` — `shutil.copyfileobj(file.file, f, length=1MB)`, so the upload streams to disk 1 MiB at a time without buffering in RAM and without blocking the loop. Any exception → `500` (**the partial file is left on disk** in this path).
5. `await asyncio.to_thread(_get_video_properties, str(file_path))` — ffprobe off-loop. `ValueError` → unlink the file, raise `400`.
6. `storage.videos[video_id] = {...}` and `storage.bboxes[video_id] = {}`.
7. `await ws_manager.broadcast_video_update(video_id, CREATED, _build_video_info(video_id).model_dump())` — awaited inline here, unlike the delete path.
8. HTTP `204`. The client learns the new ID from the WS event or a re-list.

### 10.2 Start a stream

1. `POST /streams/start {"video_id": N}` → sync handler in the threadpool → `StreamManager.start_stream(N)`.
2. `404` if unknown. Acquire `_get_lock(N)`. `409` if `N in storage.active_streams`.
3. `_validate_video`, compute `keyframe_interval = int(fps*2)`, `mkdir -p dash_streams/<N>`.
4. Build the two-output command and `Popen(..., preexec_fn=os.setsid)`; log `[Stream N] FFmpeg started (PID …)`.
5. Insert the `active_streams[N]` record with `status=INITIALIZING` and **`start_time_ms = int(time.time()*1000)`** — wall-clock at spawn. **This is the anchor for every bbox absolute timestamp.**
6. `broadcast_sync(broadcast_video_update(N, STREAM_INITIALIZING, payload))`.
7. Start the `_monitor` daemon thread, register it, release the lock, return `204`.
8. Monitor phases 0→1→2 run as described in [§5](#lifecycle-fsm-_monitor-managersstreampy281).

Meanwhile a browser fetches `/dash/N/manifest.mpd` and segments; the Rust library fetches `/progressive/N/progressive.mp4` once and then holds `/progressive/N/prog.m4s` open indefinitely.

### 10.3 bbox POST → WebSocket → client

1. The library `POST`s to `/bboxes/` with `{"stream_id": N, "bboxes": [{pts, top_left_corner, bottom_right_corner, class_name, confidence}, ...]}`. PTS is 90 kHz — the library rescales to `rational(1, 90_000)` (`library/client/src/mp4/ffmpeg.rs:622`), matching `STANDARD_TIME_BASE`.
2. `video_id = bbox_data.stream_id`. `404` if unknown video; `400` if not in `active_streams`.
3. `stream_start_time_ms = storage.active_streams[video_id]["start_time_ms"]`; `current_time_ms = int(time.time()*1000)`.
4. Per bbox: `pts_ms = int((pts/90000)*1000)`; `absolute_timestamp_ms = stream_start_time_ms + pts_ms`; append the enriched dict to `storage.bboxes[video_id][pts]`, to `stored_bboxes`, and to `pts_groups[pts]`.
5. `_cleanup_old_bboxes(video_id, current_time_ms)` — drop pts groups older than 305 s.
6. Per pts group: `asyncio.create_task(broadcast_bbox(video_id, {...}))`, tracked in `_pending_broadcasts`.
7. Respond `200` with `{"source_id", "stream_start_time_ms", "bboxes"}`. The library echoes real-world timestamps back through its own `PostResultsCallback` using `absolute_timestamp_ms` (`routers/bboxes.py:13-16`).
8. `broadcast_bbox` sends only to `video_subscriptions[video_id]` — clients that previously sent `{"type":"subscribe_video","video_id":N}`.
9. The frontend converts the 1-D corner indices to `(x, y)` and draws on a canvas overlay, gated by a per-class confidence threshold.
10. A client that (re)loads mid-stream calls `GET /bboxes/{video_id}` to backfill the whole retained window.

### 10.4 Stop a stream

1. `POST /streams/stop/{N}` → `stop_stream` under the lock → 404/409 checks → `status = TERMINATING` → immediate `killpg(getpgid(pid), SIGTERM)` → `204` returned right away. **Cleanup is asynchronous.**
2. The monitor's phase-2 loop sees `TERMINATING` (or its blocked stdout read raises) and falls through to `_do_terminate`.
3. `hub.close()` pushes `None` into every subscriber queue → each `/prog.m4s` generator breaks and its `finally` unsubscribes → the `StreamingResponse` ends → clients see EOF.
4. `killpg` SIGTERM → `wait(timeout=5)` → SIGKILL fallback; join stderr + publisher threads (2 s each).
5. `rmtree` both per-stream directories — so subsequent `/dash/N/...` and `/progressive/N/progressive.mp4` requests now `404`.
6. `storage.active_streams.pop(N)`.
7. The monitor broadcasts `video_update`/`stream_stopped` with `stream_status="stopped"` and every URL / `start_time_ms` field `None` (the record is already gone). `dvr_window_seconds` is still `300`.
8. `_monitor_threads.pop(N)`.

> Retained `storage.bboxes[N]` **survives** the stop. It is dropped only when the video is deleted or aged out by a later cleanup.

---

## 11. Application lifecycle

`lifespan` (`main.py:24-48`), an `@asynccontextmanager`:

**Startup**
1. For `./dash_streams` and `./progressive_streams`: `rmtree(ignore_errors=True)` if present, then `mkdir(parents=True, exist_ok=True)`.
2. `set_event_loop(asyncio.get_event_loop())` — captures the running loop so sync threads can use `broadcast_sync`. (`get_event_loop()` inside a coroutine is deprecated in 3.12+; `get_running_loop()` is the modern call.)
3. `yield`.

**Shutdown**
1. `StreamManager.cleanup_all_streams()` — stop every active stream, join monitors ≤8 s each.
2. `rmtree` of `./videos`, `./dash_streams`, `./progressive_streams`, each wrapped in try/except printing `Failed to clean up {directory}: {e}`.

**State restoration: none.** There is no persistence and no re-hydration. After a restart there are zero videos, zero bboxes, zero streams, and `next_video_id` is back to `1`. Under `uvicorn --reload`, **every code edit wipes all uploaded videos.**

---

## 12. Gotchas & limitations

### Correctness / known bugs

- `BBoxManager.list_bboxes` is annotated `-> list` but returns a `dict` (`managers/bbox.py:113` vs `:135`).
- `ConnectionManager.broadcast_video_update` accepts `video_id` but never uses it (`managers/websocket.py:78`).
- `stream_manager = StreamManager()` (`:604`) is dead code.
- `_fragment_publisher`'s docstring (`:220-222`) claims "every fragment begins with a moof + keyframe, so it's a valid decode restart point." **This does not hold** with `-frag_duration 200000` against a 2 s source GOP — most fragments will not start on a keyframe, so a late joiner may see brief decode artifacts until the next IDR.
- `_get_lock` (`:92`) does an unsynchronized check-then-insert into a shared dict; two concurrent first-time starts for the same video could get different locks.
- `_stream_locks` entries are never deleted (grows with distinct video IDs; negligible in practice).
- In `create_video`, a failure during the disk copy raises `500` but **leaves the partial file** at `videos/<id>.mp4`; only the ffprobe failure path unlinks it (`managers/video.py:111-120`). The consumed `video_id` is never recycled either way.
- Uploaded `.avi`/`.mov`/`.mkv` files are stored with a `.mp4` filename **without container conversion**. Harmless for ffmpeg (which sniffs), but the `file_path` extension is misleading.
- `_cleanup_old_bboxes` keys retention off `bbox_list[0]["absolute_timestamp_ms"]`; a pts group that somehow ends up empty is never reclaimed.
- The `/ws` handler's bare `except Exception: pass` means a single malformed frame tears down the whole connection with no diagnostic.
- Unknown or mistyped WS message `type` values are silently ignored with no error frame back to the client.

### Security

- `GET /dash/{video_id}/{filename:path}` builds `Path("dash_streams") / str(video_id) / filename` **with no path-traversal guard** (`main.py:73`).
- CORS is fully open (`allow_origin_regex=".*"` + `allow_credentials=True`) and there is **no authentication anywhere**. Anyone reachable on the network can upload, start/stop streams, POST bboxes, and delete videos. The server binds `0.0.0.0`.
- `POST /bboxes/cleanup` is an unauthenticated destructive operation.

### Scaling

- Executor-thread consumption: one blocked worker per live `/prog.m4s` client (see [§7](#7-concurrency-model)).
- Progressive fan-out is lossy per consumer by design; a consumer slower than ~5 fragments/s silently loses fragments and shows decode artifacts.
- One `libx264 veryfast` encode per active stream, single 2 Mbit representation, no ABR ladder, **no audio at all**.
- Single-process and in-memory: no horizontal scaling, and process death loses all state.

### Timing / sync

- `start_time_ms` is captured at `Popen` time — **before** ffmpeg produces a single frame. All `absolute_timestamp_ms` values inherit that offset, so bboxes are anchored to process-spawn wall clock, not first-frame wall clock. The comment at `managers/bbox.py:24-24` explicitly acknowledges the resulting left-edge gap on the seekbar as "library warmup."
- Retention (305 s) is intentionally derived from `DASH_SEGMENT_DURATION * DASH_WINDOW_SIZE` plus a 5 s margin, so tuning the encoder window automatically retunes bbox retention. One constant, not two.
- `dvr_window_seconds` is served authoritatively so the frontend never has to trust dash.js's jittery `getDvrWindow()` (comment at `managers/stream.py:117-120`).
- `-extra_window_size 30` and the `MIN_READY_SEGMENTS = 3` gate are both empirical fixes for real dash.js failures documented in-line. **Do not "simplify" either without re-testing playback.**

### Testing

There are no tests in this component and no CI. Verification is manual: start a stream, load the frontend, watch the DVR seekbar populate, POST a bbox and confirm it renders.
