//! Shared singleton owning the tokio runtime, player proxy, active sources and callbacks.

use std::collections::HashMap;
use std::sync::{Arc, Once};

use anyhow::{Context, Result};
use parking_lot::RwLock;
use tokio::runtime::Runtime;
use tokio::sync::OnceCell;
use tracing_subscriber::prelude::*;
use tracing_subscriber::{fmt, EnvFilter};

use crate::callbacks::Callbacks;
use crate::player_api::PlayerApi;
use crate::source::Source;

static STATE: OnceCell<Arc<State>> = OnceCell::const_new();
static SERVICES_INIT: Once = Once::new();

pub struct State {
    player_api: Arc<PlayerApi>,
    streams: RwLock<HashMap<String, Arc<Source>>>,
    callbacks: RwLock<Option<Callbacks>>,
    runtime: Runtime,
}

impl State {
    pub fn new() -> Result<Self> {
        init_services();
        let runtime = Runtime::new().context("building tokio runtime")?;
        let player_api = PlayerApi::new().context("building player api")?;
        Ok(Self {
            player_api: Arc::new(player_api),
            streams: RwLock::new(HashMap::new()),
            callbacks: RwLock::new(None),
            runtime,
        })
    }
}

impl State {
    pub fn set_callbacks(&self, callbacks: Callbacks) {
        *self.callbacks.write() = Some(callbacks);
    }

    pub fn insert_source(&self, source: Arc<Source>) {
        let key = source.source_id().to_string();
        self.streams.write().insert(key, source);
    }

    pub fn remove_source(&self, source_id: i32) -> Option<Arc<Source>> {
        self.streams.write().remove(&source_id.to_string())
    }

    pub fn has_source(&self, source_id: i32) -> bool {
        self.streams.read().contains_key(&source_id.to_string())
    }

    pub fn source_by_id(&self, source_id: i32) -> Option<Arc<Source>> {
        self.streams
            .read()
            .get(&source_id.to_string())
            .map(Arc::clone)
    }
}

impl State {
    pub fn player_api(&self) -> &Arc<PlayerApi> {
        &self.player_api
    }

    pub fn callbacks(&self) -> Option<Callbacks> {
        *self.callbacks.read()
    }

    pub fn runtime(&self) -> &Runtime {
        &self.runtime
    }
}

fn init_services() {
    SERVICES_INIT.call_once(|| {
        let filter = EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("ffi_library=info,warn"));
        let _ = tracing_subscriber::registry()
            .with(filter)
            .with(
                fmt::layer()
                    .json()
                    .with_target(true)
                    .with_current_span(false),
            )
            .try_init();
        let _ = ffmpeg_next::init();
    });
}

pub fn get_state() -> Result<Arc<State>> {
    if let Some(s) = STATE.get() {
        return Ok(Arc::clone(s));
    }
    let state = Arc::new(State::new().context("initialising State")?);
    match STATE.set(Arc::clone(&state)) {
        Ok(()) => Ok(state),
        Err(_) => STATE.get().cloned().context("state race"),
    }
}
