//! Usage example for the `rust_wrapper::video_library` API: load the `.so`,
//! register a frame handler, start sources, and post one detection per frame.

use anyhow::Result;
use rust_wrapper::video_library::{self, RawFrame, ResultBBOX, RunMode};
use uuid::Uuid;

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    // Multi-threaded runtime the wrapper uses to run our frame handler off the
    // library's decoder thread. Must stay alive for the whole process.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    video_library::init_video_library(runtime.handle().clone())?;

    // A plain Rust handler — runs on our runtime, so blocking work is fine here.
    video_library::init_state(handle_frame, RunMode::Debug)?;

    // Start decoding the given source ids (backend video ids).
    video_library::start_sources(vec![1])?;

    tracing::info!("library is initiated!");
    std::thread::park();
    Ok(())
}

pub fn handle_frame(frame: RawFrame) -> Result<()> {
    tracing::info!(
        source_id = frame.source_id,
        width = frame.width,
        height = frame.height,
        pts = frame.pts,
        bytes = frame.data.len(),
        "received a frame"
    );

    // Run your inference here. As an example, report one detection, giving
    // each bbox a fresh uuid4 id.
    let bbox = ResultBBOX {
        id: Uuid::new_v4().to_string(),
        bbox: [0.0, 0.0, 10.0, 10.0],
        class: 0,
        score: 0.9,
    };
    if let Err(e) = video_library::populate_bboxes(&frame, &[bbox]) {
        tracing::error!(error = %e, "failed to post bboxes");
    }

    Ok(())
}
