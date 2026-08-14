"""In-process state and the on-disk locations it maps to. No database anywhere."""
from typing import Dict, List
from pathlib import Path

# Variables
# Anchored to backend/ via __file__, not the CWD: main.py chdirs into src/ so
# uvicorn's reloader only watches source. Defined once here; main and
# managers.stream import them rather than re-spelling the literals.
BACKEND_ROOT = Path(__file__).resolve().parents[2]
DASH_OUTPUT_DIR = BACKEND_ROOT / "dash_streams"
PROGRESSIVE_OUTPUT_DIR = BACKEND_ROOT / "progressive_streams"
VIDEO_STORAGE_PATH = BACKEND_ROOT / "videos"

class Storage:
    """Videos, active streams and retained bboxes. Wiped on every restart."""

    def __init__(self):
        self.videos: Dict[int, dict] = {}
        # active_streams[video_id] = {status, process, pid, start_time_ms,
        #   dash_manifest_url, prog_init_ready: threading.Event, hub: ProgressiveHub}
        self.active_streams: Dict[int, dict] = {}
        self.bboxes: Dict[int, Dict[int, List[dict]]] = {}
        self.next_video_id: int = 1
        self.video_storage_path = VIDEO_STORAGE_PATH
        self.video_storage_path.mkdir(exist_ok=True)

    def get_next_video_id(self) -> int:
        video_id = self.next_video_id
        self.next_video_id += 1
        return video_id

storage = Storage()
