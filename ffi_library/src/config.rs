//! Compile-time knobs. Keep plain consts — no runtime config.

pub const BACKEND_URL: &str = "http://127.0.0.1:8702";

pub const RECONNECT_INTERVAL_MS: u64 = 2_000;

pub const POST_QUEUE_CAPACITY: usize = 1_024;

pub const PTS_TIMEBASE: u64 = 90_000;
