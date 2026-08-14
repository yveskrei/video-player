//! The C ABI — the `extern "C"` functions the host calls. `SetCallbacks` boots
//! the library; the rest drive [`crate::state`] / the source workers.

use std::os::raw::{c_char, c_int, c_uint, c_void};

use crate::source::{PostResultsInput, SourceProcessor};
use crate::state::{
    Callbacks, PostResultsCB, RunMode, Settings, SourceFramesCB, SourceMetadataCB, SourceStatusCB,
    get_state, init_state,
};
use crate::utils::{get_c_array, read_c_string};

/// # Safety
/// The four arguments must be valid function pointers matching the callback
/// signatures, live for the rest of the process.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn SetCallbacks(
    frames: SourceFramesCB,
    metadata: SourceMetadataCB,
    status: SourceStatusCB,
    results: PostResultsCB,
) {
    if init_state().is_err() {
        tracing::warn!("failed to initiate client");
        return;
    }
    let Ok(state) = get_state() else {
        return;
    };
    state.write().set_callbacks(Callbacks {
        source_frames: frames,
        source_metadata: metadata,
        source_status: status,
        post_results: results,
    });

    tracing::info!("callback functions are successfully set");
}

#[unsafe(no_mangle)]
pub extern "C" fn SetSettings(run_mode: c_int) {
    let Ok(state) = get_state() else {
        return;
    };
    state.write().set_settings(Settings {
        run_mode: RunMode::from_int(run_mode),
    });

    tracing::info!("settings are successfully set");
}

/// # Safety
/// `source_ids` must point to `size` valid `c_uint`s (or be null with `size <= 0`).
#[unsafe(no_mangle)]
#[allow(unsafe_op_in_unsafe_fn)]
pub unsafe extern "C" fn InitSources(source_ids: *const c_uint, size: c_int) {
    let Ok(state) = get_state() else {
        return;
    };
    let ids = get_c_array(source_ids, size);

    let (handle, registry) = {
        let s = state.read();
        (s.runtime().clone(), s.registry())
    };
    for &id in ids {
        if state.read().has_source(id) {
            tracing::warn!(
                source_id=id,
                "source is already initiated"
            );
            continue;
        }
        let processor = SourceProcessor::new(
            id,
            handle.clone(),
            registry.clone(),
        );
        state.read().insert_source(id, processor);

        tracing::info!(
            source_id=id, 
            "initiated source"
        );
    }
}

/// # Safety
/// `source_ids` must point to `size` valid `c_uint`s (or be null with `size <= 0`).
#[unsafe(no_mangle)]
#[allow(unsafe_op_in_unsafe_fn)]
pub unsafe extern "C" fn StopSources(source_ids: *const c_uint, size: c_int) {
    let Ok(state) = get_state() else {
        return;
    };
    let ids = get_c_array(source_ids, size);
    for &id in ids {
        // Dropping the removed processor terminates its thread gracefully.
        drop(state.read().remove_source(id));

        tracing::info!(
            source_id=id, 
            "stopped source"
        );
    }
}

/// # Safety
/// `results_ids` must point to `results_count` valid C-string pointers, and
/// `result_body` must be a valid NUL-terminated C string.
#[unsafe(no_mangle)]
#[allow(unsafe_op_in_unsafe_fn)]
pub unsafe extern "C" fn PostResults(
    source_id: c_uint,
    results_count: c_int,
    results_ids: *const *const c_char,
    result_body: *const c_char,
) -> c_int {
    let Ok(state) = get_state() else {
        return 1;
    };
    // The JSON body the host built for the registry.
    let Some(result_body) = read_c_string(result_body) else {
        return 1;
    };
    // The per-bbox UUIDs, index-aligned with the bboxes inside `result_body`.
    // Collecting into Option fails the whole set if any id is null/invalid.
    let Some(result_ids) = get_c_array(results_ids, results_count)
        .iter()
        .map(|&ptr| unsafe { read_c_string(ptr) })
        .collect::<Option<Vec<String>>>()
    else {
        return 1;
    };

    let input = PostResultsInput {
        result_ids,
        result_body,
    };
    if state.read().push_results(source_id, input) {
        0
    } else {
        1
    }
}

/// # Safety
/// `ptr` must be null or a pointer this library handed out (see Memory ownership),
/// not already freed.
#[unsafe(no_mangle)]
#[allow(unsafe_op_in_unsafe_fn)]
pub unsafe extern "C" fn FreeCPtr(ptr: *const c_void) {
    if ptr.is_null() {
        return;
    }
    libc::free(ptr as *mut c_void)
}
