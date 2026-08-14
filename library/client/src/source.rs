//! Per-source workers: a supervisor (tokio task) polls the registry and
//! starts/stops the decoder; the decoder (OS thread) consumes the progressive
//! stream. `status` is report-only. See CLAUDE.md "Execution model".

use std::io::Read;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

use parking_lot::RwLock;
use tokio::runtime::Handle;
use tokio::sync::Semaphore;

use crate::mp4;
use crate::state::get_state;
use crate::utils::queue::{FixedSizeQueue, FixedSizeQueueReceiver, FixedSizeQueueSender};
use crate::utils::registry_api::{Registry, SourceUrls};

// Variables
const REGISTRY_POLL: Duration = Duration::from_secs(1);
const RETRY_DELAY: Duration = Duration::from_secs(1);
const MAX_STREAM_RETRIES: u32 = 5;
const RESULTS_QUEUE_CAPACITY: usize = 256;
const MAX_RESULTS_CONCURRENT: usize = 10;

// Types
#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceStatus {
    Idle = 0,
    Initializing = 1,
    Streaming = 2,
    Terminating = 3,
}

impl SourceStatus {
    pub fn from_int(value: i32) -> SourceStatus {
        match value {
            1 => SourceStatus::Initializing,
            2 => SourceStatus::Streaming,
            3 => SourceStatus::Terminating,
            _ => SourceStatus::Idle,
        }
    }
}

enum StreamOutcome {
    /// The session ran (decoded ≥1 frame) and then ended — reconnect if still online.
    Progressed,
    /// The session couldn't open / decoded nothing — count against the retry budget.
    Failed,
}

/// A result set enqueued by `PostResults` for the results worker to post: the
/// host's per-bbox UUIDs and the raw JSON body to send to the registry.
pub struct PostResultsInput {
    pub result_ids: Vec<String>,
    pub result_body: String,
}

/// One posted bbox's outcome from the registry: its id and the wall-clock window
/// it occupied. The backend returns a single timestamp, so start == end.
pub struct PostResultsOutput {
    pub id: String,
    pub timestamp: i64,
}

pub struct SourceProcessor {
    id: u32,
    status: Arc<AtomicI32>,
    decoder_running: Arc<AtomicBool>,
    supervisor_task: Option<tokio::task::JoinHandle<()>>,
    results_sender: FixedSizeQueueSender<PostResultsInput>,
    results_task: Option<tokio::task::JoinHandle<()>>,
}

impl SourceProcessor {
    pub fn new(id: u32, handle: Handle, registry: Registry) -> Self {
        // setting as idle so the supervisor's first set_status fires.
        let status = Arc::new(AtomicI32::new(SourceStatus::Idle as i32));
        let decoder_running = Arc::new(AtomicBool::new(false));
        // Shared by the supervisor, the decoder, and the results worker: Some
        // while the stream is open (the results worker only posts then).
        let urls: Arc<RwLock<Option<SourceUrls>>> = Arc::new(RwLock::new(None));

        let supervisor_task = handle.spawn(Self::run_supervisor(
            id,
            handle.clone(),
            registry.clone(),
            status.clone(),
            urls.clone(),
            decoder_running.clone(),
        ));

        // Results worker: lives the whole source lifetime (drained regardless of
        // online/offline), stopped by aborting the task at Drop.
        let queue = FixedSizeQueue::new(RESULTS_QUEUE_CAPACITY);
        let results_task = handle.spawn(Self::run_results(id, registry, urls, queue.receiver));

        Self {
            id,
            status,
            decoder_running,
            supervisor_task: Some(supervisor_task),
            results_sender: queue.sender,
            results_task: Some(results_task),
        }
    }

    // Supervisor
    async fn run_supervisor(
        id: u32,
        handle: Handle,
        registry: Registry,
        status: Arc<AtomicI32>,
        urls: Arc<RwLock<Option<SourceUrls>>>,
        decoder_running: Arc<AtomicBool>,
    ) {
        Self::set_status(&status, id, SourceStatus::Initializing);

        let mut decoder: Option<JoinHandle<()>> = None;
        let mut ticker = tokio::time::interval(REGISTRY_POLL);

        loop {
            ticker.tick().await;

            let online = get_state()
                .ok()
                .and_then(|s| s.read().sources_information.get(&id).map(|i| i.online))
                .unwrap_or(false);

            let decoder_up = decoder.as_ref().map(|h| !h.is_finished()).unwrap_or(false);

            if online && !decoder_up {
                Self::set_status(&status, id, SourceStatus::Initializing);
                decoder_running.store(true, Ordering::Relaxed);
                decoder = Some(std::thread::spawn({
                    let (handle, registry, status, urls, decoder_running) = (
                        handle.clone(),
                        registry.clone(),
                        status.clone(),
                        urls.clone(),
                        decoder_running.clone(),
                    );
                    move || Self::run_decoder(id, handle, registry, status, urls, decoder_running)
                }));
            } else if !online {
                decoder_running.store(false, Ordering::Relaxed);
                // Tear a live stream down through Terminating; an idle (never
                // streaming) source just sits in Initializing. `urls` stays Some
                // until the decoder exits, so we dwell in Terminating until then.
                let next = if urls.read().is_some() {
                    SourceStatus::Terminating
                } else {
                    SourceStatus::Initializing
                };
                Self::set_status(&status, id, next);
            }
        }
    }

    // Results
    /// Drain the results queue and POST each set to the registry, up to
    /// `MAX_RESULTS_CONCURRENT` in flight. A set enqueued while the stream isn't
    /// open (`urls` is None) is dropped — the backend only accepts results for a
    /// live stream.
    async fn run_results(
        id: u32,
        registry: Registry,
        urls: Arc<RwLock<Option<SourceUrls>>>,
        receiver: FixedSizeQueueReceiver<PostResultsInput>,
    ) {
        let semaphore = Arc::new(Semaphore::new(MAX_RESULTS_CONCURRENT));
        loop {
            let input = receiver.recv().await;
            let results_url = urls.read().as_ref().map(|u| u.results_url.clone());
            let Some(results_url) = results_url else {
                tracing::warn!(
                    source_id = id,
                    "dropping results posted while source offline"
                );
                continue;
            };
            let Ok(permit) = semaphore.clone().acquire_owned().await else {
                break;
            };
            let registry = registry.clone();
            tokio::spawn(async move {
                let _permit = permit;
                Self::post_single_result(id, &registry, results_url, input).await;
            });
        }
    }

    /// POST one result set and, on success, fire `PostResultsCB` with the
    /// registry's per-bbox id + timestamps (start == end; see CLAUDE.md).
    async fn post_single_result(
        id: u32,
        registry: &Registry,
        results_url: String,
        input: PostResultsInput,
    ) {
        let outputs = match registry.post_results(results_url, input.result_body).await {
            Ok(list) => list,
            Err(e) => {
                tracing::debug!(
                    error=?e,
                    source_id=id,
                    "failed to post results to registry"
                );
                return;
            }
        };

        // Fan the outputs out into the parallel arrays the callback expects.
        let mut ids: Vec<String> = Vec::with_capacity(outputs.len());
        let mut timestamps: Vec<i64> = Vec::with_capacity(outputs.len());
        for output in outputs {
            ids.push(output.id);
            timestamps.push(output.timestamp);
        }

        if let Ok(state) = get_state() {
            state.read().trigger_results(id, &ids, &timestamps);
        }
    }

    // Decoder
    fn run_decoder(
        id: u32,
        handle: Handle,
        registry: Registry,
        status: Arc<AtomicI32>,
        urls: Arc<RwLock<Option<SourceUrls>>>,
        decoder_running: Arc<AtomicBool>,
    ) {
        let fetched = match handle.block_on(registry.urls(id)) {
            Ok(u) => u,
            Err(_) => {
                tracing::debug!(source_id = id, "failed to get source stream urls");

                Self::set_status(&status, id, SourceStatus::Terminating);
                return;
            }
        };

        // Each session opens fresh (fetch init + media, open libavformat) and reconnects on the next loop
        // if the stream drops. `announced` persists so metadata fires only once per source session.
        let mut retries: u32 = 0;
        let mut announced = false;
        while decoder_running.load(Ordering::Relaxed) {
            match Self::run_stream(
                id,
                &registry,
                &status,
                &fetched,
                &urls,
                &decoder_running,
                &mut announced,
            ) {
                StreamOutcome::Progressed => retries = 0,
                StreamOutcome::Failed => {
                    if Self::retry_or_terminate(id, &mut retries, &status, &decoder_running) {
                        break;
                    }
                }
            }
        }

        *urls.write() = None;
    }

    /// Count a failed attempt and decide the decoder's next move. Returns true if
    /// it should stop: the retry budget is spent (→ Terminating), or a stop was
    /// requested while waiting out the retry delay. Otherwise it waits `RETRY_DELAY`
    /// — waking early on a stop request — and returns false to retry.
    fn retry_or_terminate(
        id: u32,
        retries: &mut u32,
        status: &AtomicI32,
        decoder_running: &AtomicBool,
    ) -> bool {
        *retries += 1;
        if *retries >= MAX_STREAM_RETRIES {
            tracing::warn!(
                source_id = id,
                "stream error, restarting after reaching max failures"
            );
            Self::set_status(status, id, SourceStatus::Terminating);
            return true;
        }

        // Sleep RETRY_DELAY in short steps so a stop request during the wait is
        // honored promptly; a cleared flag means stop, not retry.
        const STEP: Duration = Duration::from_millis(100);
        let mut left = RETRY_DELAY;
        while left > Duration::ZERO {
            if !decoder_running.load(Ordering::Relaxed) {
                return true;
            }
            let step = left.min(STEP);
            std::thread::sleep(step);
            left -= step;
        }
        !decoder_running.load(Ordering::Relaxed)
    }

    #[allow(clippy::too_many_arguments)]
    fn run_stream(
        id: u32,
        registry: &Registry,
        status: &AtomicI32,
        fetched: &SourceUrls,
        urls: &RwLock<Option<SourceUrls>>,
        decoder_running: &Arc<AtomicBool>,
        announced: &mut bool,
    ) -> StreamOutcome {
        // Fetch the init segment (moov) and open the endless media pull — the backend is
        // unauthenticated, so both are plain GETs. The reader hands libavformat the init first, then
        // the media fragments.
        let init = match registry
            .blocking_client()
            .get(&fetched.prog_init_url)
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.bytes())
        {
            Ok(b) => b,
            Err(_) => {
                tracing::debug!(source_id = id, "failed to fetch init segment");

                return StreamOutcome::Failed;
            }
        };
        let media = match registry
            .blocking_client()
            .get(&fetched.prog_segment_url)
            .send()
            .and_then(|r| r.error_for_status())
        {
            Ok(r) => r,
            Err(_) => {
                tracing::debug!(source_id = id, "failed to open video stream");

                return StreamOutcome::Failed;
            }
        };

        let reader: Box<dyn Read + Send> =
            Box::new(std::io::Cursor::new(init.to_vec()).chain(media));
        let mut decoder = match mp4::Decoder::open(reader, decoder_running.clone()) {
            Ok(d) => d,
            Err(_) => {
                tracing::debug!(source_id = id, "failed to open video decoder");

                return StreamOutcome::Failed;
            }
        };

        *urls.write() = Some(fetched.clone());
        Self::set_status(status, id, SourceStatus::Streaming);

        // Metadata is fixed once the stream is open; the display name comes from the registry poll.
        let meta = decoder.metadata();
        let name = get_state()
            .ok()
            .and_then(|s| {
                s.read()
                    .sources_information
                    .get(&id)
                    .map(|i| i.name.clone())
            })
            .unwrap_or_default();

        let mut streamed = false;
        let mut on_frame = |frame: &mp4::RgbFrame| {
            // Announce metadata once per session, before the first frame.
            if !*announced {
                if let Ok(state) = get_state() {
                    state.read().trigger_metadata(
                        id,
                        &name,
                        meta.width as i32,
                        meta.height as i32,
                        meta.fps as i32,
                    );
                }
                *announced = true;
            }
            streamed = true;
            if let Ok(state) = get_state() {
                state.read().trigger_frames(
                    id,
                    frame.data,
                    frame.width as i32,
                    frame.height as i32,
                    frame.pts_90k,
                );
            }
        };

        if decoder.run(&mut on_frame).is_err() {
            tracing::debug!(source_id = id, "decode session ended with error");
        }
        drop(on_frame);

        if streamed {
            StreamOutcome::Progressed
        } else {
            StreamOutcome::Failed
        }
    }
}

// Status, queue, and registry helpers
impl SourceProcessor {
    /// Enqueue a result set for the results worker (drop-oldest at capacity).
    pub fn push_results(&self, input: PostResultsInput) {
        self.results_sender.send(input);
    }

    pub fn status(&self) -> SourceStatus {
        SourceStatus::from_int(self.status.load(Ordering::Relaxed))
    }

    /// Write a status transition, firing `SourceStatusCB` only on change.
    fn set_status(status: &AtomicI32, id: u32, new: SourceStatus) {
        if status.swap(new as i32, Ordering::Relaxed) != new as i32 {
            if let Ok(state) = get_state() {
                state.read().trigger_status(id, new as i32);
            }
        }
    }
}

impl Drop for SourceProcessor {
    fn drop(&mut self) {
        self.decoder_running.store(false, Ordering::Relaxed);
        if let Some(task) = self.supervisor_task.take() {
            task.abort();
        }
        if let Some(task) = self.results_task.take() {
            task.abort();
        }
        Self::set_status(&self.status, self.id, SourceStatus::Terminating);
    }
}
