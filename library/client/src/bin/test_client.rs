//! Drives the library through its C ABI (`api.rs`) as a host would, against a
//! live backend. Requires the `.so` to have been built with `B2B_URL` cooked in
//! (e.g. `B2B_URL=http://127.0.0.1:8702`, bare origin — no path prefix) and the
//! given source streaming.

use std::ffi::CStr;
use std::os::raw::{c_char, c_int, c_longlong, c_uint, c_void};
use std::sync::atomic::{AtomicBool, Ordering};

use clap::Parser;
use client_video::api;

/// Drive the client_video C ABI against a live backend (B2B_URL is cooked in at build time).
#[derive(Parser)]
struct Args {
    /// Source ids to stream, e.g. --source_ids 1,2
    #[arg(long = "source_ids", value_delimiter = ',', required = true)]
    source_ids: Vec<c_uint>,
}

static STOP: AtomicBool = AtomicBool::new(false);

extern "C" fn on_frames(
    source_id: c_uint,
    _frame: *const u8,
    width: c_int,
    height: c_int,
    pts: c_longlong,
) {
    let bytes = width as i64 * height as i64 * 3;
    println!("[src {source_id}] got frame {width}x{height}, {bytes} bytes, pts {pts}");
}

extern "C" fn on_metadata(
    source_id: c_uint,
    name: *const c_char,
    width: c_int,
    height: c_int,
    fps: c_int,
) {
    let display = if name.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(name).to_string_lossy().into_owned() }
    };
    println!("[src {source_id}] got metadata {width}x{height} @{fps} name='{display}'");
    // Ownership of `name` was transferred to us — free the library's pointer.
    if !name.is_null() {
        unsafe {
            api::FreeCPtr(name as *const c_void);
        }
    }
}

extern "C" fn on_status(source_id: c_uint, status: c_int) {
    // SourceStatus: Idle = 0, Initializing = 1, Streaming = 2, Terminating = 3
    // (see `source.rs` — `SourceStatus`).
    let s = match status {
        0 => "Idle",
        1 => "Initializing",
        2 => "Streaming",
        3 => "Terminating",
        _ => "?",
    };
    println!("[src {source_id}] status -> {s}");
}

extern "C" fn on_results(
    source_id: c_uint,
    count: c_int,
    _ids: *const *const c_char,
    _timestamps: *const c_longlong,
) {
    // KNOWN LEAK (deliberate — this is a smoke-test binary, kept byte-faithful to the
    // reference host): all four pointer arguments are library-OWNED. A correct host must
    // perform N + 2 `FreeCPtr` calls per invocation — one per id string, plus the ids array
    // and the timestamps array — after copying the `char*` values out. See the wrappers under
    // `wrappers/` for the correct pattern, and ../../docs/library.md §"Memory ownership".
    println!("[src {source_id}] got results: {count}");
}

extern "C" fn on_sigint(_: c_int) {
    STOP.store(true, Ordering::SeqCst);
}

fn main() {
    // Logging is installed by the library on SetCallbacks (see `utils::logger`).
    let ids = Args::parse().source_ids;
    println!("driving sources {ids:?}");

    unsafe {
        libc::signal(
            libc::SIGINT,
            on_sigint as extern "C" fn(c_int) as libc::sighandler_t,
        );
    }

    // Safety: static callbacks and a valid `ids` slice — the C-host contract.
    unsafe {
        api::SetCallbacks(on_frames, on_metadata, on_status, on_results);
    }
    api::SetSettings(1); // debug
    unsafe {
        api::InitSources(ids.as_ptr(), ids.len() as c_int);
    }

    while !STOP.load(Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(200));
    }

    println!("stopping…");
    unsafe {
        api::StopSources(ids.as_ptr(), ids.len() as c_int);
    }
    std::thread::sleep(std::time::Duration::from_millis(300));
}
