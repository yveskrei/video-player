"""Pydantic request/response models. Field descriptions feed the OpenAPI schema."""
from pydantic import BaseModel, Field
from typing import Optional, List

# Custom modules
from utils.enums import StreamStatus

class VideoInfo(BaseModel):
    id: int
    name: str
    file_path: str
    created_at: str
    width: int
    height: int
    fps: float
    stream_status: StreamStatus = StreamStatus.STOPPED
    stream_start_time_ms: Optional[int] = None
    dash_manifest_url: Optional[str] = None
    prog_url: Optional[str] = None
    prog_init_url: Optional[str] = None
    # Authoritative DVR capacity, so the frontend never hardcodes the window size.
    dvr_window_seconds: Optional[int] = None

class BBoxData(BaseModel):
    # Echoed back verbatim in the POST response, the WS broadcast and
    # GET /bboxes/{video_id}. The Rust FFI library requires it to pair each
    # detection with its absolute_timestamp_ms.
    id: Optional[str] = None
    pts: int = Field(..., description="Presentation timestamp in raw stream units (90kHz)")
    # Corners are flattened 1-D pixel indices: y = idx // width, x = idx % width.
    top_left_corner: int = Field(..., description="Top-left corner pixel index")
    bottom_right_corner: int = Field(..., description="Bottom-right corner pixel index")
    class_name: str = Field(..., description="Object class name")
    confidence: float = Field(..., ge=0, le=1, description="Detection confidence")

class BBoxCreate(BaseModel):
    # stream_id is the video_id; the POST response calls the same value source_id.
    stream_id: int
    bboxes: List[BBoxData]

class StreamConfig(BaseModel):
    video_id: int
