//! Idiomatic wrapper over the compiled `libclient_video.so` C ABI. The `.so` is
//! `dlopen`ed once into a process-global singleton; callers register a plain
//! Rust frame handler and drive sources with `Vec<u32>` — no C types leak out.

use std::ffi::CString;
use std::sync::{Arc, RwLock};

use anyhow::{Context, Result};
use libc::{c_char, c_int, c_longlong, c_uint, c_void};
use libloading::{Library, Symbol};
use serde_json::json;
use tokio::sync::OnceCell;

// Custom Modules
use crate::utils::{Ownership, get_c_array, get_c_string};
// Re-exported so a host gets the API and its types from one module.
pub use crate::utils::{RawFrame, ResultBBOX};

// Path to the compiled library, relative to the process working directory
// (run the example from this crate's directory).
const SO_PATH: &str = "../../client/target/release/libclient_video.so";

// C ABI types
// Host callbacks — the library calls into these.
type SourceFramesCB = extern "C" fn(
    source_id: c_uint,
    frame: *const u8,
    width: c_int,
    height: c_int,
    pts: c_longlong,
);

type SourceMetadataCB = extern "C" fn(
    source_id: c_uint,
    source_name: *const c_char,
    width: c_int,
    height: c_int,
    fps: c_int,
);

type SourceStatusCB = extern "C" fn(source_id: c_uint, status: c_int);

type PostResultsCB = extern "C" fn(
    source_id: c_uint,
    results_count: c_int,
    results_ids: *const *const c_char,
    results_timestamps: *const c_longlong,
);

// Exported library functions — we call into these.
type SetCallbacksFn = extern "C" fn(
    frames: SourceFramesCB,
    metadata: SourceMetadataCB,
    status: SourceStatusCB,
    results: PostResultsCB,
);
type SetSettingsFn = extern "C" fn(run_mode: c_int);
type InitSourcesFn = extern "C" fn(source_ids: *const c_uint, size: c_int);
type StopSourcesFn = extern "C" fn(source_ids: *const c_uint, size: c_int);
type PostResultsFn = extern "C" fn(
    source_id: c_uint,
    results_count: c_int,
    results_ids: *const *const c_char,
    result_body: *const c_char,
) -> c_int;
type FreeCPtrFn = extern "C" fn(ptr: *const c_void);

// The user's frame handler, stored so the C frames trampoline can reach it.
type FrameHandler = Arc<dyn Fn(RawFrame) -> Result<()> + Send + Sync>;

// Enums
#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunMode {
    Regular = 0,
    Debug = 1,
}

impl RunMode {
    pub fn as_i32(self) -> c_int {
        self as c_int
    }
}

#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceStatus {
    Idle = 0,
    Initializing = 1,
    Streaming = 2,
    Terminating = 3,
}

impl SourceStatus {
    fn from_i32(value: c_int) -> Self {
        match value {
            1 => SourceStatus::Initializing,
            2 => SourceStatus::Streaming,
            3 => SourceStatus::Terminating,
            _ => SourceStatus::Idle,
        }
    }
}

// Library handle
pub struct VideoLibrary {
    library: Library,
    runtime: tokio::runtime::Handle,
    frame_callback: RwLock<Option<FrameHandler>>,
}

impl VideoLibrary {
    fn new(runtime: tokio::runtime::Handle) -> Result<Self> {
        let library = unsafe {
            Library::new(SO_PATH).with_context(|| format!("failed to load '{SO_PATH}'"))?
        };
        Ok(Self {
            library,
            runtime,
            frame_callback: RwLock::new(None),
        })
    }

    fn library(&self) -> &Library {
        &self.library
    }

    fn runtime(&self) -> &tokio::runtime::Handle {
        &self.runtime
    }
}

// Singleton
static VIDEO_LIBRARY: OnceCell<Arc<VideoLibrary>> = OnceCell::const_new();

/// Load the `.so` into memory once, storing the runtime it will use to run the
/// user's frame handler off the library's decoder thread.
pub fn init_video_library(runtime: tokio::runtime::Handle) -> Result<()> {
    if VIDEO_LIBRARY.get().is_some() {
        anyhow::bail!("video library is already initiated");
    }
    let video_library = VideoLibrary::new(runtime).context("failed to initiate video library")?;
    VIDEO_LIBRARY
        .set(Arc::new(video_library))
        .map_err(|_| anyhow::anyhow!("failed to set video library"))?;
    Ok(())
}

pub fn get_video_library() -> Result<Arc<VideoLibrary>> {
    VIDEO_LIBRARY
        .get()
        .cloned()
        .context("video library is not initiated")
}

// User-facing API
/// Boot the library: register the frame handler, then apply the run mode.
/// `on_frame` runs on our runtime (via `spawn_blocking`), so it may block
/// without stalling decode.
pub fn init_state<F>(on_frame: F, run_mode: RunMode) -> Result<()>
where
    F: Fn(RawFrame) -> Result<()> + Send + Sync + 'static,
{
    // Order matters: SetCallbacks boots the library's global state; SetSettings
    // is a no-op until it exists.
    set_callbacks(on_frame)?;
    set_settings(run_mode)?;
    Ok(())
}

/// Set the library run mode (log level).
fn set_settings(run_mode: RunMode) -> Result<()> {
    let video_library = get_video_library()?;
    unsafe {
        let set_settings: Symbol<SetSettingsFn> = video_library
            .library()
            .get(b"SetSettings")
            .context("cannot resolve 'SetSettings'")?;
        set_settings(run_mode.as_i32());
    }
    Ok(())
}

/// Register the frame handler and boot the library.
fn set_callbacks<F>(on_frame: F) -> Result<()>
where
    F: Fn(RawFrame) -> Result<()> + Send + Sync + 'static,
{
    let video_library = get_video_library()?;

    // Store the handler before booting — SetCallbacks may fire frames at once.
    match video_library.frame_callback.write() {
        Ok(mut guard) => *guard = Some(Arc::new(on_frame)),
        Err(_) => anyhow::bail!("frame callback lock is poisoned"),
    }

    unsafe {
        let set_callbacks: Symbol<SetCallbacksFn> = video_library
            .library()
            .get(b"SetCallbacks")
            .context("cannot resolve 'SetCallbacks'")?;
        set_callbacks(
            frames_callback,
            metadata_callback,
            status_callback,
            post_results_callback,
        );
    }
    Ok(())
}

/// Start a decoder per source id (backend video ids).
pub fn start_sources(source_ids: Vec<u32>) -> Result<()> {
    if source_ids.is_empty() {
        anyhow::bail!("no source ids provided");
    }
    let ids: Vec<c_uint> = source_ids.iter().map(|&id| id as c_uint).collect();

    let video_library = get_video_library()?;
    unsafe {
        let init_sources: Symbol<InitSourcesFn> = video_library
            .library()
            .get(b"InitSources")
            .context("cannot resolve 'InitSources'")?;
        init_sources(ids.as_ptr(), ids.len() as c_int);
    }
    Ok(())
}

/// Stop the decoders for the given source ids.
pub fn stop_sources(source_ids: Vec<u32>) -> Result<()> {
    if source_ids.is_empty() {
        anyhow::bail!("no source ids provided");
    }
    let ids: Vec<c_uint> = source_ids.iter().map(|&id| id as c_uint).collect();

    let video_library = get_video_library()?;
    unsafe {
        let stop_sources: Symbol<StopSourcesFn> = video_library
            .library()
            .get(b"StopSources")
            .context("cannot resolve 'StopSources'")?;
        stop_sources(ids.as_ptr(), ids.len() as c_int);
    }
    Ok(())
}

/// Post detections for a frame's source back to the backend. Each bbox's `id`
/// is cloned into the results-id array and embedded in the JSON body.
pub fn populate_bboxes(frame: &RawFrame, bboxes: &[ResultBBOX]) -> Result<()> {
    // Per-bbox ids (cloned, never moved) for the results-id array.
    let result_ids: Vec<String> = bboxes.iter().map(|bbox| bbox.id.clone()).collect();

    // JSON body; each bbox carries its id for backend correlation.
    let bboxes_json: Vec<_> = bboxes
        .iter()
        .map(|bbox| {
            let (top_left_corner, bottom_right_corner) = bbox.corners_coordinates(frame);
            json!({
                "id": bbox.id,
                "pts": frame.pts,
                "top_left_corner": top_left_corner,
                "bottom_right_corner": bottom_right_corner,
                "class_name": bbox.class_name(),
                "confidence": bbox.score,
            })
        })
        .collect();
    let result_body = json!({
        "stream_id": frame.source_id,
        "bboxes": bboxes_json,
    })
    .to_string();

    // The library copies these synchronously, so keep them alive across the call
    // and let Rust drop them afterwards — no FreeCPtr on our inbound pointers.
    let c_ids: Vec<CString> = result_ids
        .iter()
        .map(|id| CString::new(id.as_str()))
        .collect::<std::result::Result<_, _>>()
        .context("a bbox id contains an interior NUL")?;
    let id_ptrs: Vec<*const c_char> = c_ids.iter().map(|id| id.as_ptr()).collect();
    let c_body = CString::new(result_body).context("result body contains an interior NUL")?;

    let video_library = get_video_library()?;
    unsafe {
        let post_results: Symbol<PostResultsFn> = video_library
            .library()
            .get(b"PostResults")
            .context("cannot resolve 'PostResults'")?;
        let code = post_results(
            frame.source_id as c_uint,
            c_ids.len() as c_int,
            id_ptrs.as_ptr(),
            c_body.as_ptr(),
        );
        if code != 0 {
            anyhow::bail!("PostResults failed with code {code}");
        }
    }
    Ok(())
}

// Callbacks (library -> host)
extern "C" fn frames_callback(
    source_id: c_uint,
    frame: *const u8,
    width: c_int,
    height: c_int,
    pts: c_longlong,
) {
    let Ok(video_library) = get_video_library() else {
        return;
    };
    let width = width as u32;
    let height = height as u32;
    let frame_size = (width as usize) * (height as usize) * 3;

    // The buffer is borrowed (valid only for this call) — copy it now.
    let data = match get_c_array(frame, frame_size, Ownership::Borrowed) {
        Ok(data) => data,
        Err(_) => {
            tracing::error!(source_id = source_id, "received an invalid frame buffer");
            return;
        }
    };

    let handler = match video_library.frame_callback.read() {
        Ok(guard) => guard.clone(),
        Err(_) => return,
    };
    let Some(handler) = handler else {
        return;
    };

    let raw_frame = RawFrame {
        source_id,
        data,
        width,
        height,
        pts,
    };

    // Run the user's handler on our runtime, off the library's decoder thread.
    video_library.runtime().spawn_blocking(move || {
        if let Err(e) = handler(raw_frame) {
            tracing::error!(source_id = source_id, error = %e, "frame handler failed");
        }
    });
}

extern "C" fn metadata_callback(
    source_id: c_uint,
    source_name: *const c_char,
    width: c_int,
    height: c_int,
    fps: c_int,
) {
    let source_name =
        get_c_string(source_name, Ownership::Owned).unwrap_or_else(|_| "UNKNOWN".to_string());
    tracing::info!(
        source_id = source_id,
        source_name = source_name,
        width = width,
        height = height,
        fps = fps,
        "got source metadata"
    );
}

extern "C" fn status_callback(source_id: c_uint, status: c_int) {
    let status = SourceStatus::from_i32(status);
    tracing::info!(source_id = source_id, ?status, "got source status");
}

extern "C" fn post_results_callback(
    source_id: c_uint,
    results_count: c_int,
    results_ids: *const *const c_char,
    results_timestamps: *const c_longlong,
) {
    let count = results_count.max(0) as usize;

    // All library-owned: N + 2 frees. An unreadable id becomes an empty string rather than being
    // dropped, since `ids` and `timestamps` are index-aligned.
    let ids: Vec<String> = get_c_array(results_ids, count, Ownership::Owned)
        .unwrap_or_default()
        .into_iter()
        .map(|ptr| get_c_string(ptr, Ownership::Owned).unwrap_or_default())
        .collect();
    let timestamps = get_c_array(results_timestamps, count, Ownership::Owned).unwrap_or_default();

    tracing::info!(
        source_id = source_id,
        results_count = results_count,
        ids = ?ids,
        timestamps = ?timestamps,
        "got post results response"
    );
}

// Helpers
/// Hand a library-owned pointer back to the `.so`. Callers go through `Ownership`.
pub(crate) fn free_c_ptr<T>(ptr: *const T) -> Result<()> {
    let video_library = get_video_library()?;
    unsafe {
        let free_c_ptr: Symbol<FreeCPtrFn> = video_library
            .library()
            .get(b"FreeCPtr")
            .context("cannot resolve 'FreeCPtr'")?;
        free_c_ptr(ptr as *const c_void);
    }
    Ok(())
}
