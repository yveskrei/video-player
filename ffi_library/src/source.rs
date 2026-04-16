//! Per-source orchestrator: a monitor task drives the decode loop with
//! reconnect-on-failure; a post-processor task drains enqueued bbox JSON to
//! the backend. Both run on the shared tokio runtime; Drop aborts them.

use std::ffi::CString;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use parking_lot::{Mutex, RwLock};
use tokio::runtime::Handle;
use tokio::task::JoinHandle;
use tracing::{info, warn};

use crate::config::{POST_QUEUE_CAPACITY, RECONNECT_INTERVAL_MS};
use crate::decoder::{DecodedFrame, StreamDecoder, StreamMetadata};
use crate::player_api::{PlayerApi, StreamUrls};
use crate::queue::{FixedSizeQueue, FixedSizeQueueReceiver, FixedSizeQueueSender};
use crate::state::get_state;
use crate::status::{SourceStatus, SourceStatusCell};

struct SharedInner {
    source_id: i32,
    status: Arc<SourceStatusCell>,
    width: Arc<AtomicU32>,
    height: Arc<AtomicU32>,
    fps: Arc<RwLock<f64>>,
    urls: StreamUrls,
    stop_signal: Arc<AtomicBool>,
    player_api: Arc<PlayerApi>,
}

pub struct Source {
    inner: Arc<SharedInner>,
    post_sender: FixedSizeQueueSender<String>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl Source {
    pub fn new(
        source_id: i32,
        player_api: Arc<PlayerApi>,
        runtime: &Handle,
    ) -> Result<Arc<Self>> {
        let urls = player_api.get_stream_urls(source_id);
        let queue: FixedSizeQueue<String> = FixedSizeQueue::new(
            POST_QUEUE_CAPACITY,
            Some(|dropped: String| {
                warn!(len = dropped.len(), "post queue full; oldest dropped");
            }),
        );
        let post_sender = queue.sender.clone();
        let post_receiver = queue.receiver;

        let inner = Arc::new(SharedInner {
            source_id,
            status: Arc::new(SourceStatusCell::new(SourceStatus::Stopped)),
            width: Arc::new(AtomicU32::new(0)),
            height: Arc::new(AtomicU32::new(0)),
            fps: Arc::new(RwLock::new(0.0)),
            urls,
            stop_signal: Arc::new(AtomicBool::new(false)),
            player_api,
        });

        let monitor = runtime.spawn(monitor_task(Arc::clone(&inner)));
        let post = runtime.spawn(post_processor_task(Arc::clone(&inner), post_receiver));

        Ok(Arc::new(Source {
            inner,
            post_sender,
            tasks: Mutex::new(vec![monitor, post]),
        }))
    }

    pub fn push_post_result(&self, json: String) -> Result<()> {
        self.post_sender
            .send_sync(json)
            .context("post queue send")
    }

    pub fn shutdown(&self) {
        self.inner.stop_signal.store(true, Ordering::SeqCst);
        for h in self.tasks.lock().drain(..) {
            h.abort();
        }
        self.inner.status.set(SourceStatus::Stopped);
        fire_status(self.inner.source_id, SourceStatus::Stopped);
    }
}

impl Source {
    pub fn source_id(&self) -> i32 { self.inner.source_id }

    #[allow(dead_code)]
    pub fn status(&self) -> SourceStatus { self.inner.status.get() }

    #[allow(dead_code)]
    pub fn width(&self) -> u32 { self.inner.width.load(Ordering::SeqCst) }

    #[allow(dead_code)]
    pub fn height(&self) -> u32 { self.inner.height.load(Ordering::SeqCst) }

    #[allow(dead_code)]
    pub fn fps(&self) -> f64 { *self.inner.fps.read() }

    #[allow(dead_code)]
    pub fn urls(&self) -> &StreamUrls { &self.inner.urls }
}

impl Drop for Source {
    fn drop(&mut self) {
        self.shutdown();
    }
}

async fn monitor_task(inner: Arc<SharedInner>) {
    set_status(&inner, SourceStatus::Initializing);

    while !inner.stop_signal.load(Ordering::SeqCst) {
        match run_one_session(&inner).await {
            Ok(()) => info!(source_id = inner.source_id, "session ended"),
            Err(e) => warn!(source_id = inner.source_id, error = ?e, "session failed"),
        }
        if inner.stop_signal.load(Ordering::SeqCst) {
            break;
        }
        set_status(&inner, SourceStatus::Initializing);
        tokio::time::sleep(Duration::from_millis(RECONNECT_INTERVAL_MS)).await;
    }

    set_status(&inner, SourceStatus::Stopped);
}

async fn run_one_session(inner: &Arc<SharedInner>) -> Result<()> {
    let header = {
        let api = Arc::clone(&inner.player_api);
        let url = inner.urls.header_url.clone();
        tokio::task::spawn_blocking(move || api.fetch_header_blocking(&url))
            .await
            .context("header fetch join")?
            .context("header fetch")?
    };

    let stream_name = match inner.player_api.get_video_info(inner.source_id).await {
        Ok(info) => info.name,
        Err(e) => {
            warn!(source_id = inner.source_id, error = ?e, "video info fetch failed");
            String::new()
        }
    };

    let body = {
        let api = Arc::clone(&inner.player_api);
        let url = inner.urls.segment_url.clone();
        tokio::task::spawn_blocking(move || -> Result<reqwest::blocking::Response> {
            let resp = api.blocking_client().get(&url).send().context("segment request")?;
            if !resp.status().is_success() {
                bail!("segment HTTP {}", resp.status());
            }
            Ok(resp)
        })
        .await
        .context("segment open join")?
        .context("segment open")?
    };

    let decode_inner = Arc::clone(inner);
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut decoder = StreamDecoder::open(header, body, Arc::clone(&decode_inner.stop_signal))
            .context("decoder open")?;
        let meta = decoder.metadata();
        decode_inner.width.store(meta.width as u32, Ordering::SeqCst);
        decode_inner.height.store(meta.height as u32, Ordering::SeqCst);
        *decode_inner.fps.write() = meta.fps;

        fire_metadata(decode_inner.source_id, meta, &stream_name);
        decode_inner.status.set(SourceStatus::Streaming);
        fire_status(decode_inner.source_id, SourceStatus::Streaming);

        loop {
            if decode_inner.stop_signal.load(Ordering::SeqCst) {
                break;
            }
            match decoder.next_frame().context("next_frame")? {
                Some(frame) => fire_frame(decode_inner.source_id, &frame),
                None => break,
            }
        }
        Ok(())
    })
    .await
    .context("decoder task join")??;

    Ok(())
}

async fn post_processor_task(inner: Arc<SharedInner>, receiver: FixedSizeQueueReceiver<String>) {
    while !inner.stop_signal.load(Ordering::SeqCst) {
        let Some(json) = receiver.recv().await else { break };
        match inner.player_api.post_results(&inner.urls.post_url, json).await {
            Ok(body) => fire_post_results(inner.source_id, &body),
            Err(e) => warn!(source_id = inner.source_id, error = ?e, "post results failed"),
        }
    }
}

fn set_status(inner: &SharedInner, status: SourceStatus) {
    inner.status.set(status);
    fire_status(inner.source_id, status);
}

fn fire_status(source_id: i32, status: SourceStatus) {
    if let Some(cb) = callbacks() {
        (cb.status)(source_id, status.as_i32());
    }
}

fn fire_frame(source_id: i32, frame: &DecodedFrame) {
    if let Some(cb) = callbacks() {
        (cb.frames)(source_id, frame.rgb.as_ptr(), frame.width, frame.height, frame.pts_90k);
    }
}

fn fire_metadata(source_id: i32, meta: StreamMetadata, stream_name: &str) {
    let Some(cb) = callbacks() else { return };
    let cname = CString::new(stream_name).unwrap_or_else(|_| CString::default());
    let raw = cname.into_raw();
    (cb.metadata)(source_id, meta.width, meta.height, meta.fps.round() as i32, raw as *const _);
}

fn fire_post_results(source_id: i32, body: &str) {
    let Some(cb) = callbacks() else { return };
    let cbody = match CString::new(body) {
        Ok(s) => s,
        Err(_) => {
            warn!(source_id, "post-results body contained NUL; skipped");
            return;
        }
    };
    let raw = cbody.into_raw();
    (cb.post_results)(source_id, raw as *const _);
}

fn callbacks() -> Option<crate::callbacks::Callbacks> {
    get_state().ok().and_then(|s| s.callbacks())
}
