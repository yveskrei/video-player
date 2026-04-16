//! Source lifecycle status. Values match the int the StatusCallback receives.

use std::sync::atomic::{AtomicI32, Ordering};

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
}

impl SourceStatusCell {
    pub fn get(&self) -> SourceStatus {
        SourceStatus::from_i32(self.0.load(Ordering::SeqCst))
    }
}
