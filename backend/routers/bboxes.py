from fastapi import APIRouter
from fastapi.responses import Response
from models import BBoxCreate
from bbox_manager import BBoxManager
from websocket_manager import manager as ws_manager

router = APIRouter(prefix="/bboxes", tags=["bboxes"])


@router.post("/", status_code=204)
async def add_bboxes(bbox_data: BBoxCreate):
    """Add bounding boxes and broadcast to subscribed WebSocket clients."""
    await BBoxManager.add_bboxes(bbox_data, websocket_manager=ws_manager)
    return Response(status_code=204)


@router.post("/cleanup")
def cleanup_old_bboxes():
    """Manually trigger cleanup of expired bboxes across all videos."""
    return BBoxManager.cleanup_all_old_bboxes()
