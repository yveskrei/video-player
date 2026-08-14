"""Bbox ingest: PTS→wall-clock conversion, retention window, WS broadcast dispatch."""
import asyncio
import time
from fastapi import HTTPException

# Custom modules
from utils.storage import storage
from utils.models import BBoxCreate
from utils.enums import WebSocketEventType
from managers.stream import DASH_SEGMENT_DURATION, DASH_WINDOW_SIZE

# Variables
# asyncio.create_task holds only a weak ref; without this set the GC dropped
# in-flight broadcasts and bboxes only appeared after a full page refresh.
_pending_broadcasts: "set[asyncio.Task]" = set()

class BBoxManager:
    """Stores bboxes for the DVR window and broadcasts them to WS subscribers."""

    # Derived from the encoder's DASH window so retention always matches what the
    # client can seek to — retuning the window retunes retention, no second constant.
    # The 5s margin covers boundary races: cleanup runs on every POST, so a bbox at
    # the exact DVR left edge could otherwise be dropped mid-paint.
    RETENTION_MARGIN_SEC = 5
    RETENTION_PERIOD_MS = (DASH_SEGMENT_DURATION * DASH_WINDOW_SIZE + RETENTION_MARGIN_SEC) * 1000
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
    async def add_bboxes(bbox_data: BBoxCreate, websocket_manager=None) -> dict:
        """Store, broadcast, and return the bboxes enriched with absolute_timestamp_ms."""
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
        stored_bboxes: list = []

        for bbox in bbox_data.bboxes:
            pts = bbox.pts
            pts_ms = BBoxManager._pts_to_ms(pts)
            absolute_timestamp_ms = stream_start_time_ms + pts_ms

            if pts not in storage.bboxes[video_id]:
                storage.bboxes[video_id][pts] = []

            bbox_dict = {
                "id": bbox.id,
                "pts": pts,
                "absolute_timestamp_ms": absolute_timestamp_ms,
                "top_left_corner": bbox.top_left_corner,
                "bottom_right_corner": bbox.bottom_right_corner,
                "class_name": bbox.class_name,
                "confidence": bbox.confidence,
            }
            storage.bboxes[video_id][pts].append(bbox_dict)
            stored_bboxes.append(bbox_dict)

            if pts not in pts_groups:
                pts_groups[pts] = []
            pts_groups[pts].append(bbox_dict)

        BBoxManager._cleanup_old_bboxes(video_id, current_time_ms)

        # Detached on purpose: awaiting would serialise the POST response behind
        # every subscriber's send, so one slow client would stall ingest.
        if websocket_manager:
            for pts, bboxes in pts_groups.items():
                task = asyncio.create_task(websocket_manager.broadcast_bbox(video_id, {
                    "type": WebSocketEventType.BBOX_UPDATE,
                    "video_id": video_id,
                    "pts": pts,
                    "bboxes": bboxes,
                    "stream_start_time_ms": stream_start_time_ms,
                    "timestamp": current_time_ms,
                }))
                _pending_broadcasts.add(task)
                task.add_done_callback(_pending_broadcasts.discard)

        return {
            "source_id": video_id,
            "stream_start_time_ms": stream_start_time_ms,
            "bboxes": stored_bboxes,
        }

    @staticmethod
    def list_bboxes(video_id: int) -> dict:
        """Return all retained bboxes for a video, sorted by pts ascending."""
        if video_id not in storage.videos:
            raise HTTPException(404, f"Video {video_id} not found")

        stream = storage.active_streams.get(video_id)
        stream_start_time_ms = stream["start_time_ms"] if stream else None

        groups = storage.bboxes.get(video_id, {})
        result = []
        for pts in sorted(groups.keys()):
            result.append({
                "pts": pts,
                "bboxes": groups[pts],
            })
        return {
            "video_id": video_id,
            "stream_start_time_ms": stream_start_time_ms,
            "groups": result,
        }

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
