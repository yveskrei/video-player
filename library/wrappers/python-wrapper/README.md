# python-wrapper

Idiomatic Python example host for `libclient_video.so`, loading it via `ctypes`. The Python
counterpart of `../rust-wrapper`.

The frame handler runs **inline** on the library's decoder thread and receives a **zero-copy**
numpy view over the frame buffer — valid only for the duration of the call. To keep the pixels,
`frame.data.copy()`.

## Run

Build the `.so` first (from `library/`): `B2B_URL=http://127.0.0.1:8702 ./build_library.sh`.
`B2B_URL` is the **bare backend origin — no path prefix** (this backend serves its routes at the
root), and the backend needs no authentication token.

```bash
uv sync
uv run python main.py
```

`init_video_library()` loads the `.so` from `../../client/target/release/libclient_video.so` by
default (resolved from the package, not the CWD); pass a path to override.

## API

```python
from video_library import init_video_library, init_state, start_sources, stop_sources, \
    populate_bboxes, RawFrame, ResultBBOX, RunMode

init_video_library()                     # dlopen the .so
init_state(on_frame, RunMode.DEBUG)      # register handler + boot + run mode
start_sources([101, 102])                # one decoder per backend video id
# in on_frame(frame): populate_bboxes(frame, [ResultBBOX(...)])
```
