import asyncio
import threading
import shutil
import queue as qmod
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse

from routers import videos, streams, bboxes
from storage import storage
from stream_manager import StreamManager
from websocket_manager import manager as ws_manager, set_event_loop
from enums import WebSocketEventType


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Clean up stale stream directories from any previous crashed run
    for d in [Path("./dash_streams"), Path("./progressive_streams")]:
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True, exist_ok=True)

    # Store the running event loop so sync threads can schedule async calls
    set_event_loop(asyncio.get_event_loop())

    yield

    # Shutdown: stop all streams and clean up directories
    StreamManager.cleanup_all_streams()

    for directory in [
        storage.video_storage_path,
        Path("./dash_streams"),
        Path("./progressive_streams"),
    ]:
        if directory.exists():
            try:
                shutil.rmtree(directory)
            except Exception as e:
                print(f"Failed to clean up {directory}: {e}")


app = FastAPI(
    title="Video Stream Management API",
    description="Real-time video streaming with DASH, progressive fMP4, and WebSocket AI analytics",
    version="4.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=".*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(videos.router)
app.include_router(streams.router)
app.include_router(bboxes.router)


# ------------------------------------------------------------------
# DASH file serving
# ------------------------------------------------------------------

@app.get("/dash/{video_id}/{filename:path}")
async def serve_dash_file(video_id: int, filename: str):
    file_path = Path("dash_streams") / str(video_id) / filename
    if not file_path.exists():
        raise HTTPException(404, "DASH file not found")
    mime_types = {".mpd": "application/dash+xml", ".m4s": "video/iso.segment", ".mp4": "video/mp4"}
    media_type = mime_types.get(file_path.suffix.lower(), "application/octet-stream")
    return FileResponse(path=file_path, media_type=media_type, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})


# ------------------------------------------------------------------
# Progressive fMP4 serving
# ------------------------------------------------------------------

@app.get("/progressive/{video_id}/progressive.mp4")
async def serve_progressive_init(video_id: int):
    """Serve the fMP4 init segment (moov box). Available once stream is initializing."""
    file_path = Path("progressive_streams") / str(video_id) / "progressive.mp4"
    if not file_path.exists():
        raise HTTPException(404, "Progressive init segment not yet available")
    return FileResponse(
        path=file_path,
        media_type="video/mp4",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


@app.get("/progressive/{video_id}/prog.m4s")
async def serve_progressive_stream(video_id: int, request: Request):
    """
    Stream progressive fMP4 media fragments from FFmpeg stdout.
    Single consumer only — returns 409 if already in use.
    Blocks until prog_init_ready, then streams live bytes to the client.
    """
    stream = storage.active_streams.get(video_id)
    if not stream:
        raise HTTPException(404, f"No active stream for video {video_id}")

    if stream.get("prog_consumer_active"):
        raise HTTPException(409, "Progressive stream already has an active consumer")

    # Wait for monitor thread to finish extracting the init segment
    init_ready: threading.Event = stream.get("prog_init_ready")
    if init_ready is None:
        raise HTTPException(503, "Progressive stream not initialised")

    loop = asyncio.get_event_loop()
    ready = await loop.run_in_executor(None, init_ready.wait, 15.0)
    if not ready:
        raise HTTPException(503, "Timed out waiting for progressive stream init")

    # Re-fetch stream in case it died while we were waiting
    stream = storage.active_streams.get(video_id)
    if not stream:
        raise HTTPException(404, "Stream ended before progressive consumer could connect")

    consumer_queue: qmod.Queue = qmod.Queue(maxsize=200)
    stream["consumer_queue"] = consumer_queue
    stream["prog_consumer_active"] = True

    async def generate():
        try:
            while True:
                s = storage.active_streams.get(video_id)
                if s is None:
                    break
                try:
                    chunk = await loop.run_in_executor(
                        None, lambda: consumer_queue.get(timeout=2.0)
                    )
                except qmod.Empty:
                    # Still alive, keep waiting
                    continue
                if chunk is None:
                    # Sentinel — stream is shutting down
                    break
                yield chunk
        except Exception:
            pass
        finally:
            s = storage.active_streams.get(video_id)
            if s and s.get("consumer_queue") is consumer_queue:
                s["consumer_queue"] = None
                s["prog_consumer_active"] = False

    return StreamingResponse(
        generate(),
        media_type="video/mp4",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


# ------------------------------------------------------------------
# WebSocket endpoint
# ------------------------------------------------------------------

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    Single global WebSocket endpoint.
    - All clients receive VIDEO_UPDATE events (global state changes).
    - Send {type: subscribe_video, video_id: N} to receive BBOX_UPDATE events for that stream.
    - Send {type: unsubscribe_video, video_id: N} to stop receiving bbox events.
    """
    await ws_manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_json()
            event_type = data.get("type")

            if event_type == WebSocketEventType.SUBSCRIBE_VIDEO:
                video_id = data.get("video_id")
                if isinstance(video_id, int):
                    await ws_manager.subscribe(websocket, video_id)

            elif event_type == WebSocketEventType.UNSUBSCRIBE_VIDEO:
                video_id = data.get("video_id")
                if isinstance(video_id, int):
                    await ws_manager.unsubscribe(websocket, video_id)

            elif event_type == WebSocketEventType.PING:
                await websocket.send_json({"type": WebSocketEventType.PONG})

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await ws_manager.disconnect(websocket)


# ------------------------------------------------------------------
# Utility endpoints
# ------------------------------------------------------------------

@app.get("/")
def root():
    return {
        "message": "Video Stream Management API",
        "docs": "/docs",
        "total_videos": len(storage.videos),
        "active_streams": len(storage.active_streams),
        "websocket_endpoint": "/ws",
        "dash_endpoint": "/dash/{video_id}/manifest.mpd",
        "progressive_init_endpoint": "/progressive/{video_id}/progressive.mp4",
        "progressive_stream_endpoint": "/progressive/{video_id}/prog.m4s",
    }


@app.get("/health")
def health_check():
    return {"status": "healthy"}


@app.api_route("/{full_path:path}", methods=["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH"])
async def catch_all(full_path: str):
    raise HTTPException(404, f"Route not found: /{full_path}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8702)
