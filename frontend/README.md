# Video Player Frontend

Modern React-based video streaming application with DVR playback, real-time AI analytics overlay, and in-browser clip export.

## Tech Stack

- **React** with TypeScript
- **Vite** for fast development and building
- **Tailwind CSS** for styling
- **dash.js** for DASH video playback
- **WebSocket** for real-time bbox updates

## Setup

### 1. Install Dependencies

```bash
bun install
```

### 2. Configure Environment

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` and set your backend URL:

```env
VITE_BACKEND_URL=http://localhost:8702
```

### 3. Run Development Server

```bash
bun run dev
```

The app will be available at `http://localhost:5173`

### 4. Build for Production

```bash
bun run build
```

The built files will be in the `dist/` directory.

## Configuration

### Environment Variables

- `VITE_BACKEND_URL`: Backend API URL (default: `http://localhost:8702`)

## Features

The app is split into two pages:

### Management page (`/`)
- Upload videos via multipart form with live progress.
- List, inspect, and delete videos in the library.
- Start and stop streams; status badges update live via WebSocket (`Streaming` / `Initializing` / `Terminating` / `Stopped`).
- Stream info modal exposes the DASH manifest URL and progressive fMP4 URLs used by native consumers of the Rust client library.

### Viewer page (`/viewer`)
- **DASH playback with DVR** — dash.js-backed player with a rolling DVR window, seekable timeline, "behind live" indicator, back-to-live button, and ±5s skip. Progressive fMP4 URLs are advertised by the backend but are **not** used by the browser player — DASH is the only playback path.
- **AI analytics overlay** — Canvas bounding-box overlay driven by a RAF loop and synced to video PTS from WebSocket messages, with a min-confidence slider and configurable retention-frames behaviour.
- **Clip export (DVR replay)** — Select a range on the timeline and export it as an MP4 entirely in the browser: an off-main-thread Web Worker parses the DASH manifest, fetches the covering segments, decodes with `VideoDecoder`, composites bboxes onto an `OffscreenCanvas`, re-encodes with `VideoEncoder`, and muxes the result. Clips are capped at 300s; progress is reported via toast.
- **Live recording** — On the live edge, capture the last ~30 seconds into a rolling frame buffer (with optional bbox compositing) and save to MP4 on demand.
- **Fullscreen + keyboard shortcuts** — `space` play/pause, arrow keys seek / skip, `f` fullscreen, `esc` cancel clip selection; controls auto-hide in fullscreen.
