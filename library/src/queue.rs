//! Bounded async queue, ringbuffer on overflow: oldest is dropped to make
//! room for the newest. Matches library/src/queue.rs semantically.

use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::{Mutex, Notify};

use anyhow::{bail, Result};

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
        match self.queue.try_lock() {
            Ok(mut q) => {
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
            Err(_) => bail!("queue lock contended"),
        }
    }

    #[allow(dead_code)]
    pub async fn send_async(&self, item: T) {
        let mut q = self.queue.lock().await;
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
            let mut q = self.queue.lock().await;
            if let Some(item) = q.pop_front() { return Some(item); }
            let notified = self.notify.notified();
            drop(q);
            notified.await;
        }
    }
}
