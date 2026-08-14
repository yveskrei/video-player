//! Bounded MPSC queue: a sync `send` that drops the oldest item at capacity, and
//! an async `recv`. Feeds a single async worker from a sync producer.

use std::collections::VecDeque;
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::sync::Notify;

pub struct FixedSizeQueue<T> {
    pub sender: FixedSizeQueueSender<T>,
    pub receiver: FixedSizeQueueReceiver<T>,
}

impl<T> FixedSizeQueue<T> {
    pub fn new(capacity: usize) -> Self {
        let queue = Arc::new(Mutex::new(VecDeque::with_capacity(capacity)));
        let notify = Arc::new(Notify::new());
        let sender = FixedSizeQueueSender {
            queue: Arc::clone(&queue),
            notify: Arc::clone(&notify),
            capacity: capacity.max(1),
        };
        let receiver = FixedSizeQueueReceiver {
            queue,
            notify,
        };
        Self {
            sender,
            receiver,
        }
    }
}

pub struct FixedSizeQueueSender<T> {
    queue: Arc<Mutex<VecDeque<T>>>,
    notify: Arc<Notify>,
    capacity: usize,
}

impl<T> FixedSizeQueueSender<T> {
    /// Enqueue, evicting the oldest item if already at capacity. Infallible, so a
    /// sync FFI caller never has to handle a "full" error.
    pub fn send(&self, item: T) {
        let mut queue = self.queue.lock();
        if queue.len() >= self.capacity {
            queue.pop_front();
        }
        queue.push_back(item);
        drop(queue);
        self.notify.notify_one();
    }
}

pub struct FixedSizeQueueReceiver<T> {
    queue: Arc<Mutex<VecDeque<T>>>,
    notify: Arc<Notify>,
}

impl<T> FixedSizeQueueReceiver<T> {
    /// Pop the oldest item, awaiting until one is available. `Notify` retains a
    /// permit if a send races the wait, so a wakeup is never lost.
    pub async fn recv(&self) -> T {
        loop {
            {
                let mut queue = self.queue.lock();
                if let Some(item) = queue.pop_front() {
                    return item;
                }
            }
            self.notify.notified().await;
        }
    }
}
