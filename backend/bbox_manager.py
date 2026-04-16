from fastapi import HTTPException
from storage import storage
from models import BBoxCreate
from enums import WebSocketEventType
import time


class BBoxManager:
    """Handles bounding box storage and WebSocket broadcasting"""

    RETENTION_PERIOD_MS = 5 * 60 * 1000    # 5 minutes
    STANDARD_TIME_BASE = 90000.0            # MPEG-TS 90 kHz

    @staticmethod
    def _pts_to_ms(pts: int) -> int:
        return int((pts / BBoxManager.STANDARD_TIME_BASE) * 1000)

    @staticmethod
    def _cleanup_old_bboxes(video_id: int, current_time_ms: int) -> None:
        if video_id not in storage.bboxes:
            return
        cutoff = current_time_ms - BBoxManager.RETENTION_PERIOD_MS
        stale = [
            pts
            for pts, bbox_list in storage.bboxes[video_id].items()
            if bbox_list and bbox_list[0].get("absolute_timestamp_ms", 0) < cutoff
        ]
        for pts in stale:
            del storage.bboxes[video_id][pts]

    @staticmethod
    async def add_bboxes(bbox_data: BBoxCreate, websocket_manager=None) -> None:
        """Store bounding boxes and broadcast them to subscribed WebSocket clients."""
        video_id = bbox_data.stream_id

        if video_id not in storage.videos:
            raise HTTPException(404, f"Video {video_id} not found")
        if video_id not in storage.active_streams:
            raise HTTPException(400, f"Video {video_id} is not currently streaming")

        stream_start_time_ms = storage.active_streams[video_id]["start_time_ms"]

        if video_id not in storage.bboxes:
            storage.bboxes[video_id] = {}

        current_time_ms = int(time.time() * 1000)
        pts_groups: dict = {}

        for bbox in bbox_data.bboxes:
            pts = bbox.pts
            pts_ms = BBoxManager._pts_to_ms(pts)
            absolute_timestamp_ms = stream_start_time_ms + pts_ms

            if pts not in storage.bboxes[video_id]:
                storage.bboxes[video_id][pts] = []

            bbox_dict = {
                "pts": pts,
                "absolute_timestamp_ms": absolute_timestamp_ms,
                "top_left_corner": bbox.top_left_corner,
                "bottom_right_corner": bbox.bottom_right_corner,
                "class_name": bbox.class_name,
                "confidence": bbox.confidence,
            }
            storage.bboxes[video_id][pts].append(bbox_dict)

            if pts not in pts_groups:
                pts_groups[pts] = []
            pts_groups[pts].append(bbox_dict)

        BBoxManager._cleanup_old_bboxes(video_id, current_time_ms)

        if websocket_manager:
            for pts, bboxes in pts_groups.items():
                await websocket_manager.broadcast_bbox(video_id, {
                    "type": WebSocketEventType.BBOX_UPDATE,
                    "video_id": video_id,
                    "pts": pts,
                    "bboxes": bboxes,
                    "stream_start_time_ms": stream_start_time_ms,
                    "timestamp": current_time_ms,
                })

    @staticmethod
    def cleanup_all_old_bboxes() -> dict:
        """Manually trigger cleanup of old bboxes across all videos."""
        current_time_ms = int(time.time() * 1000)
        cleaned_videos = 0
        total_removed = 0

        for video_id in list(storage.bboxes.keys()):
            if video_id not in storage.videos:
                del storage.bboxes[video_id]
                cleaned_videos += 1
                continue
            initial_count = len(storage.bboxes[video_id])
            BBoxManager._cleanup_old_bboxes(video_id, current_time_ms)
            removed = initial_count - len(storage.bboxes[video_id])
            if removed > 0:
                cleaned_videos += 1
                total_removed += removed

        return {
            "cleaned_videos": cleaned_videos,
            "total_pts_removed": total_removed,
            "retention_period_ms": BBoxManager.RETENTION_PERIOD_MS,
        }
