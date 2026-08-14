"""/bboxes routes — AI analytics ingest and DVR-window history."""
from fastapi import APIRouter

# Custom modules
from utils.models import BBoxCreate
from managers.bbox import BBoxManager
from managers.websocket import manager as ws_manager

# Variables
router = APIRouter(prefix="/bboxes", tags=["bboxes"])

@router.post("/")
async def add_bboxes(bbox_data: BBoxCreate):
    """Store and broadcast bboxes. Returns them with absolute_timestamp_ms so the
    FFI library can echo real-world timestamps through its PostResultsCallback."""
    return await BBoxManager.add_bboxes(bbox_data, websocket_manager=ws_manager)

@router.get("/{video_id}")
def list_bboxes(video_id: int):
    """Return all retained bboxes for a video (the DVR window history)."""
    return BBoxManager.list_bboxes(video_id)

@router.post("/cleanup")
def cleanup_old_bboxes():
    """Manually trigger cleanup of expired bboxes across all videos."""
    return BBoxManager.cleanup_all_old_bboxes()
