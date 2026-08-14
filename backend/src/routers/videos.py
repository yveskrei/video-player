"""/videos routes — upload, list, fetch and delete."""
from typing import Optional
from fastapi import APIRouter, UploadFile, File, Form
from fastapi.responses import Response

# Custom modules
from utils.models import VideoInfo
from managers.video import VideoManager

# Variables
router = APIRouter(prefix="/videos", tags=["videos"])

@router.post("/upload", status_code=204)
async def upload_video(
    file: UploadFile = File(...),
    name: Optional[str] = Form(None),
):
    """Upload a video file. Creation event broadcast via WebSocket."""
    await VideoManager.create_video(file, name or file.filename)
    return Response(status_code=204)

@router.get("/", response_model=list[VideoInfo])
def list_videos():
    """List all videos with current stream status."""
    return VideoManager.list_videos()

@router.get("/{video_id}", response_model=VideoInfo)
def get_video(video_id: int):
    """Get a video by ID with current stream status."""
    return VideoManager.get_video(video_id)

@router.delete("/{video_id}", status_code=204)
def delete_video(video_id: int):
    """Delete a video. Deletion event broadcast via WebSocket."""
    VideoManager.delete_video(video_id)
    return Response(status_code=204)
