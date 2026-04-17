//! C callback function pointer types + the bundle the library stores.

use libc::{c_char, c_int};

pub type SourceFramesCallback =
    extern "C" fn(source_id: c_int, frame: *const u8, width: c_int, height: c_int, pts: u64);

pub type SourceMetadataCallback = extern "C" fn(
    source_id: c_int,
    width: c_int,
    height: c_int,
    fps: c_int,
    stream_name: *const c_char,
);

pub type SourceStatusCallback = extern "C" fn(source_id: c_int, status: c_int);

pub type PostResultsCallback = extern "C" fn(source_id: c_int, json: *const c_char);

#[derive(Clone, Copy)]
pub struct Callbacks {
    pub frames: SourceFramesCallback,
    pub metadata: SourceMetadataCallback,
    pub status: SourceStatusCallback,
    pub post_results: PostResultsCallback,
}

unsafe impl Send for Callbacks {}
unsafe impl Sync for Callbacks {}
