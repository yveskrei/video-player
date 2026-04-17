//! Per-source orchestrator: a monitor task drives the decode loop with
//! reconnect-on-failure; a post-processor task drains enqueued bbox JSON to
//! the backend. Both run on the shared tokio runtime; Drop aborts them.

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use parking_lot::{Mutex, RwLock};
use tokio::runtime::Handle;
use tokio::task::JoinHandle;
use tracing::{info, warn};

use crate::config::{POST_QUEUE_CAPACITY, RECONNECT_INTERVAL_MS};
use crate::decoder::StreamDecoder;
use crate::player_api::{PlayerApi, StreamUrls};
use crate::queue::{FixedSizeQueue, FixedSizeQueueReceiver, FixedSizeQueueSender};
use crate::state::get_state;

// ----------------------------------------------------------------------
// Source lifecycle status. Values match the int the StatusCallback receives.
// ----------------------------------------------------------------------

#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceStatus {
    Stopped = 0,
    Streaming = 1,
    Initializing = 2,
    Terminating = 3,
}

impl SourceStatus {
    pub fn as_i32(self) -> i32 { self as i32 }

    fn from_i32(v: i32) -> Self {
        match v {
            1 => SourceStatus::Streaming,
            2 => SourceStatus::Initializing,
            3 => SourceStatus::Terminating,
            _ => SourceStatus::Stopped,
        }
    }
}

#[derive(Debug)]
pub struct SourceStatusCell(AtomicI32);

impl SourceStatusCell {
    pub fn new(initial: SourceStatus) -> Self {
        Self(AtomicI32::new(initial.as_i32()))
    }

    pub fn set(&self, status: SourceStatus) {
        self.0.store(status.as_i32(), Ordering::SeqCst);
    }

    pub fn get(&self) -> SourceStatus {
        SourceStatus::from_i32(self.0.load(Ordering::SeqCst))
    }
}

// ----------------------------------------------------------------------
// StreamState: the shared per-source state + the tasks that mutate it.
// ----------------------------------------------------------------------

struct StreamState {
    source_id: i32,
    status: Arc<SourceStatusCell>,
    width: Arc<AtomicU32>,
    height: Arc<AtomicU32>,
    fps: Arc<RwLock<f64>>,
    urls: StreamUrls,
    stop_signal: Arc<AtomicBool>,
    player_api: Arc<PlayerApi>,
}

impl StreamState {
    fn set_status(&self, status: SourceStatus) {
        self.status.set(status);
        if let Ok(state) = get_state() {
            state.trigger_status(self.source_id, status);
        }
    }

    async fn monitor_task(self: Arc<Self>) {
        self.set_status(SourceStatus::Initializing);

        while !self.stop_signal.load(Ordering::SeqCst) {
            match self.run_one_session().await {
                Ok(()) => info!(source_id = self.source_id, "session ended"),
                Err(e) => warn!(source_id = self.source_id, error = ?e, "session failed"),
            }
            if self.stop_signal.load(Ordering::SeqCst) {
                break;
            }
            self.set_status(SourceStatus::Initializing);
            tokio::time::sleep(Duration::from_millis(RECONNECT_INTERVAL_MS)).await;
        }

        self.set_status(SourceStatus::Stopped);
    }

    async fn run_one_session(self: &Arc<Self>) -> Result<()> {
        let header = {
            let api = Arc::clone(&self.player_api);
            let url = self.urls.header_url.clone();
            tokio::task::spawn_blocking(move || api.fetch_header_blocking(&url))
                .await
                .context("header fetch join")?
                .context("header fetch")?
        };

        let stream_name = match self.player_api.get_video_info(self.source_id).await {
            Ok(info) => info.name,
            Err(e) => {
                warn!(source_id = self.source_id, error = ?e, "video info fetch failed");
                String::new()
            }
        };

        let body = {
            let api = Arc::clone(&self.player_api);
            let url = self.urls.segment_url.clone();
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

        let this = Arc::clone(self);
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut decoder = StreamDecoder::open(header, body, Arc::clone(&this.stop_signal))
                .context("decoder open")?;
            let meta = decoder.metadata();
            this.width.store(meta.width as u32, Ordering::SeqCst);
            this.height.store(meta.height as u32, Ordering::SeqCst);
            *this.fps.write() = meta.fps;

            if let Ok(state) = get_state() {
                state.trigger_metadata(this.source_id, meta, &stream_name);
            }
            this.status.set(SourceStatus::Streaming);
            if let Ok(state) = get_state() {
                state.trigger_status(this.source_id, SourceStatus::Streaming);
            }

            loop {
                if this.stop_signal.load(Ordering::SeqCst) {
                    break;
                }
                match decoder.next_frame().context("next_frame")? {
                    Some(frame) => {
                        if let Ok(state) = get_state() {
                            state.trigger_frame(this.source_id, &frame);
                        }
                    }
                    None => break,
                }
            }
            Ok(())
        })
        .await
        .context("decoder task join")??;

        Ok(())
    }

    async fn post_processor_task(self: Arc<Self>, receiver: FixedSizeQueueReceiver<String>) {
        while !self.stop_signal.load(Ordering::SeqCst) {
            let Some(json) = receiver.recv().await else { break };
            match self.player_api.post_results(&self.urls.post_url, json).await {
                Ok(body) => {
                    if let Ok(state) = get_state() {
                        state.trigger_post_results(self.source_id, &body);
                    }
                }
                Err(e) => warn!(source_id = self.source_id, error = ?e, "post results failed"),
            }
        }
    }
}

// ----------------------------------------------------------------------
// Source: public-facing owner. Holds the StreamState and the task handles.
// ----------------------------------------------------------------------

pub struct Source {
    inner: Arc<StreamState>,
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

        let inner = Arc::new(StreamState {
            source_id,
            status: Arc::new(SourceStatusCell::new(SourceStatus::Stopped)),
            width: Arc::new(AtomicU32::new(0)),
            height: Arc::new(AtomicU32::new(0)),
            fps: Arc::new(RwLock::new(0.0)),
            urls,
            stop_signal: Arc::new(AtomicBool::new(false)),
            player_api,
        });

        let monitor = runtime.spawn(Arc::clone(&inner).monitor_task());
        let post = runtime.spawn(Arc::clone(&inner).post_processor_task(post_receiver));

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
        if let Ok(state) = get_state() {
            state.trigger_status(self.inner.source_id, SourceStatus::Stopped);
        }
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
