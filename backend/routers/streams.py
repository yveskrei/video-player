from fastapi import APIRouter
from fastapi.responses import Response
from models import StreamConfig
from stream_manager import StreamManager

router = APIRouter(prefix="/streams", tags=["streams"])


@router.post("/start", status_code=204)
def start_stream(config: StreamConfig):
    """Start streaming a video. State changes are broadcast via WebSocket."""
    StreamManager.start_stream(config.video_id)
    return Response(status_code=204)


@router.post("/stop/{video_id}", status_code=204)
def stop_stream(video_id: int):
    """Stop a stream. Cleanup and final state are broadcast via WebSocket."""
    StreamManager.stop_stream(video_id)
    return Response(status_code=204)


@router.get("/status/{video_id}")
def get_stream_status(video_id: int):
    """Get the current stream status for a video."""
    return StreamManager.get_stream_status(video_id)
