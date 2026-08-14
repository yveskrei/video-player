# Video Player Frontend
This folder represents a user interface (Web), allowing use to manage the backend and consume MPEG-DASH video, displaying AI analytics in real time as they arrive from the backend.<br>
The frontend consists of the following stack:

- **React** with TypeScript
- **Vite** for fast development and building
- **Tailwind CSS** for styling
- **dash.js** for DASH video playback
- **WebSocket** for real-time bbox updates

Get started by running the following command:
```bash
moon run frontend:dev
```

**NOTE** - You must create a `.env` file first

## Overview
![Frontend Consumer](../assets/frontend-consumer.png)
![Frontend Consumer](../assets/frontend-management.png)

## Management page (`/`)
- Upload videos via multipart form with live progress.
- List, inspect, and delete videos in the library.
- Start and stop streams; status badges update live via WebSocket (`Streaming` / `Initializing` / `Terminating` / `Stopped`).
- Stream info modal exposes the DASH manifest URL and progressive fMP4 URLs used by native consumers of the Rust client library.

## Viewer page (`/viewer`)
- **DASH playback with DVR** - dash.js-backed player with a rolling DVR window, seekable timeline, "behind live" indicator, back-to-live button, and ±5s skip. Progressive fMP4 URLs are advertised by the backend but are **not** used by the browser player - DASH is the only playback path.
- **AI analytics overlay** - Canvas bounding-box overlay driven by a RAF loop and synced to video PTS from WebSocket messages, with a min-confidence slider and configurable retention-frames behaviour.
- **Clip export (DVR replay)** - Select a range on the timeline and export it as an MP4 entirely in the browser: an off-main-thread Web Worker parses the DASH manifest, fetches the covering segments, decodes with `VideoDecoder`, composites bboxes onto an `OffscreenCanvas`, re-encodes with `VideoEncoder`, and muxes the result. Clips are capped at 300s; progress is reported via toast.
- **Live recording** - On the live edge, capture the last ~30 seconds into a rolling frame buffer (with optional bbox compositing) and save to MP4 on demand.
- **Fullscreen + keyboard shortcuts** - `space` play/pause, arrow keys seek / skip, `f` fullscreen, `esc` cancel clip selection; controls auto-hide in fullscreen.
