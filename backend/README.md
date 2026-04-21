# Video Player Backend

Async FastAPI server that orchestrates video streaming and relays AI analytics between the Rust client library and the browser frontend. Runs on port 8702 by default.

## What It Does

- **DASH streaming** — Encodes uploaded videos with FFmpeg (libx264, 2-second segments) and serves a live MPD manifest with a rolling **300-second DVR window** for adaptive, seekable playback in the browser.
- **Progressive fMP4 streaming** — Parallel low-latency path that **remuxes without re-encoding** (`-c:v copy`) and fans fragments out to multiple subscribers from a single FFmpeg pipeline. Consumed by the Rust client library for frame-accurate decode.
- **AI analytics pipeline** — Accepts bounding-box POSTs from the library, retains them in memory for the DVR window (plus a small safety margin), and broadcasts them in real time over a global WebSocket so connected frontends can overlay detections synced to video PTS.
- **Stream lifecycle** — Each stream transitions through `INITIALIZING → STREAMING → TERMINATING`; state is exposed via REST and WebSocket `video_update` events.
- **REST + WebSocket surface** — Grouped endpoints for `videos/*` (upload, list, delete), `streams/*` (start, stop, status), `bboxes/*` (ingest, fetch, cleanup), `dash/{id}/*` and `progressive/{id}/*` (segment serving), and a single global `/ws` WebSocket for `bbox_update` and `video_update` events.

The server itself is deliberately thin — all heavy video work is delegated to FFmpeg subprocesses, and state is kept in-memory (no database).

## Configuration

This project uses `uv` for dependency management. To install dependencies, run:

```bash
uv sync
```

## Starting the Server

To start the backend server in development mode with hot-reloading, run:

```bash
uv run uvicorn main:app --reload --host 0.0.0.0 --port 8702
```
