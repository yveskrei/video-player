//! Logging setup: a JSON subscriber over stdout with a verbosity filter that can
//! be swapped at runtime.

use tracing_subscriber::{
    fmt, layer::SubscriberExt, reload, util::SubscriberInitExt, EnvFilter, Registry,
};


// Custom modules
use crate::state::RunMode;

// Variables
type FilterHandle = reload::Handle<EnvFilter, Registry>;

/// Owns the runtime filter handle. Held by `State`, so it lives for the process.
pub struct Logger {
    filter: FilterHandle,
}

impl Logger {
    /// Install the global subscriber (JSON to stdout). No-op install if the host
    /// already set a subscriber — never panics.
    pub fn init(mode: RunMode) -> Self {
        let (filter_layer, filter) = reload::Layer::new(Self::build_filter(mode));

        let console = fmt::layer()
            .json()
            .with_timer(fmt::time::UtcTime::rfc_3339())
            .with_writer(std::io::stdout);

        let _ = tracing_subscriber::registry()
            .with(filter_layer)
            .with(console)
            .try_init();

        Self { filter }
    }

    /// Switch verbosity at runtime; takes effect on the next event.
    pub fn set_run_mode(&self, mode: RunMode) {
        if let Err(e) = self.filter.reload(Self::build_filter(mode)) {
            // Logging itself is broken, so report on stderr directly.
            eprintln!("failed to apply run mode {mode:?}: {e}");
        }
    }

    /// `RUST_LOG`, if set, is appended so it wins on any target it names.
    fn build_filter(mode: RunMode) -> EnvFilter {
        let mut directives = mode.log_level();
        
        if let Ok(env) = std::env::var("RUST_LOG") {
            if !env.trim().is_empty() {
                directives.push(',');
                directives.push_str(&env);
            }
        }
        EnvFilter::builder().parse_lossy(directives)
    }
}
