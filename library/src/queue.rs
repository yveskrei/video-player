//! Bounded queue with ringbuffer-on-overflow (oldest dropped to make room
//! for newest). Inner lock is `std::sync::Mutex` so synchronous callers
//! (the FFI `PostResults` entry point) can enqueue without an async
//! runtime and without ever failing on contention — the OS blocks on the
//! lock for the ~microsecond the async receiver holds it. The async
//! `recv` never `.await`s while holding the lock, so mixing std and tokio
//! primitives is safe here.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

use anyhow::{Context, Result};

type OnDrop<T> = Arc<dyn Fn(T) + Send + Sync>;

#[allow(dead_code)]
pub struct FixedSizeQueue<T> {
    queue: Arc<Mutex<VecDeque<T>>>,
    notify: Arc<Notify>,
    capacity: usize,
    on_drop: Option<OnDrop<T>>,
    pub sender: FixedSizeQueueSender<T>,
    pub receiver: FixedSizeQueueReceiver<T>,
}

impl<T> FixedSizeQueue<T> {
    pub fn new<F>(capacity: usize, on_drop: Option<F>) -> Self
    where
        F: Fn(T) + Send + Sync + 'static,
    {
        let queue = Arc::new(Mutex::new(VecDeque::with_capacity(capacity)));
        let notify = Arc::new(Notify::new());
        let on_drop_arc: Option<OnDrop<T>> = on_drop.map(|f| Arc::new(f) as OnDrop<T>);

        let sender = FixedSizeQueueSender {
            queue: Arc::clone(&queue),
            notify: Arc::clone(&notify),
            capacity,
            on_drop: on_drop_arc.clone(),
        };
        let receiver = FixedSizeQueueReceiver {
            queue: Arc::clone(&queue),
            notify: Arc::clone(&notify),
        };
        Self { queue, notify, capacity, on_drop: on_drop_arc, sender, receiver }
    }
}

pub struct FixedSizeQueueSender<T> {
    queue: Arc<Mutex<VecDeque<T>>>,
    notify: Arc<Notify>,
    capacity: usize,
    on_drop: Option<OnDrop<T>>,
}

impl<T> Clone for FixedSizeQueueSender<T> {
    fn clone(&self) -> Self {
        Self {
            queue: Arc::clone(&self.queue),
            notify: Arc::clone(&self.notify),
            capacity: self.capacity,
            on_drop: self.on_drop.clone(),
        }
    }
}

impl<T> FixedSizeQueueSender<T> {
    pub fn send_sync(&self, item: T) -> Result<()> {
        // Blocking acquire. The only error path is mutex poisoning — i.e.
        // another thread panicked while holding the lock — which we surface
        // so the caller can decide how to recover rather than hiding it.
        let mut q = self
            .queue
            .lock()
            .map_err(|_| anyhow::anyhow!("queue mutex poisoned"))
            .context("post queue send")?;
        if q.len() >= self.capacity {
            if let Some(dropped) = q.pop_front() {
                if let Some(cb) = self.on_drop.as_ref() { cb(dropped); }
            }
        }
        q.push_back(item);
        drop(q);
        self.notify.notify_one();
        Ok(())
    }

    #[allow(dead_code)]
    pub async fn send_async(&self, item: T) {
        let mut q = self.queue.lock().expect("queue mutex poisoned");
        if q.len() >= self.capacity {
            if let Some(dropped) = q.pop_front() {
                if let Some(cb) = self.on_drop.as_ref() { cb(dropped); }
            }
        }
        q.push_back(item);
        drop(q);
        self.notify.notify_one();
    }
}

pub struct FixedSizeQueueReceiver<T> {
    queue: Arc<Mutex<VecDeque<T>>>,
    notify: Arc<Notify>,
}

impl<T> FixedSizeQueueReceiver<T> {
    pub async fn recv(&self) -> Option<T> {
        loop {
            // Inner block ensures the lock guard is dropped before we `.await`
            // below. Holding a std::sync::MutexGuard across an await would
            // break the Send bound on this future; dropping it here keeps
            // the future Send and safely decouples the two primitives.
            {
                let mut q = self.queue.lock().expect("queue mutex poisoned");
                if let Some(item) = q.pop_front() {
                    return Some(item);
                }
            }
            self.notify.notified().await;
        }
    }
}
