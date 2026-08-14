//! Process-global state: host callbacks, settings, the online/offline view of
//! sources, and the running source workers. One `State` behind
//! `Arc<RwLock<State>>` in a `OnceLock`; initialize with [`init_state`] and
//! reach it via [`get_state`].

use std::collections::HashMap;
use std::os::raw::{c_char, c_int, c_longlong, c_uint};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{Context, Result};
use parking_lot::RwLock;

use crate::source::{PostResultsInput, SourceProcessor};
use crate::utils::logger::Logger;
use crate::utils::registry_api::{B2BCredentials, Registry, SourceInformation};

// The backend URL is cooked in at build time (env! → compile-time). Set B2B_URL in the environment
// before building. This backend has NO authentication and NO path prefix — the value is the bare
// origin, e.g. http://127.0.0.1:8702.
const B2B_URL: &str = env!("B2B_URL");

// Callback function types (registered via SetCallbacks)
pub type SourceFramesCB = extern "C" fn(
    source_id: c_uint,
    frame: *const u8,
    width: c_int,
    height: c_int,
    pts: c_longlong,
);

pub type SourceMetadataCB = extern "C" fn(
    source_id: c_uint,
    source_name: *const c_char,
    width: c_int,
    height: c_int,
    fps: c_int,
);

pub type SourceStatusCB = extern "C" fn(source_id: c_uint, status: c_int);

pub type PostResultsCB = extern "C" fn(
    source_id: c_uint,
    results_count: c_int,
    results_ids: *const *const c_char,
    results_timestamps: *const c_longlong,
);

#[derive(Debug, Clone, Copy)]
pub struct Callbacks {
    pub source_frames: SourceFramesCB,
    pub source_metadata: SourceMetadataCB,
    pub source_status: SourceStatusCB,
    pub post_results: PostResultsCB,
}

// Settings
#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunMode {
    Regular = 0,
    Debug = 1,
}

impl RunMode {
    pub fn from_int(value: c_int) -> RunMode {
        match value {
            1 => RunMode::Debug,
            _ => RunMode::Regular,
        }
    }

    pub fn log_level(self) -> String {
        const CRATE: &str = env!("CARGO_CRATE_NAME");

        match self {
            RunMode::Regular => format!("info,{CRATE}=info"),
            RunMode::Debug => format!("info,{CRATE}=debug"),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Settings {
    pub run_mode: RunMode,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            run_mode: RunMode::Regular,
        }
    }
}

// State
pub struct State {
    runtime: tokio::runtime::Runtime,
    logger: Logger,
    credentials: B2BCredentials,
    registry_api: Registry,
    pub callbacks: Option<Callbacks>,
    pub settings: Settings,
    information_thread: Option<tokio::task::JoinHandle<()>>,
    /// Latest online/offline view of the backend's sources (keyed by id).
    pub sources_information: HashMap<u32, SourceInformation>,
    /// Running workers, inner-locked so a source can be added/removed under a
    /// State *read* lock.
    source_processors: RwLock<HashMap<u32, SourceProcessor>>,
}

impl State {
    /// Build the tokio runtime and HTTP layer.
    pub fn new() -> Result<Self> {
        let settings = Settings::default();
        let logger = Logger::init(settings.run_mode);
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .context("build tokio runtime")?;
        let credentials = B2BCredentials {
            url: B2B_URL.to_string(),
        };
        let registry_api =
            Registry::new(credentials.clone()).context("build registry HTTP layer")?;
        Ok(Self {
            runtime,
            logger,
            credentials,
            registry_api,
            callbacks: None,
            settings,
            information_thread: None,
            sources_information: HashMap::new(),
            source_processors: RwLock::new(HashMap::new()),
        })
    }

    /// Start the background work: poll the backend every 5 s and refresh
    /// `sources_information`. Called by `init_state` once the state is global,
    /// so `get_state` is always live here.
    fn run() {
        let Ok(state) = get_state() else {
            return;
        };
        let handle = state.read().runtime().clone();
        let task = handle.spawn(async move {
            let Ok(state) = get_state() else {
                return;
            };
            let registry = state.read().registry();
            let mut ticker = tokio::time::interval(Duration::from_secs(5));
            loop {
                ticker.tick().await;
                match registry.sources_information().await {
                    Ok(list) => {
                        let map: HashMap<u32, SourceInformation> =
                            list.into_iter().map(|s| (s.id, s)).collect();
                        state.write().sources_information = map;
                    }
                    Err(_) => {
                        tracing::debug!("failed to fetch sources information from registry");
                    }
                }
            }
        });
        state.write().information_thread = Some(task);
    }

    pub fn runtime(&self) -> &tokio::runtime::Handle {
        self.runtime.handle()
    }

    pub fn registry(&self) -> Registry {
        self.registry_api.clone()
    }

    pub fn callbacks(&self) -> Option<&Callbacks> {
        self.callbacks.as_ref()
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    pub fn set_callbacks(&mut self, callbacks: Callbacks) {
        self.callbacks = Some(callbacks);
    }

    pub fn set_settings(&mut self, settings: Settings) {
        self.settings = settings;
        self.logger.set_run_mode(settings.run_mode);
    }

    pub fn has_source(&self, id: u32) -> bool {
        self.source_processors.read().contains_key(&id)
    }

    pub fn insert_source(&self, id: u32, processor: SourceProcessor) {
        self.source_processors.write().insert(id, processor);
    }

    pub fn remove_source(&self, id: u32) -> Option<SourceProcessor> {
        self.source_processors.write().remove(&id)
    }

    /// Enqueue a result set on the source's results worker. False if the source
    /// isn't initialized.
    pub fn push_results(&self, source_id: u32, input: PostResultsInput) -> bool {
        match self.source_processors.read().get(&source_id) {
            Some(processor) => {
                processor.push_results(input);
                true
            }
            None => false,
        }
    }
}

/// Convert Rust data to C and invoke the host callbacks. No-op if unregistered.
impl State {
    pub fn trigger_frames(&self, source_id: u32, rgb: &[u8], width: i32, height: i32, pts: i64) {
        if let Some(cb) = self.callbacks {
            (cb.source_frames)(source_id, rgb.as_ptr(), width, height, pts);
        }
    }

    pub fn trigger_metadata(&self, source_id: u32, name: &str, width: i32, height: i32, fps: i32) {
        if let Some(cb) = self.callbacks {
            // The name pointer is handed to the host to free via FreeCPtr.
            (cb.source_metadata)(
                source_id,
                crate::utils::alloc_c_string(name),
                width,
                height,
                fps,
            );
        }
    }

    pub fn trigger_status(&self, source_id: u32, status: i32) {
        if let Some(cb) = self.callbacks {
            (cb.source_status)(source_id, status);
        }
    }

    pub fn trigger_results(&self, source_id: u32, ids: &[String], timestamps: &[i64]) {
        let Some(cb) = self.callbacks else {
            return;
        };
        let id_ptrs: Vec<*const c_char> = ids
            .iter()
            .map(|s| crate::utils::alloc_c_string(s) as *const c_char)
            .collect();
        (cb.post_results)(
            source_id,
            ids.len() as c_int,
            crate::utils::alloc_ptr_array(&id_ptrs),
            crate::utils::alloc_i64_array(timestamps),
        );
    }
}

// Global singleton + bootstrap
static STATE: OnceLock<Arc<RwLock<State>>> = OnceLock::new();

/// Build the global state and start its background work. Idempotent: a repeat
/// call, or a concurrent one that loses the `set` race, is a no-op (the losing
/// `State` — and its runtime — is dropped without ever starting the poller).
pub fn init_state() -> Result<()> {
    if STATE.get().is_some() {
        return Ok(());
    }
    let state = State::new()?;
    if STATE.set(Arc::new(RwLock::new(state))).is_ok() {
        State::run();
    }
    Ok(())
}

pub fn get_state() -> Result<Arc<RwLock<State>>> {
    match STATE.get() {
        Some(state) => Ok(state.clone()),
        None => anyhow::bail!("State not initiated"),
    }
}
