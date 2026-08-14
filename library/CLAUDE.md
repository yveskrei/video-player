# library/ — agent contract

## What this is

A Rust `cdylib` — **`libclient_video.so`** — that a native host `dlopen`s. It pulls the backend's **progressive fMP4** stream over two plain HTTP GETs, decodes H.264/HEVC to tightly-packed **RGB24** with a statically-linked decoder-only **FFmpeg n7.1.5**, hands each frame to a host callback, and posts the host's detections to `POST /bboxes/`.

**Six exported symbols, four callback typedefs, zero `#[repr(C)]` structs.** The library **never** touches DASH or the WebSocket — those belong to the frontend.

Not part of the dev loop. It is **not** a registered moon project — `.moon/workspace.yml` lists only `backend` and `frontend`, so `moon run frontend:dev` neither builds nor runs it. Use the three build scripts below.

## Commands

```bash
cd library
./download_dependencies.sh                              # phase 1 (ONLINE)  — FFmpeg n7.1.5 source
./build_dependencies.sh                                 # phase 2 (offline) — static FFmpeg
B2B_URL=http://127.0.0.1:8702 ./build_library.sh        # phase 3 (offline) — the .so

# smoke test (backend running, video 1 streaming)
cd client && cargo run --release --bin test_client -- --source_ids 1
```

Phases 1 and 2 are normally **skippable** — `dependencies_src.tar.gz` and `dependencies.tar.gz` are both present in the tree (gitignored by `*.gz`, but on disk).

⚠️ **A bare `cargo check` / `cargo build` fails on this machine.** With `FFMPEG_DIR` unset, `build.rs` falls back to the system FFmpeg via pkg-config, and the FFmpeg dev headers are not installed. **Always build through `build_library.sh`.**

Only build this component when library files changed. Don't run `uv` or `bun` for a library-only edit.

## Layout

The crate lives one level down, in `client/`. **That nesting is load-bearing** — the build scripts, `rust-wrapper`'s `SO_PATH`, and `python-wrapper`'s `parents[3]` resolution all assume it. Do not flatten it.

| Path | Lines | Role |
|---|---|---|
| `client/src/api.rs` | 157 | The six `extern "C"` exports |
| `client/src/state.rs` | 286 | Global singleton, callback typedefs, `trigger_*` C shims |
| `client/src/source.rs` | 448 | Per-source supervisor / decoder thread / results worker, `SourceStatus` FSM |
| `client/src/mp4.rs` | 148 | Media-engine façade — `Decoder::open` / `run`, resync loop |
| `client/src/mp4/ffmpeg.rs` | 643 | The **only** FFI module — RAII wrappers over `ffmpeg-sys-next` |
| `client/src/utils.rs` | 88 | C pointer read/alloc helpers |
| `client/src/utils/registry_api.rs` | 154 | HTTP layer — the four backend endpoints |
| `client/src/utils/{logger,queue}.rs` | 59 / 74 | JSON `tracing` subscriber; bounded drop-oldest queue |
| `client/src/bin/test_client.rs` | 116 | Smoke-test host (not in the shipped `.so`) |
| `client/build.rs` | 44 | Static-FFmpeg link wiring + `--exclude-libs,ALL` |
| `wrappers/python-wrapper/` | — | `ctypes` example host (zero-copy numpy frame view) |
| `wrappers/rust-wrapper/` | — | `libloading` example host (copies frame, defers handler) |
| `*.sh` | — | The three build phases |

## Rules & conventions

- ⚠️ **`B2B_URL` has NO path prefix.** It is a compile-time `env!` (`client/src/state.rs:21`) and must be the **bare origin**: `http://127.0.0.1:8702`. This backend serves `/videos/`, `/progressive/…` and `/bboxes/` at the root. A `/video` prefix (as used by other deployments of this library) makes every call hit the catch-all 404 — nothing crashes, the library just sits in `Initializing` forever. Changing the address **requires a rebuild**.
- **No authentication anywhere.** This backend has none, so the library sends no API-key header and there is no build-time token variable. Do not re-add either — `B2BCredentials` (`utils/registry_api.rs:13`) intentionally carries a URL and nothing else.
- **House style (keep it):** no `.unwrap()` / `.expect()` — a panic must not cross the C ABI. Fully-qualified `tracing::`, `anyhow::bail!`, `anyhow::anyhow!`. No `mod tests`. Keep `crate-type = ["cdylib", "rlib"]` (the `rlib` is what lets `test_client` link).
- **`panic = "unwind"` is deliberate** (`client/Cargo.toml:33`). The six exports are *not* yet `catch_unwind`-guarded; adding those guards is the intended fix, and it only works under `unwind`. **Never switch to `abort`.**
- **All `unsafe` FFmpeg FFI lives in `client/src/mp4/ffmpeg.rs`.** Keep it there. Every wrapper owns exactly one resource and frees it in `Drop`.
- **PTS is 90 kHz** (`mp4/ffmpeg.rs:622`). Must stay in lockstep with `backend/src/managers/bbox.py` `STANDARD_TIME_BASE` and the frontend's five `PTS_TIMEBASE` declarations.
- **bbox corners are flattened 1-D pixel indices**, `idx = y*width + x` — not `(x, y)` pairs.
- **Three names, one integer:** `source_id` (FFI + POST response) = `stream_id` (POST request body) = `video_id` (backend internal).
- **Memory:** the frame buffer is **BORROWED** (never free it); `source_name` is **OWNED** (one `FreeCPtr`); `PostResultsCB` needs **N + 2** frees — copy the `char*` values out *before* freeing the array holding them.
- **No tests, no CI** anywhere in this repo. Verification is manual via `test_client` against a live stream.

## Do not touch

| Thing | Location | Why |
|---|---|---|
| The `client/` nesting | — | `build_library.sh`, `SO_PATH`, and `parents[3]` all resolve through it |
| No manual `--version-script` | `client/build.rs:6-13` | rustc auto-generates one for the cdylib; a second makes the linker fail with *"anonymous version tag cannot be combined with other version tags"*. `-Wl,--exclude-libs,ALL` is the only link arg needed |
| `LIBCLANG_PATH` pin to llvm19 | `build_library.sh:63-68` | `ffmpeg-sys-next 7.1` pins bindgen 0.70, which mis-generates against libclang ≥ 20 → `E0080` const-eval overflow. Needs libclang **18–19** |
| The `-Bstatic` / `-Bdynamic` split | `build_library.sh:77-90` | FFmpeg from `.a`, libc/libstdc++/libm/libz/libpthread/libdl from the host. Link order `avformat → avcodec → avutil` matters |
| `--disable-network` | `build_dependencies.sh:77` | FFmpeg does **no** I/O; reqwest owns the network and feeds a custom AVIO. Also keeps the build LGPL-clean (no x264, no `--enable-gpl`) |
| `catch_unwind` on the AVIO read callback | `mp4/ffmpeg.rs:407` | The one place a panic would unwind through C frames mid-`av_read_frame` |
| `id` on `BBoxData` | `backend/src/utils/models.py`, `backend/src/managers/bbox.py` | `ResultBBox` (`utils/registry_api.rs:47`) has no `serde(default)`. Drop the field and every POST response fails to deserialize → **`PostResultsCB` silently never fires** while bboxes still store and broadcast fine |
| `test_client.rs`'s leaking `on_results` | `client/src/bin/test_client.rs:63` | Deliberate, documented in-source — kept byte-faithful to the reference host. Copy a wrapper instead |

## Reference

Full detail: [`../docs/library.md`](../docs/library.md).

1. Module-by-module breakdown
2. C ABI reference
3. Callbacks
4. `client_video.h` *(the only source of truth — no header is generated)*
5. Memory ownership
6. Configuration constants
7. Decoding pipeline
8. Threading & the source state machine
9. The backend contract
10. Build system
11. The two wrappers
12. Gotchas & limitations

Feature-level overview: [`README.md`](README.md).
