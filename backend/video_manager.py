from fastapi import HTTPException, UploadFile
from datetime import datetime
from pathlib import Path
from storage import storage
from models import VideoInfo
from enums import StreamStatus, VideoUpdateReason
from websocket_manager import manager as ws_manager, broadcast_sync
import subprocess
import json
import logging

logger = logging.getLogger(__name__)


class VideoManager:
    """Handles video file operations and metadata"""

    @staticmethod
    def _get_video_properties(file_path: str) -> dict:
        """Use ffprobe to extract width, height, and fps. Raises ValueError on failure."""
        cmd = [
            "ffprobe",
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,avg_frame_rate",
            "-of", "json",
            file_path,
        ]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            data = json.loads(result.stdout)

            if not data.get("streams"):
                raise ValueError("No video streams found in file")

            stream_data = data["streams"][0]

            fps_str = stream_data.get("avg_frame_rate", "0/1")
            if not fps_str or fps_str == "0/0":
                raise ValueError("Invalid or missing frame rate")
            num, den = map(float, fps_str.split("/"))
            if den == 0:
                raise ValueError("Invalid frame rate (division by zero)")
            fps = num / den

            width = stream_data.get("width")
            height = stream_data.get("height")

            if not width or width <= 0:
                raise ValueError(f"Invalid width: {width}")
            if not height or height <= 0:
                raise ValueError(f"Invalid height: {height}")
            if fps <= 0:
                raise ValueError(f"Invalid fps: {fps}")

            logger.info(f"Video properties for {file_path}: {width}x{height} @ {fps:.2f} fps")
            return {"width": int(width), "height": int(height), "fps": float(fps)}

        except subprocess.CalledProcessError as e:
            raise ValueError(f"Failed to analyze video file: {e.stderr}")
        except json.JSONDecodeError as e:
            raise ValueError(f"Failed to parse video metadata: {e}")
        except Exception as e:
            raise ValueError(f"Failed to get video properties: {e}")

    @staticmethod
    def _build_video_info(video_id: int) -> VideoInfo:
        """Build a VideoInfo model for a video, including current stream state."""
        video_data = storage.videos[video_id]
        stream = storage.active_streams.get(video_id)
        status = stream["status"] if stream else StreamStatus.STOPPED
        return VideoInfo(
            id=video_data["id"],
            name=video_data["name"],
            file_path=video_data["file_path"],
            created_at=video_data["created_at"],
            width=video_data["width"],
            height=video_data["height"],
            fps=video_data["fps"],
            stream_status=status,
            stream_start_time_ms=stream.get("start_time_ms") if stream else None,
            dash_manifest_url=stream.get("dash_manifest_url") if stream else None,
            prog_url=f"/progressive/{video_id}/prog.m4s" if stream else None,
            prog_init_url=f"/progressive/{video_id}/progressive.mp4" if stream else None,
        )

    @staticmethod
    async def create_video(file: UploadFile, name: str) -> None:
        """Upload and register a new video, then broadcast its creation."""
        if not file.filename.lower().endswith((".mp4", ".avi", ".mov", ".mkv")):
            raise HTTPException(400, "Only video files allowed (.mp4, .avi, .mov, .mkv)")

        video_id = storage.get_next_video_id()
        video_name = name or file.filename
        file_path = storage.video_storage_path / f"{video_id}.mp4"

        try:
            with open(file_path, "wb") as f:
                content = await file.read()
                f.write(content)
        except Exception as e:
            raise HTTPException(500, f"Failed to save file: {e}")

        try:
            properties = VideoManager._get_video_properties(str(file_path))
        except ValueError as e:
            if file_path.exists():
                file_path.unlink()
            raise HTTPException(400, f"Invalid video file: {e}")

        video_data = {
            "id": video_id,
            "name": video_name,
            "file_path": str(file_path),
            "created_at": datetime.now().isoformat(),
            "width": properties["width"],
            "height": properties["height"],
            "fps": properties["fps"],
        }

        storage.videos[video_id] = video_data
        storage.bboxes[video_id] = {}

        logger.info(
            f"Video {video_id} created: {video_name} "
            f"({properties['width']}x{properties['height']} @ {properties['fps']:.2f} fps)"
        )

        await ws_manager.broadcast_video_update(
            video_id,
            VideoUpdateReason.CREATED,
            VideoManager._build_video_info(video_id).model_dump(),
        )

    @staticmethod
    def get_video(video_id: int) -> VideoInfo:
        if video_id not in storage.videos:
            raise HTTPException(404, f"Video {video_id} not found")
        return VideoManager._build_video_info(video_id)

    @staticmethod
    def list_videos() -> list[VideoInfo]:
        return [VideoManager._build_video_info(vid) for vid in list(storage.videos.keys())]

    @staticmethod
    def delete_video(video_id: int) -> None:
        """Delete a video. Raises 400 if a stream is currently active."""
        if video_id not in storage.videos:
            raise HTTPException(404, f"Video {video_id} not found")

        if video_id in storage.active_streams:
            raise HTTPException(
                400,
                f"Cannot delete video {video_id}: stop the stream first",
            )

        video_data = storage.videos[video_id]
        file_path = Path(video_data["file_path"])
        if file_path.exists():
            file_path.unlink()

        del storage.videos[video_id]
        storage.bboxes.pop(video_id, None)

        logger.info(f"Video {video_id} deleted")

        broadcast_sync(
            ws_manager.broadcast_video_update(
                video_id,
                VideoUpdateReason.DELETED,
                {"id": video_id, "stream_status": StreamStatus.STOPPED},
            )
        )
