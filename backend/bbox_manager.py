import asyncio
from fastapi import HTTPException
from storage import storage
from models import BBoxCreate
from enums import WebSocketEventType
from stream_manager import DASH_SEGMENT_DURATION, DASH_WINDOW_SIZE
import time

# Strong references to in-flight broadcast tasks. asyncio.create_task only
# holds a weak reference, so without this set the tasks can be garbage-
# collected mid-flight — which silently drops the WS broadcast and the
# frontend only sees bboxes after a full page refresh (via GET /bboxes/).
_pending_broadcasts: "set[asyncio.Task]" = set()


class BBoxManager:
    """Handles bounding box storage and WebSocket broadcasting"""

    # Derived from the FFmpeg DASH window so the bbox store always matches
    # what the client can actually seek to. Changing the encoder's window
    # size automatically widens / narrows retention accordingly — no second
    # constant to keep in sync. The extra 5s is a safety margin against
    # boundary-timing races (cleanup happens on each POST, so a bbox at the
    # exact DVR left-edge could otherwise be stripped moments before the
    # client finishes painting it). A gap at the left edge of the seekbar
    # shorter than this is just library warmup: the time between backend
    # stream-start and the FFI library's first successful decode/post.
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
        """Store bounding boxes, broadcast to subscribers, and return the stored
        bboxes (with per-bbox absolute_timestamp_ms) so the ingesting client
        can attach real-world timestamps to its own bookkeeping."""
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

        # Fire-and-forget broadcast: awaiting it would serialise the POST
        # response behind every subscriber's WS send, so a single slow client
        # stalls the ingest pipeline. Detaching keeps /bboxes/ fast regardless.
        # Each task is tracked in _pending_broadcasts so CPython's GC can't
        # drop it before send_text completes.
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
    def list_bboxes(video_id: int) -> list:
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
