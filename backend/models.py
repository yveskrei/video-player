from pydantic import BaseModel, Field
from typing import Optional, List
from enums import StreamStatus


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
    # DVR capacity in seconds — authoritative value from the backend so the
    # frontend doesn't have to hardcode the window size.
    dvr_window_seconds: Optional[int] = None


class BBoxData(BaseModel):
    pts: int = Field(..., description="Presentation timestamp in raw stream units (90kHz)")
    top_left_corner: int = Field(..., description="Top-left corner pixel index")
    bottom_right_corner: int = Field(..., description="Bottom-right corner pixel index")
    class_name: str = Field(..., description="Object class name")
    confidence: float = Field(..., ge=0, le=1, description="Detection confidence")


class BBoxCreate(BaseModel):
    stream_id: int
    bboxes: List[BBoxData]


class StreamConfig(BaseModel):
    video_id: int
