from typing import Dict, List
from pathlib import Path


class Storage:
    """In-memory storage for videos, streams, and bounding boxes"""

    def __init__(self):
        self.videos: Dict[int, dict] = {}
        # active_streams[video_id] = {
        #   "status": StreamStatus,
        #   "process": subprocess.Popen,
        #   "pid": int,
        #   "start_time_ms": int,
        #   "dash_manifest_url": str,
        #   "prog_init_ready": threading.Event,
        #   "hub": ProgressiveHub,  # fan-out for multi-client prog.m4s
        # }
        self.active_streams: Dict[int, dict] = {}
        self.bboxes: Dict[int, Dict[int, List[dict]]] = {}
        self.next_video_id: int = 1
        self.video_storage_path = Path("./videos")
        self.video_storage_path.mkdir(exist_ok=True)

    def get_next_video_id(self) -> int:
        video_id = self.next_video_id
        self.next_video_id += 1
        return video_id


# Global storage instance
storage = Storage()
