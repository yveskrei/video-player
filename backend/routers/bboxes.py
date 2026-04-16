from fastapi import APIRouter
from models import BBoxCreate
from bbox_manager import BBoxManager
from websocket_manager import manager as ws_manager

router = APIRouter(prefix="/bboxes", tags=["bboxes"])


@router.post("/")
async def add_bboxes(bbox_data: BBoxCreate):
    """Add bounding boxes, broadcast to subscribed WebSocket clients, and
    return the stored bboxes (each annotated with absolute_timestamp_ms) so
    clients such as the FFI library can echo them back through their own
    PostResultsCallback with real-world timestamps already computed."""
    return await BBoxManager.add_bboxes(bbox_data, websocket_manager=ws_manager)


@router.get("/{video_id}")
def list_bboxes(video_id: int):
    """Return all retained bboxes for a video (the DVR window history)."""
    return BBoxManager.list_bboxes(video_id)


@router.post("/cleanup")
def cleanup_old_bboxes():
    """Manually trigger cleanup of expired bboxes across all videos."""
    return BBoxManager.cleanup_all_old_bboxes()
