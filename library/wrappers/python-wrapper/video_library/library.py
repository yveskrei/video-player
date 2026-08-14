"""ctypes binding + singleton for libclient_video.so.

The frame handler runs INLINE on the library's decoder thread and receives a zero-copy
numpy view over the frame buffer (valid only during the call). No thread pool: heavy work in
the handler stalls decode, and across sources the GIL serializes handlers.
"""

from __future__ import annotations

import ctypes
import json
import logging
import os
import threading
from ctypes import (
    CFUNCTYPE,
    POINTER,
    c_char_p,
    c_int,
    c_longlong,
    c_ubyte,
    c_uint,
    c_void_p,
)
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
import numpy as np

# Custom modules
from .types import RawFrame, ResultBBOX, RunMode, SourceStatus

# Variables
logger = logging.getLogger(__name__)

# C ABI callback types. Owned pointers we must free are c_void_p (c_char_p would auto-convert
# to bytes and lose the address FreeCPtr needs); the borrowed frame buffer is a plain pointer.
FramesCB = CFUNCTYPE(None, c_uint, POINTER(c_ubyte), c_int, c_int, c_longlong)
MetadataCB = CFUNCTYPE(None, c_uint, c_void_p, c_int, c_int, c_int)
StatusCB = CFUNCTYPE(None, c_uint, c_int)
ResultsCB = CFUNCTYPE(None, c_uint, c_int, POINTER(c_void_p), POINTER(c_longlong))

# Singleton
@dataclass
class _Library:
    cdll: ctypes.CDLL
    on_frame: Callable[[RawFrame], None] | None = None
    # Retained CFUNCTYPE instances — the .so stores their raw pointers, so they must outlive it.
    callbacks: tuple = ()

_STATE: _Library | None = None
_LOCK = threading.Lock()

def _default_so_path() -> str:
    # video_library/library.py -> parents[3] is the video-library/ component root.
    root = Path(__file__).resolve().parents[3]
    return str(root / "client" / "target" / "release" / "libclient_video.so")

# Callbacks
# Library -> host. Wrapped instances below are kept alive as module globals for the process
# lifetime — the .so stores the pointers. A Python exception must never cross into C.
def _frames_callback(source_id, frame_ptr, width, height, pts):
    try:
        state = _STATE
        if state is None or state.on_frame is None or not frame_ptr:
            return
        # Zero-copy view over the borrowed buffer; invalid once this call returns.
        arr = np.ctypeslib.as_array(frame_ptr, shape=(height, width, 3))
        arr.setflags(write=False)
        frame = RawFrame(
            source_id=source_id,
            data=arr,
            width=width,
            height=height,
            pts=pts,
        )
        state.on_frame(frame)
    except Exception:
        logger.exception("frames callback failed (src=%s)", source_id)

def _metadata_callback(source_id, name_ptr, width, height, fps):
    try:
        state = _STATE
        name = _read_owned_str(state.cdll, name_ptr) if state else ""
        logger.info(
            "got source metadata src=%s name=%r %dx%d @%d",
            source_id,
            name,
            width,
            height,
            fps,
        )
    except Exception:
        logger.exception("metadata callback failed (src=%s)", source_id)

def _status_callback(source_id, status):
    try:
        logger.info("got source status src=%s status=%s", source_id, SourceStatus.from_int(status).name)
    except Exception:
        logger.exception("status callback failed (src=%s)", source_id)

def _results_callback(source_id, count, ids_ptr, timestamps_ptr):
    try:
        state = _STATE
        if state is None:
            return
        n = max(count, 0)
        # Copy ids out before freeing anything, then free N id strings + the 2 arrays.
        ids: list[str] = []
        for i in range(n):
            ptr = ids_ptr[i]
            value = ctypes.cast(ctypes.c_void_p(ptr), c_char_p).value if ptr else None
            ids.append(value.decode("utf-8", "replace") if value else "")
            if ptr:
                state.cdll.FreeCPtr(ptr)
        timestamps = [int(timestamps_ptr[i]) for i in range(n)]
        state.cdll.FreeCPtr(ctypes.cast(ids_ptr, c_void_p))
        state.cdll.FreeCPtr(ctypes.cast(timestamps_ptr, c_void_p))
        logger.info(
            "got post results response src=%s count=%s ids=%s timestamps=%s",
            source_id,
            count,
            ids,
            timestamps,
        )
    except Exception:
        logger.exception("results callback failed (src=%s)", source_id)

# User-facing API
def init_video_library(so_path: str | os.PathLike[str] | None = None) -> None:
    """Load the .so once. `so_path` defaults to the built artifact under client/target/release."""
    global _STATE
    with _LOCK:
        if _STATE is not None:
            raise RuntimeError("video library is already initiated")
        path = str(so_path) if so_path is not None else _default_so_path()
        cdll = ctypes.CDLL(path)
        _configure_signatures(cdll)
        _STATE = _Library(cdll=cdll)

def get_library() -> _Library:
    state = _STATE
    if state is None:
        raise RuntimeError("video library is not initiated")
    return state

def init_state(on_frame: Callable[[RawFrame], None], run_mode: RunMode = RunMode.REGULAR) -> None:
    """Register the frame handler and boot the library, then apply the run mode."""
    state = get_library()
    state.on_frame = on_frame
    # Retain the trampolines for the process lifetime — the .so keeps their raw pointers, so if
    # these were GC'd the first callback would dereference freed memory (segfault).
    state.callbacks = (
        FramesCB(_frames_callback),
        MetadataCB(_metadata_callback),
        StatusCB(_status_callback),
        ResultsCB(_results_callback),
    )
    # Order matters: SetCallbacks boots the library's global state; SetSettings is a no-op until then.
    state.cdll.SetCallbacks(*state.callbacks)
    state.cdll.SetSettings(int(run_mode))

def start_sources(source_ids: list[int]) -> None:
    """Start a decoder per source id (backend video ids)."""
    if not source_ids:
        raise ValueError("no source ids provided")
    state = get_library()
    ids = (c_uint * len(source_ids))(*source_ids)
    state.cdll.InitSources(ids, len(source_ids))

def stop_sources(source_ids: list[int]) -> None:
    """Stop the decoders for the given source ids."""
    if not source_ids:
        raise ValueError("no source ids provided")
    state = get_library()
    ids = (c_uint * len(source_ids))(*source_ids)
    state.cdll.StopSources(ids, len(source_ids))

def populate_bboxes(frame: RawFrame, bboxes: list[ResultBBOX]) -> None:
    """Post detections for a frame's source back to the backend."""
    state = get_library()

    result_ids = [bbox.id for bbox in bboxes]
    bboxes_json = []
    for bbox in bboxes:
        top_left_corner, bottom_right_corner = bbox.corners_coordinates(frame)
        bboxes_json.append(
            {
                "id": bbox.id,
                "pts": frame.pts,
                "top_left_corner": top_left_corner,
                "bottom_right_corner": bottom_right_corner,
                "class_name": bbox.class_name(),
                "confidence": bbox.score,
            }
        )
    body = json.dumps({"stream_id": frame.source_id, "bboxes": bboxes_json})

    ids_arr = (c_char_p * len(result_ids))(*[rid.encode("utf-8") for rid in result_ids])
    code = state.cdll.PostResults(
        frame.source_id,
        len(result_ids),
        ids_arr,
        body.encode("utf-8"),
    )
    if code != 0:
        raise RuntimeError(f"PostResults failed with code {code}")

# Helper functions
def _configure_signatures(cdll: ctypes.CDLL) -> None:
    cdll.SetCallbacks.argtypes = [FramesCB, MetadataCB, StatusCB, ResultsCB]
    cdll.SetCallbacks.restype = None
    cdll.SetSettings.argtypes = [c_int]
    cdll.SetSettings.restype = None
    cdll.InitSources.argtypes = [POINTER(c_uint), c_int]
    cdll.InitSources.restype = None
    cdll.StopSources.argtypes = [POINTER(c_uint), c_int]
    cdll.StopSources.restype = None
    cdll.PostResults.argtypes = [c_uint, c_int, POINTER(c_char_p), c_char_p]
    cdll.PostResults.restype = c_int
    cdll.FreeCPtr.argtypes = [c_void_p]
    cdll.FreeCPtr.restype = None

def _read_owned_str(cdll: ctypes.CDLL, ptr: int | None) -> str:
    """Read a library-owned C string and hand the pointer back to FreeCPtr."""
    if not ptr:
        return ""
    value = ctypes.cast(ctypes.c_void_p(ptr), c_char_p).value
    cdll.FreeCPtr(ptr)
    return value.decode("utf-8", "replace") if value else ""
