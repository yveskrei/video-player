# Library Reference

Exhaustive technical reference for `library/`. For the short operational contract, see [`library/CLAUDE.md`](../library/CLAUDE.md). For the feature-level overview, see [`library/README.md`](../library/README.md).

**What it is:** a Rust `cdylib` — `libclient_video.so` — that a native host `dlopen`s. It pulls the backend's **progressive fMP4** stream over two plain HTTP GETs, decodes H.264/HEVC to tightly-packed **RGB24** with a statically-linked, decoder-only **FFmpeg n7.1.5**, hands each frame to a host callback, and posts the host's detections back to `POST /bboxes/`. It exposes **six** `extern "C"` symbols and **four** callback typedefs. There are **no `#[repr(C)]` structs** anywhere in the ABI.

The shipped `.so` is self-contained: FFmpeg is linked statically and its `av*` symbols are hidden, so the host installs nothing and cannot clash with its own FFmpeg.

> ⚠️ **This document replaces the reference for the previous 5-symbol ABI** (`InitMultipleSources`, `StopMultipleSources`, a 2-argument `PostResults`, and a flat `library/src/` layout). None of those symbols exist any more. See [§2.7](#27-differences-from-the-previous-abi).

---

## Table of contents

1. [Module-by-module breakdown](#1-module-by-module-breakdown)
2. [C ABI reference](#2-c-abi-reference)
3. [Callbacks](#3-callbacks)
4. [`client_video.h`](#4-client_videoh)
5. [Memory ownership](#5-memory-ownership)
6. [Configuration constants](#6-configuration-constants)
7. [Decoding pipeline](#7-decoding-pipeline)
8. [Threading & the source state machine](#8-threading--the-source-state-machine)
9. [The backend contract](#9-the-backend-contract)
10. [Build system](#10-build-system)
11. [The two wrappers](#11-the-two-wrappers)
12. [Gotchas & limitations](#12-gotchas--limitations)

---

## 1. Module-by-module breakdown

The component root is `library/`. The crate itself lives one level down in `library/client/` — that nesting is load-bearing (the build scripts, the Rust wrapper's `SO_PATH`, and the Python wrapper's `parents[3]` resolution all assume it).

```
library/
  client/                         the cdylib crate
    build.rs                      static-FFmpeg link wiring
    Cargo.toml  Cargo.lock
    src/
      lib.rs                      module tree + crate-wide #![allow(dead_code)]
      api.rs                      the six extern "C" exports
      state.rs                    process-global singleton, callback typedefs, trigger_* shims
      source.rs                   per-source supervisor / decoder / results workers
      mp4.rs                      media-engine façade (Decoder, RgbFrame, Metadata)
      mp4/ffmpeg.rs               the ONLY unsafe FFI module — RAII wrappers over ffmpeg-sys-next
      utils.rs                    C pointer helpers (read/alloc)
      utils/logger.rs             tracing JSON subscriber + runtime-reloadable filter
      utils/queue.rs              bounded drop-oldest MPSC queue
      utils/registry_api.rs       HTTP layer — the four backend endpoints
      bin/test_client.rs          smoke-test host driving the ABI in-process
  wrappers/python-wrapper/        ctypes example host
  wrappers/rust-wrapper/          libloading example host
  assets/client_workflow.svg      the diagram in library/README.md
  download_dependencies.sh        phase 1 (online)
  build_dependencies.sh           phase 2 (offline) — static FFmpeg
  build_library.sh                phase 3 (offline) — the .so
  dependencies.tar.gz             prebuilt static FFmpeg install tree (2.3 MB)
  dependencies_src.tar.gz         pinned FFmpeg n7.1.5 source snapshot (16 MB)
```

| File | Lines | Role |
|---|---|---|
| `client/src/mp4/ffmpeg.rs` | 643 | RAII wrappers over `ffmpeg-sys-next`: `Packet`, `Frame`, `SwsScaler`, `CodecContext`, `Demuxer`. The only `unsafe`-heavy module |
| `client/src/source.rs` | 448 | `SourceProcessor` — supervisor task, decoder thread, results task, `SourceStatus` FSM |
| `client/src/state.rs` | 286 | `State` singleton, the four callback typedefs, `RunMode`/`Settings`, `trigger_*` C shims |
| `client/src/api.rs` | 157 | The six `#[unsafe(no_mangle)] extern "C"` entry points |
| `client/src/utils/registry_api.rs` | 154 | `Registry` — async + blocking reqwest clients, endpoint URL construction, JSON models |
| `client/src/mp4.rs` | 148 | `Decoder::open` / `Decoder::run` — the resync-on-keyframe pump |
| `client/src/bin/test_client.rs` | 116 | `clap` CLI smoke-test host |
| `client/src/utils.rs` | 88 | `get_c_array`, `read_c_string`, `alloc_c_string`, `alloc_i64_array`, `alloc_ptr_array` |
| `client/src/utils/queue.rs` | 74 | `FixedSizeQueue` — sync drop-oldest `send`, async `recv` |
| `client/src/utils/logger.rs` | 59 | `Logger` — JSON `tracing` subscriber with a reloadable `EnvFilter` |
| `client/src/lib.rs` | 9 | `pub mod api / mp4 / source / state / utils`; `#![allow(dead_code)]` |
| `client/build.rs` | 44 | Native search paths + `--exclude-libs,ALL`; `rerun-if-env-changed` for `FFMPEG_DIR` and `B2B_URL` |

### `client/src/api.rs`

Six functions, all `#[unsafe(no_mangle)] pub extern "C"`. Every one starts by calling `get_state()` (`state.rs:281`) and returns early — silently — if the state has not been initialized. `SetCallbacks` is the exception: it calls `init_state()` itself.

Five of the six return `void`. Only `PostResults` returns a status (`0` success, `1` failure). **A no-op is indistinguishable from success for the other five.**

### `client/src/state.rs`

Declares the four callback function-pointer types (`:24`, `:32`, `:40`, `:42`) and `struct Callbacks` (`:50`) — a plain Rust struct holding four `extern "C" fn`s, never crossing the ABI.

`State` (`:97`) owns:

| Field | Purpose |
|---|---|
| `runtime: tokio::runtime::Runtime` | Multi-thread runtime built in `State::new` (`:117-120`). Every async worker in the process runs on it |
| `logger: Logger` | Keeps the reloadable filter handle alive for the process |
| `credentials: B2BCredentials` | The cooked-in `B2B_URL` |
| `registry_api: Registry` | Cloneable HTTP layer |
| `callbacks: Option<Callbacks>` | `None` until `SetCallbacks` |
| `settings: Settings` | `RunMode` only |
| `information_thread` | `JoinHandle` for the global 5 s registry poller |
| `sources_information: HashMap<u32, SourceInformation>` | Latest online/offline view from `GET /videos/` |
| `source_processors: RwLock<HashMap<u32, SourceProcessor>>` | **Inner-locked** so a source can be inserted/removed while only a *read* lock on `State` is held (`:199`, `:203`) |

`init_state()` (`:270`) is idempotent: it returns early if `STATE.get().is_some()`, and a concurrent caller that loses the `OnceLock::set` race silently drops its `State` (and its whole tokio runtime) without ever starting the poller.

`trigger_frames` / `trigger_metadata` / `trigger_status` / `trigger_results` (`:222`, `:228`, `:241`, `:247`) are the only places Rust data becomes C data. They no-op when `callbacks` is `None`.

### `client/src/source.rs`

One `SourceProcessor` per source id. Constructed by `InitSources`, dropped by `StopSources`. `SourceProcessor::new` (`:79`) spawns two tokio tasks; the supervisor spawns the OS decoder thread on demand. See [§8](#8-threading--the-source-state-machine).

### `client/src/mp4.rs` and `client/src/mp4/ffmpeg.rs`

`mp4.rs` is the façade: `Decoder::open(reader, running)` (`:68`) and `Decoder::run(&mut on_frame)` (`:95`). It never mentions FFmpeg types in its public surface — the host of this module hands in a `Box<dyn Read + Send>` and gets `&RgbFrame` back.

`mp4/ffmpeg.rs` is the entire FFI surface. Each wrapper owns exactly one resource and frees it in `Drop`; every fallible constructor frees precisely what it allocated before bailing (`Demuxer::open`, `:456-553`, is the elaborate case — it unwinds the AVIO buffer, the boxed reader, and the format context in the right order at each of four failure points).

### `client/src/utils/registry_api.rs`

`Registry` holds **two** reqwest clients (`:62-80`):

- `async_client` — 10 s total timeout. Used for `GET /videos/` and `POST /bboxes/`.
- `blocking_client` — **no total timeout** (the `prog.m4s` pull is endless), 10 s connect timeout, 10 s TCP keepalive to detect a dead peer.

### `client/src/bin/test_client.rs`

A `clap` binary (`--source_ids 1,2`) that links the crate as an `rlib` and calls `api::SetCallbacks` / `SetSettings(1)` / `InitSources` directly, then `StopSources` on `SIGINT`. Not linked into the shipped `.so`. Its `on_results` (`:63`) **deliberately leaks** — see [§12](#12-gotchas--limitations).

---

## 2. C ABI reference

### 2.1 `SetCallbacks`

```rust
pub unsafe extern "C" fn SetCallbacks(
    frames: SourceFramesCB,
    metadata: SourceMetadataCB,
    status: SourceStatusCB,
    results: PostResultsCB,
)
```
```c
void SetCallbacks(SourceFramesCB frames, SourceMetadataCB metadata,
                  SourceStatusCB status, PostResultsCB results);
```

`api.rs:17`. **This is also the library's initializer** — it calls `init_state()` (`api.rs:23`), which builds the tokio runtime, installs the `tracing` subscriber, builds the HTTP layer, and starts the global 5 s registry poller. **Nothing else works until it has been called**; every other export silently no-ops.

All four pointers must be non-null and must remain valid for the rest of the process — the library stores them by value and never checks them again.

Idempotent-ish: a second call re-registers the callbacks over the top; `init_state` short-circuits.

**There is no shutdown counterpart.** The runtime, the poller and the subscriber live until the process exits.

### 2.2 `SetSettings`

```rust
pub extern "C" fn SetSettings(run_mode: c_int)
```
```c
void SetSettings(int run_mode);
```

`api.rs:41`. `run_mode`: `0` = Regular (`info` level), `1` = Debug (`debug` level for this crate). Anything else maps to Regular (`state.rs:66-71`). Reloads the `tracing` `EnvFilter` in place (`state.rs:190-193`).

**Must be called after `SetCallbacks`** — it takes a `state.write()` lock and silently returns if the state does not yet exist.

### 2.3 `InitSources`

```rust
pub unsafe extern "C" fn InitSources(source_ids: *const c_uint, size: c_int)
```
```c
void InitSources(const unsigned int *source_ids, int size);
```

`api.rs:56`. Creates one `SourceProcessor` per id and inserts it into the registry. An id that is already initialized logs a warning and is skipped (`api.rs:67-73`). `source_ids` may be null if `size <= 0` — that is a silent no-op (`utils.rs:12-19`).

The ids are **copied** during the call; the host may free its array immediately afterwards.

Note: this only *starts the supervisor*. Decoding begins on the first 1 s poll tick that finds the source online.

### 2.4 `StopSources`

```rust
pub unsafe extern "C" fn StopSources(source_ids: *const c_uint, size: c_int)
```
```c
void StopSources(const unsigned int *source_ids, int size);
```

`api.rs:92`. Removes each `SourceProcessor` from the map and drops it. `Drop` (`source.rs:438`) clears the `decoder_running` flag, aborts the supervisor and results tasks, and fires `SourceStatusCB` with `Terminating`. Stopping an unknown id is a silent no-op.

**Asynchronous in effect:** it does not join the decoder OS thread. Frames may still arrive briefly after this returns — see [§12](#12-gotchas--limitations).

### 2.5 `PostResults`

```rust
pub unsafe extern "C" fn PostResults(
    source_id: c_uint,
    results_count: c_int,
    results_ids: *const *const c_char,
    result_body: *const c_char,
) -> c_int
```
```c
int PostResults(unsigned int source_id, int results_count,
                const char *const *results_ids, const char *result_body);
```

`api.rs:113`. The only export with a return value:

| Return | Meaning |
|---|---|
| `0` | Enqueued on the source's results worker |
| `1` | State not initialized, `result_body` null/not-UTF-8, **any** `results_ids[i]` null/not-UTF-8, or `source_id` is not an initialized source |

`result_body` is the **complete JSON body** the host built for `POST /bboxes/` — the library does not construct or validate it. `results_ids` is the host's per-detection id array, index-aligned with the `bboxes` array inside `result_body`; the library keeps it only to hand back through `PostResultsCB`.

Both the id strings and the body are **copied** synchronously into owned `String`s (`api.rs:123-134`); the host may free its buffers as soon as the call returns.

The call is non-blocking: it pushes onto a 256-slot drop-oldest queue (`source.rs:24`, `utils/queue.rs:44-52`) and returns. The HTTP POST happens later on the results worker.

### 2.6 `FreeCPtr`

```rust
pub unsafe extern "C" fn FreeCPtr(ptr: *const c_void)
```
```c
void FreeCPtr(const void *ptr);
```

`api.rs:152`. A null-tolerant `libc::free`. **Uniform** — the same function frees every kind of pointer the library hands out (id strings, `source_name`, the ids array, the timestamps array), because they all come from `libc::malloc` in `utils.rs`.

Do **not** pass it the frame buffer from `SourceFramesCB` — that one is borrowed.

### 2.7 Differences from the previous ABI

| Previous | Current |
|---|---|
| `InitMultipleSources` | **`InitSources`** |
| `StopMultipleSources` | **`StopSources`** |
| ids were `c_int` | ids are **`c_uint`** (and the array element type in the callbacks too) |
| `PostResults(source_id, body)` — 2 args | **`PostResults(source_id, results_count, results_ids, result_body)`** — 4 args, and the per-detection `id` round-trip is now mandatory |
| — | **`SetSettings`** is new |
| `SourceMetadataCB(source_id, width, height, fps, source_name)` | `source_name` is now the **SECOND** parameter: `(source_id, source_name, width, height, fps)` |
| `#[repr(C)]` structs crossed the boundary | **No `#[repr(C)]` structs at all** — everything is scalars, pointers and parallel arrays |

---

## 3. Callbacks

All four are `extern "C" fn` (not `Option<...>`), so **null is not permitted** — the library will call through whatever it was given.

### 3.1 `SourceFramesCB`

```c
typedef void (*SourceFramesCB)(unsigned int source_id, const uint8_t *frame,
                               int width, int height, long long pts);
```

`state.rs:24`, fired at `state.rs:225` from `source.rs:393`.

| Parameter | Notes |
|---|---|
| `source_id` | The backend `video_id` |
| `frame` | **BORROWED.** Tightly-packed RGB24, `width*height*3` bytes, stride `= width*3` (`align = 1`). Valid **only** for the duration of the call. Never `FreeCPtr` it |
| `width`, `height` | The decoded frame's dimensions (may differ from the metadata callback's if the stream changes resolution mid-flight) |
| `pts` | Presentation timestamp rescaled to **90 kHz** (`ffmpeg.rs:622`) |

**Thread:** the source's OS decoder thread, one per source. Runs **inline** — the decode loop is blocked until the callback returns.

### 3.2 `SourceMetadataCB`

```c
typedef void (*SourceMetadataCB)(unsigned int source_id, const char *source_name,
                                 int width, int height, int fps);
```

`state.rs:32`, fired at `state.rs:232` from `source.rs:381`.

⚠️ **`source_name` is the SECOND parameter, not the last.** This is the single easiest thing to get wrong when porting a host from the old ABI.

| Parameter | Notes |
|---|---|
| `source_name` | **OWNED** — `malloc`ed by the library, the host must `FreeCPtr` it. Comes from the registry poll's `VideoInfo.name`; empty string if the poll has not yet seen this id. May be **null** if the name contains an interior NUL or `malloc` fails (`utils.rs:40-58`) |
| `fps` | `f64` from the demuxer, **truncated to `int`** (`source.rs:387`). 29.97 fps reports as `29` |

**Fires exactly once per source, before the first frame** (`announced` at `source.rs:251` persists across reconnects within one decoder session).

**Thread:** the OS decoder thread, immediately before the first `SourceFramesCB`.

### 3.3 `SourceStatusCB`

```c
typedef void (*SourceStatusCB)(unsigned int source_id, int status);
```

`state.rs:40`, fired at `state.rs:244` from `source.rs:428`. Only fires on an actual **change** (an atomic `swap` compares old vs new).

`status` ∈ `{0 Idle, 1 Initializing, 2 Streaming, 3 Terminating}` — see [§8](#8-threading--the-source-state-machine).

**Thread:** whichever thread caused the transition — the supervisor tokio task, the OS decoder thread, **or the host's own thread** (the `Terminating` fired from `Drop` inside `StopSources` is re-entrant on the caller's stack).

Nothing is owned; nothing to free.

### 3.4 `PostResultsCB`

```c
typedef void (*PostResultsCB)(unsigned int source_id, int results_count,
                              const char *const *results_ids,
                              const long long *results_timestamps);
```

`state.rs:42`, fired at `state.rs:256` from `source.rs:225`.

Fires **only on a successful `POST /bboxes/`** whose response deserialized cleanly. A network failure, a non-2xx, or a response missing `id` logs at `debug` and fires nothing (`source.rs:204-214`).

| Parameter | Notes |
|---|---|
| `results_ids` | **OWNED, N + 1 pointers.** An array of `results_count` `char*`, each `malloc`ed. The array itself is also `malloc`ed |
| `results_timestamps` | **OWNED.** `malloc`ed array of `results_count` `long long` — the backend's `absolute_timestamp_ms` per bbox, index-aligned with `results_ids` |

The ids echoed here are the ones the host passed to `PostResults`, round-tripped through the backend.

**Thread:** a tokio worker thread on the library's runtime, up to `MAX_RESULTS_CONCURRENT = 10` concurrently.

---

## 4. `client_video.h`

**No header is generated** — there is no `cbindgen` step, no `include/` directory, and no `version-script.map` passed to the linker. This block is the ABI's only source of truth. It is written directly against `client/src/api.rs` and `client/src/state.rs`.

```c
/* client_video.h — C ABI for libclient_video.so
 *
 * Link:  -ldl        (dlopen)  or  -lclient_video
 * All six symbols are exported unmangled in PascalCase.
 */
#ifndef CLIENT_VIDEO_H
#define CLIENT_VIDEO_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---------------------------------------------------------------- status --
 * The values delivered to SourceStatusCB.
 */
#define CLIENT_VIDEO_STATUS_IDLE          0
#define CLIENT_VIDEO_STATUS_INITIALIZING  1
#define CLIENT_VIDEO_STATUS_STREAMING     2
#define CLIENT_VIDEO_STATUS_TERMINATING   3

/* --------------------------------------------------------------- run mode --
 * The values accepted by SetSettings. Anything else means REGULAR.
 */
#define CLIENT_VIDEO_RUN_MODE_REGULAR     0
#define CLIENT_VIDEO_RUN_MODE_DEBUG       1

/* ------------------------------------------------------------- callbacks --
 * Registered once, at SetCallbacks. All four must be non-NULL and must stay
 * valid for the lifetime of the process. None of them may throw / unwind.
 */

/* Fires on the source's decoder thread, inline: the decode loop is blocked
 * until you return.
 *   frame  BORROWED, valid only during this call. Tightly-packed RGB24,
 *          width*height*3 bytes, stride = width*3. Do NOT FreeCPtr it.
 *   pts    presentation timestamp in 90 kHz units.
 */
typedef void (*SourceFramesCB)(unsigned int source_id,
                               const uint8_t *frame,
                               int width,
                               int height,
                               long long pts);

/* Fires once per source, on the decoder thread, just before the first frame.
 * NOTE the parameter order: source_name is SECOND.
 *   source_name  OWNED — free it with FreeCPtr. May be NULL.
 *   fps          truncated to an integer.
 */
typedef void (*SourceMetadataCB)(unsigned int source_id,
                                 const char *source_name,
                                 int width,
                                 int height,
                                 int fps);

/* Fires on every status change only. May arrive on the supervisor thread, the
 * decoder thread, or re-entrantly on YOUR thread from inside StopSources.
 * Nothing is owned.
 */
typedef void (*SourceStatusCB)(unsigned int source_id, int status);

/* Fires on a library worker thread after a successful POST /bboxes/.
 *   results_ids         OWNED: results_count char* strings AND the array.
 *   results_timestamps  OWNED: array of results_count int64 (ms since epoch).
 * You must perform results_count + 2 FreeCPtr calls, and you must copy the
 * string values out BEFORE freeing the array that holds them.
 */
typedef void (*PostResultsCB)(unsigned int source_id,
                              int results_count,
                              const char *const *results_ids,
                              const long long *results_timestamps);

/* ---------------------------------------------------------------- exports --
 */

/* Initializes the library AND registers the callbacks. Call this FIRST — every
 * other function silently no-ops until it has run. There is no shutdown call. */
void SetCallbacks(SourceFramesCB frames,
                  SourceMetadataCB metadata,
                  SourceStatusCB status,
                  PostResultsCB results);

/* Log verbosity. Call after SetCallbacks. */
void SetSettings(int run_mode);

/* Start supervising `size` sources (backend video ids). The array is copied.
 * A NULL array with size <= 0 is a no-op. */
void InitSources(const unsigned int *source_ids, int size);

/* Stop supervising `size` sources. Does not block on the decoder thread —
 * a few frames may still arrive after this returns. */
void StopSources(const unsigned int *source_ids, int size);

/* Enqueue one detection set for POST /bboxes/.
 *   results_ids   results_count NUL-terminated strings, index-aligned with the
 *                 "bboxes" array inside result_body.
 *   result_body   the complete JSON request body (see the backend contract).
 * Both are copied synchronously; free your own buffers after the call.
 * Returns 0 on success, 1 on failure. Non-blocking. */
int PostResults(unsigned int source_id,
                int results_count,
                const char *const *results_ids,
                const char *result_body);

/* Release any OWNED pointer this library handed you. NULL-tolerant.
 * This is a plain free() — one function for every owned pointer type. */
void FreeCPtr(const void *ptr);

#ifdef __cplusplus
}
#endif

#endif /* CLIENT_VIDEO_H */
```

`long long` is used rather than `int64_t` because the Rust side declares `c_longlong`; on every LP64/LLP64 target the library supports these are the same 64-bit type.

---

## 5. Memory ownership

Everything the library allocates for the host comes from `libc::malloc` in `client/src/utils.rs` (`alloc_c_string` `:40`, `alloc_i64_array` `:61`, `alloc_ptr_array` `:76`) and is released by the host with `FreeCPtr` — a plain `libc::free` (`api.rs:156`).

| Pointer | Direction | Ownership | Action |
|---|---|---|---|
| `SourceFramesCB.frame` | lib → host | **BORROWED** | Copy what you need during the call. **Never free.** It points into a `Vec<u8>` that is dropped as soon as the callback returns |
| `SourceMetadataCB.source_name` | lib → host | **OWNED** | Read, then **one** `FreeCPtr` |
| `PostResultsCB.results_ids[i]` | lib → host | **OWNED** | **N** `FreeCPtr` calls |
| `PostResultsCB.results_ids` | lib → host | **OWNED** | **One** `FreeCPtr` on the array — *after* the elements |
| `PostResultsCB.results_timestamps` | lib → host | **OWNED** | **One** `FreeCPtr` |
| `PostResults.results_ids` / `.result_body` | host → lib | **host-owned** | Copied synchronously; free your own after the call returns |
| `InitSources` / `StopSources` id arrays | host → lib | **host-owned** | Copied synchronously |

### The N + 2 rule

`PostResultsCB` requires exactly **`results_count` + 2** frees per invocation:

```
N frees   — one per results_ids[i]
1 free    — the results_ids array itself
1 free    — the results_timestamps array
```

**Order matters.** `results_ids[i]` lives *inside* the array you are about to free, so copy the string values out first, then free the elements, then free the array. Freeing the array first and reading `results_ids[i]` afterwards is a use-after-free.

Both wrappers implement the correct sequence: `wrappers/python-wrapper/video_library/library.py:107-118` and `wrappers/rust-wrapper/src/utils.rs:88-91` (whose `get_c_array` explicitly copies before releasing, with a comment saying why).

### Panics and unwinding

`panic = "unwind"` is set deliberately (`client/Cargo.toml:33`). Only the AVIO read callback is guarded with `catch_unwind` (`mp4/ffmpeg.rs:407`). **None of the six exports is guarded** — a panic inside one would unwind across the C boundary, which is undefined behaviour. See [§12](#12-gotchas--limitations).

---

## 6. Configuration constants

There are **no runtime environment variables** except `RUST_LOG`. Everything else is a compile-time `env!` or a module constant.

| Name | Value | Where | Notes |
|---|---|---|---|
| `B2B_URL` | *(required at compile time)* | `state.rs:21` | `env!("B2B_URL")` — **the build fails** if it is unset. Must be the **bare origin**, e.g. `http://127.0.0.1:8702` |
| `CLIENT_TIMEOUT` | `10 s` | `registry_api.rs:8` | Total timeout on the async client; connect timeout + TCP keepalive on the blocking client |
| *(metadata poll)* | `5 s` | `state.rs:152` | Global `GET /videos/` tick that maintains `sources_information` |
| `REGISTRY_POLL` | `1 s` | `source.rs:21` | Per-source supervisor tick — how fast an online/offline change is acted on |
| `RETRY_DELAY` | `1 s` | `source.rs:22` | Wait between failed stream attempts, slept in 100 ms steps so a stop is honoured promptly (`source.rs:296`) |
| `MAX_STREAM_RETRIES` | `5` | `source.rs:23` | Consecutive *failed* attempts before the decoder gives up → `Terminating`. Reset to 0 by any session that decoded ≥1 frame |
| `RESULTS_QUEUE_CAPACITY` | `256` | `source.rs:24` | Per-source results queue. **Drop-oldest** at capacity — a backlog silently discards the *oldest* detection sets |
| `MAX_RESULTS_CONCURRENT` | `10` | `source.rs:25` | In-flight `POST /bboxes/` per source, gated by a tokio `Semaphore` |
| `Demuxer::AVIO_BUF` | `64 KiB` | `mp4/ffmpeg.rs:451` | libavformat's custom-AVIO scratch buffer |
| *(RGB alignment)* | `1` | `mp4/ffmpeg.rs:206`, `:234` | `av_image_get_buffer_size(..., 1)` / `av_image_fill_arrays(..., 1)` → tightly packed, stride = `width*3` |
| *(PTS timebase)* | `90 000` | `mp4/ffmpeg.rs:622` | `av_rescale_q(pts, stream_tb, 1/90000)`. **Must stay in lockstep** with `backend/src/managers/bbox.py` `STANDARD_TIME_BASE` and the frontend's five `PTS_TIMEBASE` declarations |
| `RUST_LOG` | *(optional)* | `utils/logger.rs:51` | Appended **after** the run-mode directives, so it wins on any target it names |

`B2B_URL` is baked in with `env!`, so **changing the backend address requires a rebuild.** `build.rs:43` registers `cargo:rerun-if-env-changed=B2B_URL` so cargo notices.

---

## 7. Decoding pipeline

### 7.1 There is no manifest

The library never touches DASH. It joins a source with exactly **two plain HTTP GETs** (`registry_api.rs:113-114`, issued at `source.rs:321-349`):

```
GET {B2B_URL}/progressive/{id}/progressive.mp4   → the init segment (ftyp + moov), read to completion
GET {B2B_URL}/progressive/{id}/prog.m4s          → the endless media fragment stream, left open
```

Both go through the **blocking** reqwest client, on the OS decoder thread.

### 7.2 Init ⧺ media, into a custom AVIO

```rust
let reader: Box<dyn Read + Send> =
    Box::new(std::io::Cursor::new(init.to_vec()).chain(media));
```
`source.rs:351`. A `Cursor` over the fully-buffered init segment chained onto the still-streaming media response — so libavformat sees one continuous byte stream that happens to begin with a complete `moov`.

That reader is boxed into a `ReaderState` (`mp4/ffmpeg.rs:398`) and handed to `avio_alloc_context` as the `opaque` (`:466-474`) with a 64 KiB buffer. `AVFMT_FLAG_CUSTOM_IO` is set and `avformat_open_input` is called with a **null filename and null input format** (`:491-496`), so libavformat probes the bytes and selects its `mov` demuxer.

**FFmpeg performs no I/O of its own.** `build_dependencies.sh:77` passes `--disable-network`, and no protocol handlers are enabled. All networking belongs to reqwest.

### 7.3 The read callback

`read_packet` (`mp4/ffmpeg.rs:406`) drains the Rust reader into libavformat's buffer. It returns `AVERROR_EOF` on end-of-stream, on any read error, **and as soon as the `running` flag clears** — that is how `StopSources` unwinds a blocked `av_read_frame` cleanly rather than killing a thread mid-syscall.

It is the **only** callback in the crate wrapped in `catch_unwind` (`:407`), because a panic here would unwind through C frames.

### 7.4 Decoder setup

`CodecContext::open(demux.codecpar())` (`mp4/ffmpeg.rs:285`) copies the demuxer's `AVCodecParameters` — including the `avcC` / `hvcC` extradata — straight into a fresh context. **libavcodec therefore decodes native length-prefixed AVCC; there is no Annex-B bitstream filter anywhere in the crate.**

`av_find_best_stream` picks the video stream (`:523`); anything other than `AV_CODEC_ID_H264` or `AV_CODEC_ID_HEVC` bails with "unsupported video codec id" (`:536-540`). Frame rate comes from `av_guess_frame_rate`, falling back to `avg_frame_rate`, then `0.0` (`:541-542`).

### 7.5 The pump and the resync loop

`Decoder::run` (`mp4.rs:95`) — 24/7 resilience is the design goal, so **no single bad frame ever tears the session down**:

```
loop:
  read packet
    Eof   -> break
    Skip  -> continue          (not the video stream)
  if resync:
      packet not a keyframe -> continue
      resync = false; codec.flush()
  send(packet)
      Err -> resync = true; flush(); continue
  loop:
      receive(frame)
        Got:
            frame.corrupt() (decode_error_flags != 0) -> resync = true; continue
            frame_to_rgb(frame)  -> on_frame(&RgbFrame { data, w, h, pts_90k })
        Again | Eof -> break
        Err -> resync = true; flush(); break
```

`resync` starts `true` (`mp4.rs:84`), so a session that joins mid-stream discards everything until the first IDR — which is exactly right for a fragment stream where fragments do not reliably start on a keyframe.

### 7.6 Scaling to RGB24

`frame_to_rgb` (`mp4/ffmpeg.rs:348`) lazily builds an `SwsScaler` and rebuilds it if the width, height or source pixel format changes. Destination is always `AV_PIX_FMT_RGB24` at the **same** dimensions (no resize), `SWS_BILINEAR`, alignment `1`.

Each call allocates a **fresh `Vec<u8>`** of `av_image_get_buffer_size(RGB24, w, h, 1)` bytes (`:222`). That is one allocation plus one full-resolution colour conversion **per frame, per source** — the library's dominant cost. The `Vec` is dropped the moment `on_frame` returns, which is why the frame pointer is borrowed.

### 7.7 Timestamps

```rust
av_rescale_q(pts, stream_time_base, AVRational { num: 1, den: 90_000 })
```
`mp4/ffmpeg.rs:622`. The stream time base is read once at open (`:550`). The resulting 90 kHz value is what reaches `SourceFramesCB`, what the host must put in each bbox's `pts`, and what the backend converts to `absolute_timestamp_ms`.

---

## 8. Threading & the source state machine

### 8.1 Thread inventory

| Thread / task | Count | Started by | Job |
|---|---|---|---|
| tokio multi-thread runtime workers | 1 pool | `State::new` (`state.rs:117`) | Hosts every async task below |
| Registry poller (tokio task) | **1, global** | `State::run` (`state.rs:148`) | `GET /videos/` every 5 s → `sources_information` |
| Supervisor (tokio task) | 1 **per source** | `SourceProcessor::new` (`source.rs:87`) | 1 s tick; starts/stops the decoder thread, drives the status FSM |
| Decoder (**OS thread**, `std::thread::spawn`) | ≤1 per source | supervisor (`source.rs:138`) | Blocking HTTP pull + demux + decode + `SourceFramesCB` |
| Results worker (tokio task) | 1 per source | `SourceProcessor::new` (`source.rs:99`) | Drains the queue, POSTs, fires `PostResultsCB` |
| Per-POST task (tokio task) | ≤10 per source | `run_results` (`source.rs:189`) | One in-flight `POST /bboxes/` |

The decoder is an **OS thread, not a tokio task**, precisely because it is entirely blocking: `blocking_client` reads, `av_read_frame`, `sws_scale`, and an inline host callback of unknown duration.

### 8.2 The `SourceStatus` FSM

```
                       InitSources
                            │
                            ▼
   ┌──────────────► Initializing (1) ◄────────────────┐
   │                        │                          │
   │   supervisor tick:     │                          │ supervisor tick:
   │   online && no decoder │                          │ !online && urls == None
   │   → spawn decoder      │                          │ (never streamed)
   │                        ▼                          │
   │                  Streaming (2) ───────────────────┘
   │                        │
   │      • !online && urls == Some  (supervisor)
   │      • url fetch failed          (decoder, source.rs:243)
   │      • MAX_STREAM_RETRIES hit    (decoder, source.rs:290)
   │      • StopSources → Drop        (host thread, source.rs:446)
   │                        ▼
   └───────────────  Terminating (3)

   Idle (0)  — the initial atomic value only (source.rs:81), so the
               supervisor's very first set_status always fires. Never
               re-entered afterwards.
```

Transitions are written with an atomic `swap`; `SourceStatusCB` fires **only** when the value actually changed (`source.rs:429-434`).

`Terminating` is **not** terminal in the supervisor's eyes — if the source comes back online and the supervisor task is still alive, it will spawn a fresh decoder and go back to `Initializing` → `Streaming`. `Terminating` is genuinely final only when it came from `Drop`.

### 8.3 Reconnect and retry

Inside one decoder thread (`run_decoder`, `source.rs:230`):

- Each iteration of the `while decoder_running` loop is one **session**: fetch init, open `prog.m4s`, open libavformat, pump until EOF.
- A session that decoded ≥1 frame returns `Progressed` and **resets the retry counter to 0** (`source.rs:262`).
- A session that could not open, or decoded nothing, returns `Failed` and burns one retry.
- 5 consecutive failures → `Terminating`, thread exits. The supervisor will try again on a later tick if the source is still online.
- `announced` (`source.rs:251`) is **outside** the loop, so `SourceMetadataCB` fires once per decoder thread, not once per reconnect.

### 8.4 Results flow

```
host thread ──PostResults──► FixedSizeQueue (256, drop-oldest)
                                      │
                            results worker task (1/source)
                                      │  urls == None ? drop the set, log a warning
                                      │  else acquire 1 of 10 semaphore permits
                                      ▼
                            POST /bboxes/  (async client, 10 s timeout)
                                      │  non-2xx / network error / bad JSON → debug log, nothing fires
                                      ▼
                            PostResultsCB(source_id, N, ids, timestamps)
```

A result set enqueued while the stream is not open (`urls` is `None`) is **dropped**, not buffered (`source.rs:178-184`) — the backend rejects bboxes for a non-streaming video with a 400 anyway.

---

## 9. The backend contract

Exactly **four** endpoints, all relative to `B2B_URL`. Constructed at `registry_api.rs:87` and `:110-116`.

### 9.1 `GET {base}/videos/` — the 5 s registry poll

`registry_api.rs:86`. Async client. Response is the backend's `list[VideoInfo]`; the library deserializes only three fields and ignores the rest:

```json
[
  {
    "id": 1,
    "name": "traffic-cam.mp4",
    "stream_status": "streaming"
  }
]
```

| Field | Rust type | Use |
|---|---|---|
| `id` | `u32` | The source id — same integer the host passes to `InitSources` |
| `name` | `String` | Delivered as `source_name` in `SourceMetadataCB` |
| `stream_status` | `String` | **`online = (stream_status == "streaming")`** (`registry_api.rs:105`). Any other value — `stopped`, `initializing`, `terminating` — counts as offline |

A failed poll logs at `debug` and **leaves the previous map intact** (`state.rs:162-164`), so a transient backend blip does not tear down live decoders.

The trailing slash is required — FastAPI 307-redirects `/videos`.

### 9.2 `GET {base}/progressive/{source_id}/progressive.mp4` — the init segment

Blocking client. Read to completion into memory (`source.rs:321-335`). This is the backend's cached `ftyp` + `moov`, written once per stream from FFmpeg's stdout.

### 9.3 `GET {base}/progressive/{source_id}/prog.m4s` — the media stream

Blocking client, **no total timeout**, left open indefinitely (`source.rs:336-349`). The backend blocks briefly waiting for `prog_init_ready`, then streams live 200 ms fragments from its `ProgressiveHub` fan-out. Fan-out is lossy per consumer by design.

### 9.4 `POST {base}/bboxes/` — the detections

`registry_api.rs:122`. Async client, `Content-Type: application/json`. The body is **verbatim whatever the host handed to `PostResults`** — the library neither builds nor validates it.

**Request** (the shape both wrappers produce — `library.py:186-197`, `video_library.rs:255-273`):

```json
{
  "stream_id": 1,
  "bboxes": [
    {
      "id": "3f2b1c8e-9a4d-4f77-b0e1-6c2a5d8e7f10",
      "pts": 5400000,
      "top_left_corner": 12340,
      "bottom_right_corner": 56780,
      "class_name": "person",
      "confidence": 0.91
    }
  ]
}
```

| Field | Notes |
|---|---|
| `stream_id` | The source id. See the naming quirk below |
| `id` | The host's per-detection id (uuid4 in both wrappers). **Must be present** — see [§12](#12-gotchas--limitations) |
| `pts` | The 90 kHz timestamp from `SourceFramesCB`, unmodified |
| `top_left_corner` / `bottom_right_corner` | ⚠️ **Flattened 1-D pixel indices**, `idx = y * width + x` — **not** `(x, y)` pairs. Decode with `y = idx // width`, `x = idx % width`. Both wrappers derive them in `corners_coordinates` (`types.py:69-74`, `utils.rs:65-73`) |
| `confidence` | The **only** field the backend really validates: `ge=0, le=1`, out of range → **422** |

**Response** (`managers/bbox.py:105-109`), of which the library deserializes only `bboxes[].id` and `bboxes[].absolute_timestamp_ms`:

```json
{
  "source_id": 1,
  "stream_start_time_ms": 1755168000000,
  "bboxes": [
    {
      "id": "3f2b1c8e-9a4d-4f77-b0e1-6c2a5d8e7f10",
      "pts": 5400000,
      "absolute_timestamp_ms": 1755168060000,
      "top_left_corner": 12340,
      "bottom_right_corner": 56780,
      "class_name": "person",
      "confidence": 0.91
    }
  ]
}
```

`absolute_timestamp_ms = stream_start_time_ms + pts / 90000 * 1000` (`managers/bbox.py:29-30`, `:73`). That value is what reaches the host as `results_timestamps[i]`.

Error responses the host will see as a silent nothing (debug log only, no callback): `404` unknown video, `400` video not currently streaming, `422` confidence out of range.

### 9.5 The three-name quirk

**One integer, three names.** Do not let this cost you an afternoon:

| Name | Where |
|---|---|
| `source_id` | The library's FFI argument (`InitSources`, `PostResults`, every callback) and the `POST /bboxes/` **response** field |
| `stream_id` | The `POST /bboxes/` **request** body field (`backend/src/utils/models.py`, `BBoxCreate`) |
| `video_id` | The backend's internal name everywhere else, and the `GET /videos/` `id` field |

### 9.6 What the library never touches

- **DASH.** No `manifest.mpd`, no segment templates. That path belongs exclusively to the frontend.
- **The WebSocket.** The library does not connect to `/ws` and never receives `bbox_update`.
- `POST /streams/start` / `stop`, `POST /videos/upload`, `DELETE /videos/{id}`, `GET /bboxes/{id}`, `POST /bboxes/cleanup`. The library is a pure consumer plus one producer endpoint.

---

## 10. Build system

Three scripts, run in order. Only phase 1 needs network.

### Phase 1 — `download_dependencies.sh` (ONLINE)

Shallow-clones **FFmpeg `n7.1.5`** (`download_dependencies.sh:33`), strips the `.git` dir, and packs `dependencies_src.tar.gz`. Exits immediately if that archive already exists — and it is committed to this repo, so this phase is normally skipped entirely.

The tag is pinned so the C API matches the `ffmpeg-sys-next 7.x` bindings the crate links against.

### Phase 2 — `build_dependencies.sh` (OFFLINE)

Hard-fails without `nasm` (`:34-38`). Extracts `dependencies_src.tar.gz`, `make distclean`s, then configures a **static, decode-only, LGPL-clean** FFmpeg:

```
./configure
  --prefix=dependencies/ffmpeg
  --pkg-config-flags=--static
  --extra-cflags=-fPIC -O3          --extra-cxxflags=-fPIC -O3
  --extra-libs=-lpthread -lm
  --disable-shared    --enable-static    --enable-pic
  --disable-doc       --disable-programs --disable-debug
  --disable-autodetect
  --disable-network                 # FFmpeg does NO I/O; reqwest owns the network
  --disable-everything
  --enable-decoder=h264   --enable-decoder=hevc
  --enable-parser=h264    --enable-parser=hevc
  --enable-demuxer=mov
  --enable-swscale        --enable-swresample
  --enable-avformat       --enable-avcodec       --enable-avutil
```

**No encoders, no muxers, no protocols, no x264 — therefore no `--enable-gpl`.** The build is LGPL and the resulting `.so` is distributable without GPL obligations.

Output is `dependencies.tar.gz` (~2.3 MB); the extracted source and build trees are deleted. That tarball is committed here too, so phase 2 is also normally skippable.

### Phase 3 — `build_library.sh` (OFFLINE)

1. **Hard-fails if `B2B_URL` is unset** (`:27-32`). ⚠️ It must be the bare origin — `http://127.0.0.1:8702`, **no `/video` prefix** — or every request hits the backend's catch-all 404.
2. Extracts `dependencies.tar.gz` if `dependencies/ffmpeg` is absent.
3. Exports the discovery variables `ffmpeg-sys-next` needs: `FFMPEG_DIR`, `PKG_CONFIG_PATH`, `PKG_CONFIG_STATIC=1`, `FFMPEG_INCLUDE_DIR`, `FFMPEG_LIB_DIR`, `BINDGEN_EXTRA_CLANG_ARGS`.
4. **Pins libclang.** `LIBCLANG_PATH` defaults to `/usr/lib64/llvm19/lib` and the script hard-fails if `libclang.so.19.1` is not there (`:63-68`).
5. Exports `B2B_URL` so `env!` sees it.
6. Sets `RUSTFLAGS` (below) and runs `cd client && cargo build --release`.
7. `rm -rf dependencies/` — the tarball stays the portable artifact.

Output: `library/client/target/release/libclient_video.so`.

#### The libclang 18–19 constraint

`ffmpeg-sys-next 7.1` pins **bindgen 0.70**, which mis-generates bindings against **libclang ≥ 20**: fully-defined structs come out as 1-byte forward declarations while keeping their real size assertions, so the build dies on **`E0080`** const-eval overflows. A contemporaneous libclang is mandatory. On this machine `/usr/lib64/llvm19/lib/libclang.so.19.1` exists, which is exactly the default. Fedora: `sudo dnf install clang19-libs`.

#### The `RUSTFLAGS` link line

`build_library.sh:77-90`. The `-Bstatic` / `-Bdynamic` split is the whole point:

```
-C link-arg=-L$FFMPEG_DIR/lib
-C link-arg=-Wl,-Bstatic         # ── everything below comes from the .a files ──
-C link-arg=-lavformat
-C link-arg=-lavcodec
-C link-arg=-lswscale
-C link-arg=-lswresample
-C link-arg=-lavutil
-C link-arg=-Wl,-Bdynamic        # ── everything below comes from the host system ──
-C link-arg=-lstdc++
-C link-arg=-lm
-C link-arg=-lz
-C link-arg=-lpthread
-C link-arg=-ldl
-C link-arg=-lc
```

Link order matters — `-lavformat` must precede `-lavcodec` must precede `-lavutil`. Forgetting `-Bdynamic` would attempt to statically link glibc and fail.

#### `build.rs` and symbol hiding

`client/build.rs:21-38` branches on `FFMPEG_DIR`:

- **Set** (production): registers `-L{dir}/lib` and `-L{dir}/lib64` search paths and adds `-Wl,--exclude-libs,ALL`, which hides the statically-linked FFmpeg `av*` archive symbols so the `.so` cannot clash with a host that loads its own FFmpeg.
- **Unset** (developer): emits a `cargo:warning` and links against the system FFmpeg that `ffmpeg-sys-next` finds via pkg-config. No static wiring, no symbol hiding — fine for `cargo check`, not shippable.

⚠️ **Do not add a manual `--version-script`.** rustc already generates one for a `cdylib` that exports only the `#[no_mangle] pub extern "C"` functions in `api.rs`; a second script makes the linker fail with *"anonymous version tag cannot be combined with other version tags"*. `build.rs:6-13` documents this. `--exclude-libs,ALL` is additive and is all that is needed.

#### Verifying a build

```bash
nm -D client/target/release/libclient_video.so | grep ' T '
# expected, exactly:  FreeCPtr  InitSources  PostResults  SetCallbacks  SetSettings  StopSources

nm -D client/target/release/libclient_video.so | grep -c ' av'
# expected: 0   (FFmpeg symbols fully hidden)
```

---

## 11. The two wrappers

Both live under `library/wrappers/`, are reference hosts rather than shipped products, and implement the same five-step flow: load → `SetCallbacks` + `SetSettings` → `InitSources` → handle frames → `PostResults`.

### 11.1 `python-wrapper` — ctypes

| File | Role |
|---|---|
| `video_library/library.py` | The ctypes binding, the singleton, the four trampolines |
| `video_library/types.py` | `RawFrame`, `ResultBBOX`, `RunMode`, `SourceStatus`, `corners_coordinates` |
| `video_library/__init__.py` | Public re-exports — no ctypes type leaks to the caller |
| `main.py` | Runnable example: post one bbox per frame |

Load it with `uv sync && uv run python main.py`.

**`CFUNCTYPE`, not `PYFUNCTYPE`** (`library.py:38-41`). `CFUNCTYPE` callbacks acquire the GIL before entering Python, so the decoder thread — a foreign, non-Python OS thread — is safe to call in. Every trampoline is additionally wrapped in `try/except` with `logger.exception`, because **a Python exception must never propagate into C**.

**`c_void_p`, not `c_char_p`, for owned pointers** (`library.py:39`, `:41`). This is load-bearing: ctypes auto-converts a `c_char_p` argument into a Python `bytes` object and **loses the address**, which is exactly the address `FreeCPtr` needs. Declaring them `c_void_p` and casting explicitly (`library.py:112`, `:228`) preserves it.

**numpy exists solely for the zero-copy frame view.** `np.ctypeslib.as_array(frame_ptr, shape=(height, width, 3))` (`library.py:68`) wraps the borrowed buffer with no copy; `arr.setflags(write=False)` marks it read-only. The array is invalid the instant the handler returns — `frame.data.copy()` to keep the pixels.

**Callbacks must be retained.** `state.callbacks` (`library.py:153-158`) holds the four `CFUNCTYPE` instances for the process lifetime. The `.so` stores only their raw pointers; if Python GC'd them, the very first callback would dereference freed memory and segfault.

**The handler runs INLINE on the decoder thread.** There is no thread pool. Heavy work in `on_frame` stalls decode for that source, and across sources the GIL serializes handlers anyway.

`_default_so_path` (`library.py:54-57`) resolves `Path(__file__).resolve().parents[3] / "client/target/release/libclient_video.so"` — package-relative, not CWD-relative. **This is why the `client/` nesting must not be flattened.**

### 11.2 `rust-wrapper` — libloading

| File | Role |
|---|---|
| `src/video_library.rs` | The `libloading` binding, the singleton, the four `extern "C"` trampolines |
| `src/utils.rs` | `RawFrame`, `ResultBBOX`, `Ownership`, the C pointer readers |
| `src/main.rs` | Runnable example |

**Symbols are resolved by byte-string name at every call** (`video_library.rs:177`, `:200`, `:223`, `:242`, `:289`, `:409`) rather than cached once. Simple and safe, but it is a `dlsym` per call — including one per `PostResults`, i.e. potentially per frame.

**`SO_PATH` is CWD-relative**: `"../../client/target/release/libclient_video.so"` (`video_library.rs:21`). Run the example from `library/wrappers/rust-wrapper/`. Same nesting dependency as the Python wrapper.

**The frames trampoline copies, then defers** (`video_library.rs:305-350`) — the opposite trade-off from Python:

1. `get_c_array(frame, w*h*3, Ownership::Borrowed)` copies the borrowed buffer into an owned `Vec<u8>`.
2. The user's handler is dispatched via `runtime.spawn_blocking`.

So a slow handler **cannot stall decode**, at the cost of one full frame copy per frame on top of the library's own. The host must keep the tokio runtime alive for the whole process (`main.rs:15-18`).

`Ownership::{Borrowed, Owned}` (`utils.rs:15`) makes the free-or-don't decision explicit at every read site, and `get_c_array` copies before releasing so an array of pointers outlives its array (`utils.rs:88-91`).

---

## 12. Gotchas & limitations

### Correctness / known gaps

- **No panic guards on the six exports.** `panic = "unwind"` is set (`Cargo.toml:33`) and only the AVIO read callback is `catch_unwind`-guarded (`mp4/ffmpeg.rs:407`). A panic inside `SetCallbacks`, `InitSources`, `PostResults`, … would unwind across the C boundary — **undefined behaviour**. This is the largest known correctness gap. `panic = "unwind"` is nonetheless deliberate: `catch_unwind` guards on the entries cannot work under `panic = "abort"`, so the setting is what makes the eventual fix possible. Do not change it to `"abort"`.
- **Re-entrant `RwLock` read while a host callback runs.** `trigger_frames` is invoked as `state.read().trigger_frames(...)` (`source.rs:393`), so the global `State` read lock is **held for the whole duration of the host's frame callback**. If that callback calls `PostResults`, the library takes a *second* read lock on the same thread (`api.rs:140`). `parking_lot::RwLock` is task-fair: if the 5 s registry poller's `state.write()` (`state.rs:160`) queues between the two, the recursive read blocks and the process deadlocks. Both wrappers demonstrate exactly this pattern (post detections from inside the frame handler), so the window is real, if narrow. `SetSettings` from a callback is worse — it takes a `write()` and deadlocks unconditionally.
- **`StopSources` does not join the decoder thread.** `Drop` (`source.rs:438-448`) clears `decoder_running` and aborts the two tokio tasks; aborting the supervisor drops its `JoinHandle` for the decoder thread, **detaching** it. The decoder notices the flag only at its next AVIO read or loop check, so `SourceFramesCB` can still fire after `StopSources` returns. A host that frees resources immediately after `StopSources` will race. `test_client.rs:105` papers over this with a 300 ms sleep.
- **`test_client.rs`'s `on_results` leaks** `results_count + 2` pointers per call (`:63-76`). Deliberate and documented in-source — it is a smoke-test binary kept byte-faithful to the reference host. Do not copy it; copy a wrapper.
- **PascalCase, unprefixed symbols.** `SetCallbacks`, `InitSources`, `PostResults`, `FreeCPtr`, `SetSettings`, `StopSources` carry no `cv_`/`client_video_` namespace. In a large host with other plugins loaded into the same global symbol namespace, a collision is plausible.
- **Process-global singleton, no shutdown.** One `OnceLock<Arc<RwLock<State>>>` (`state.rs:265`). A second `SetCallbacks` re-registers over the top. There is no way to tear the runtime down, stop the 5 s poller, or unload the library cleanly — `dlclose` on a `.so` with live threads is not safe.
- **Five of six functions return `void` and silently no-op on failure.** Calling `InitSources` before `SetCallbacks` looks identical to success. There is no error channel, no last-error getter, and no way to ask which sources are running — the only feedback is `SourceStatusCB` and the log stream.
- **`init_state` swallows the losing race.** Two threads calling `SetCallbacks` concurrently: the loser builds a full `State` — including an entire multi-thread tokio runtime — and drops it without ever starting its poller (`state.rs:275-278`). Wasteful but not incorrect.
- **`#![allow(dead_code)]` is crate-wide** (`lib.rs:3`). Genuinely unused code will not be flagged. `State::callbacks()`, `State::settings()`, `SourceProcessor::status()` and `Registry::async_client()` are currently unreachable.
- **`fps` is truncated to an integer** in `SourceMetadataCB` (`source.rs:387`). 29.97 fps is reported as `29`.
- **Metadata `source_name` can be empty.** If the 5 s registry poll has not yet populated `sources_information` when the first frame decodes, the name is `""` (`source.rs:375`).

### The `id` round-trip — a hard requirement

`ResultBBox` (`registry_api.rs:47-51`) declares:

```rust
struct ResultBBox {
    id: String,
    absolute_timestamp_ms: i64,
}
```

with **no `#[serde(default)]`** and a non-`Option` `String`. Therefore:

- If the host omits `id` from a bbox in the request body, the backend echoes `"id": null` and serde fails with a type error.
- If the backend did not carry `id` at all, serde fails with `missing field 'id'`.

Either way the whole `POST /bboxes/` result is discarded at `source.rs:206-213` with only a `debug`-level log, and **`PostResultsCB` never fires** — while the bboxes were in fact stored and broadcast successfully. The symptom is "detections show up in the browser but my results callback is silent."

This is why `backend/src/utils/models.py` carries `id: Optional[str] = None` on `BBoxData` and `backend/src/managers/bbox.py` puts `"id": bbox.id` into the stored bbox dict. **Do not remove either.** From the library's side the field is effectively mandatory even though the backend treats it as optional.

### Performance

- **One `Vec<u8>` allocation + one full-resolution `sws_scale` per frame, per source** (`mp4/ffmpeg.rs:222`, `:237`). At 1080p30 that is ~6.2 MB/s of fresh allocation and a full colour conversion 30×/s/source. There is no buffer pool and no downscale option.
- Every frame is converted **whether or not the host does anything with it** — there is no way to say "skip frames" or "give me YUV".
- The Python wrapper's inline handler blocks decode; the Rust wrapper's copy-then-defer costs a second full-frame copy. Pick your poison.
- The rust-wrapper does a `dlsym` per FFI call.

### Robustness / operations

- **`B2B_URL` is compile-time.** Repointing at a different backend requires a full rebuild of the `.so`.
- ⚠️ **A `B2B_URL` with a path prefix breaks everything silently.** `http://host:8702/video` makes every request hit the backend's catch-all `404` route: `GET /videos/` fails (so no source is ever `online` and no decoder ever starts), and `POST /bboxes/` fails. Nothing crashes; the library just sits in `Initializing` forever. The correct value here is `http://127.0.0.1:8702`.
- **The results queue drops the oldest.** A host outrunning `MAX_RESULTS_CONCURRENT = 10` in-flight POSTs loses its *earliest* detection sets, silently, at 256 backlogged sets.
- **A backend restart wipes everything.** The backend is fully in-memory, so a restart (including a `--reload` restart on any code edit) deletes every video. The library's poller then sees an empty `/videos/`, marks every source offline, and tears its decoders down through `Terminating` — recovering only if the same ids are re-uploaded.
- **`--disable-network` means the decoder is only as resilient as reqwest.** A half-open TCP connection is detected by the 10 s TCP keepalive, not by FFmpeg.
- Logs are **JSON on stdout** (`utils/logger.rs:26-29`), installed with `try_init` so a host that already set a `tracing` subscriber keeps its own (`:31-34`). A non-Rust host gets JSON lines on stdout it did not ask for and cannot turn off — only turn down, via `SetSettings` or `RUST_LOG`.

### Testing

There are **no tests** in this component, no `mod tests`, no `tests/` directory, and no CI. The `rlib` half of `crate-type = ["cdylib", "rlib"]` exists so `test_client` (and any future integration test) can link the crate.

Verification is manual:

```bash
cd library && B2B_URL=http://127.0.0.1:8702 ./build_library.sh
cd client && cargo run --release --bin test_client -- --source_ids 1
```

with the backend running and video 1 streaming. Expect, in order: `status -> Initializing`, `got metadata WxH @fps`, then a stream of `got frame …` lines.
