# Video Player
The following folder contains an implementation of a video streaming/playing application.<br>
The application allows a user to stream video files from a server to a client over a network connection, and play them in real-time.

## Architecture
The application is divided into three main components:
1. **Backend**: An async **FastAPI** server that orchestrates **FFmpeg** to expose each uploaded video over two parallel protocols — **DASH** (adaptive, with a rolling 300-second DVR window) for browser playback, and **progressive fMP4** (zero-copy remux, low-latency fan-out) for native consumers. It also ingests AI analytics over REST and broadcasts them in real time over a global WebSocket so connected clients can overlay detections synced to video PTS.

2. **Frontend**: A web user interface for managing videos, controlling streams, and watching live feeds with full DVR (rewind, seek, back-to-live, skip). AI analytics are rendered as real-time bounding-box overlays synced to the video, with confidence and retention controls. Users can also export clips from the DVR window to MP4 entirely in the browser (via `VideoDecoder` / `VideoEncoder` / `mp4-muxer` in a Web Worker) and save short live recordings on demand. Built on:
- **Vite**
- **React**
- **Tailwind CSS**
- **dash.js** for DASH playback

3. **Library**: A native client library distributed as a C dynamic library (`libclient_video.so`), allowing third-party applications to connect to the backend, decode live video, and push AI analytics back with low latency. Built in **Rust** with a statically-linked decoder-only **FFmpeg**, so it has no runtime codec dependencies. The build is split into three phases (download → dependencies → library) so the final compile can run fully offline.

## Getting Started
To get started with the video streaming application, follow these steps:<br>

Install and start backend component:
```
# Backend setup
cd backend && uv sync

# Frontend setup
cd frontend && bun install
```

Start a development environment(unified for frontend and backend):
```
./run_local.sh
```


## Sreenshots
**Frontend**:<br>
<img src="assets/video-player-frontend-2.png" alt="Video Player Frontend" width="700"/><br>
<img src="assets/video-player-frontend-1.png" alt="Video Player Frontend" width="700"/><br>