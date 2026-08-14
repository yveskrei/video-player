//! A thin, idiomatic Rust wrapper around the compiled `libclient_video.so`.
//! Load it once with [`video_library::init_video_library`], register a frame
//! handler, drive sources — no raw pointers or C types leak to the caller.

pub mod utils;
pub mod video_library;
