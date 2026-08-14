"""Data types crossing the boundary, plus the two library enums."""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum

import numpy as np

# Enums
class RunMode(IntEnum):
    REGULAR = 0
    DEBUG = 1


class SourceStatus(IntEnum):
    IDLE = 0
    INITIALIZING = 1
    STREAMING = 2
    TERMINATING = 3

    @classmethod
    def from_int(cls, value: int) -> "SourceStatus":
        try:
            return cls(value)
        except ValueError:
            return cls.IDLE


# COCO-ish class ids the demo recognizes; anything else stringifies its id.
_CLASS_NAMES = {
    0: "person",
    1: "bicycle",
    2: "car",
    3: "motorcycle",
    4: "airplane",
    5: "bus",
}


# Data crossing to the user
@dataclass
class RawFrame:
    """One decoded frame, tightly-packed RGB24 (stride = width*3). `pts` is 90 kHz.

    `data` is a ZERO-COPY view over the library's frame buffer and is valid ONLY for the
    duration of the handler call. Do not retain it; call `data.copy()` to keep the pixels.
    """

    source_id: int
    data: np.ndarray  # (height, width, 3) uint8
    width: int
    height: int
    pts: int


@dataclass
class ResultBBOX:
    """A single detection. `id` is a caller-supplied UUID, echoed back by the backend."""

    id: str
    bbox: tuple[float, float, float, float]  # x1, y1, x2, y2
    class_: int
    score: float

    def class_name(self) -> str:
        return _CLASS_NAMES.get(self.class_, str(self.class_))

    def corners_coordinates(self, frame: RawFrame) -> tuple[int, int]:
        """The two flat pixel indices (`y*width + x`) for `[x1, y1, x2, y2]`."""
        x1, y1, x2, y2 = (int(v) for v in self.bbox)
        top_left_corner = y1 * frame.width + x1
        bottom_right_corner = y2 * frame.width + x2
        return top_left_corner, bottom_right_corner
