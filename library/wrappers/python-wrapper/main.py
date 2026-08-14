"""Usage example: load the .so, register a frame handler, start sources, post one bbox per frame.

Run from the package directory: `uv run python main.py`
"""

from __future__ import annotations

import logging
import threading
import uuid

from video_library import (
    RawFrame,
    ResultBBOX,
    RunMode,
    init_state,
    init_video_library,
    populate_bboxes,
    start_sources,
)


def handle_frame(frame: RawFrame) -> None:
    # Runs INLINE on the library's decoder thread — keep it quick. `frame.data` is a zero-copy
    # view valid only for this call; use `frame.data.copy()` if you need to keep the pixels.
    logging.info(
        "received a frame src=%s %dx%d pts=%d",
        frame.source_id,
        frame.width,
        frame.height,
        frame.pts,
    )

    # Run your inference here. As an example, report one detection with a fresh uuid4 id.
    bbox = ResultBBOX(id=str(uuid.uuid4()), bbox=(0.0, 0.0, 10.0, 10.0), class_=0, score=0.9)
    try:
        populate_bboxes(frame, [bbox])
    except Exception:
        logging.exception("failed to post bboxes")


def main() -> None:
    logging.basicConfig(level=logging.INFO)

    init_video_library()
    init_state(handle_frame, RunMode.DEBUG)
    start_sources([1])

    logging.info("running — press Ctrl-C to stop")
    # The .so owns its own threads; just keep the process alive.
    threading.Event().wait()


if __name__ == "__main__":
    main()
