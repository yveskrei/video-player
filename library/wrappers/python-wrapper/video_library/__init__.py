"""Idiomatic Python example host for libclient_video.so.

Load the .so once with `init_video_library`, register a frame handler + run mode with
`init_state`, then drive sources — no ctypes types leak to the caller.
"""

from .library import (
    get_library,
    init_state,
    init_video_library,
    populate_bboxes,
    start_sources,
    stop_sources,
)
from .types import RawFrame, ResultBBOX, RunMode, SourceStatus

__all__ = [
    "init_video_library",
    "get_library",
    "init_state",
    "start_sources",
    "stop_sources",
    "populate_bboxes",
    "RawFrame",
    "ResultBBOX",
    "RunMode",
    "SourceStatus",
]
