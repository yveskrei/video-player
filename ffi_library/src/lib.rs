#![allow(clippy::uninlined_format_args)]
//! C ABI for the video-player FFI library: SetCallbacks, InitMultipleSources,
//! StopSource, PostResults, FreeCPtr.

use std::ffi::{CStr, CString};
use std::slice;

use libc::{c_char, c_int, c_void};
use tracing::{error, info, warn};

pub mod callbacks;
pub mod config;
pub mod decoder;
pub mod player_api;
pub mod queue;
pub mod source;
pub mod state;
pub mod status;

use crate::callbacks::{
    Callbacks, PostResultsCallback, SourceFramesCallback, SourceMetadataCallback,
    SourceStatusCallback,
};
use crate::source::Source;
use crate::state::get_state;

#[no_mangle]
pub extern "C" fn SetCallbacks(
    source_frames: SourceFramesCallback,
    source_metadata: SourceMetadataCallback,
    source_status: SourceStatusCallback,
    post_results: PostResultsCallback,
) {
    let state = match get_state() {
        Ok(s) => s,
        Err(e) => {
            error!(error = ?e, "SetCallbacks: state init failed");
            return;
        }
    };
    state.set_callbacks(Callbacks {
        frames: source_frames,
        metadata: source_metadata,
        status: source_status,
        post_results,
    });
    info!("callbacks registered");
}

/// # Safety
/// `source_ids` must point to a readable array of `size` `c_int` values, or be null.
#[no_mangle]
pub unsafe extern "C" fn InitMultipleSources(source_ids: *const c_int, size: c_int) {
    if source_ids.is_null() || size <= 0 {
        warn!(size, "InitMultipleSources: invalid args");
        return;
    }
    let state = match get_state() {
        Ok(s) => s,
        Err(e) => {
            error!(error = ?e, "InitMultipleSources: state init failed");
            return;
        }
    };
    if state.callbacks().is_none() {
        error!("InitMultipleSources: SetCallbacks must be called first");
        return;
    }
    let ids: Vec<i32> = slice::from_raw_parts(source_ids, size as usize).to_vec();
    let handle = state.runtime().handle().clone();
    for id in ids {
        if state.has_source(id) {
            info!(source_id = id, "source already initialised; skipping");
            continue;
        }
        match Source::new(id, state.player_api().clone(), &handle) {
            Ok(src) => {
                state.insert_source(src);
                info!(source_id = id, "source started");
            }
            Err(e) => error!(source_id = id, error = ?e, "source spawn failed"),
        }
    }
}

#[no_mangle]
pub extern "C" fn StopSource(source_id: c_int) {
    let state = match get_state() {
        Ok(s) => s,
        Err(e) => {
            error!(error = ?e, "StopSource: state init failed");
            return;
        }
    };
    if let Some(src) = state.remove_source(source_id) {
        src.shutdown();
        // src drops here: Drop is a no-op second shutdown, and the Arc's final
        // strong count releases on scope end once tasks have unwound.
        drop(src);
    }
}

/// # Safety
/// `json` must be a NUL-terminated UTF-8 string, or null.
#[no_mangle]
pub unsafe extern "C" fn PostResults(source_id: c_int, json: *const c_char) -> c_int {
    if json.is_null() {
        warn!(source_id, "PostResults: null json");
        return -1;
    }
    let json_str = match CStr::from_ptr(json).to_str() {
        Ok(s) => s,
        Err(e) => {
            warn!(source_id, error = ?e, "PostResults: invalid utf-8");
            return -1;
        }
    };
    let state = match get_state() {
        Ok(s) => s,
        Err(e) => {
            error!(error = ?e, "PostResults: state init failed");
            return -1;
        }
    };
    let Some(src) = state.source_by_id(source_id) else {
        warn!(source_id, "PostResults: unknown source_id");
        return -1;
    };
    match src.push_post_result(json_str.to_string()) {
        Ok(()) => 0,
        Err(e) => {
            warn!(source_id, error = ?e, "PostResults: enqueue failed");
            -1
        }
    }
}

/// # Safety
/// `ptr` must be either null, or a pointer previously handed to the caller by
/// this library via a callback.
#[no_mangle]
pub unsafe extern "C" fn FreeCPtr(ptr: *const c_void) {
    if ptr.is_null() {
        return;
    }
    let _ = CString::from_raw(ptr as *mut c_char);
}
