//! `mp4` — the media engine façade.
//!
//! Turns a valid fMP4 progressive stream into RGB frames, hiding libavformat and
//! all FFmpeg/FFI behind a small API. The host owns network I/O: it hands in a
//! byte reader (init segment then the endless media) and receives RGB24 frames.

mod ffmpeg;

use std::io::Read;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use anyhow::{Context, Result};
use ffmpeg::{CodecContext, Demuxer, Frame, Packet, ReadOutcome, Receive};

/// Video codec carried by the stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Codec {
    H264,
    Hevc,
}

impl From<ffmpeg::Codec> for Codec {
    fn from(c: ffmpeg::Codec) -> Self {
        match c {
            ffmpeg::Codec::H264 => Codec::H264,
            ffmpeg::Codec::Hevc => Codec::Hevc,
        }
    }
}

/// Stream geometry, read from the demuxer once the stream is open.
#[derive(Debug, Clone, Copy)]
pub struct Metadata {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub codec: Codec,
}

/// One decoded frame, tightly-packed RGB24 (stride = `width*3`). The buffer is
/// borrowed — valid only for the duration of the `on_frame` callback.
pub struct RgbFrame<'a> {
    pub data: &'a [u8],
    pub width: u32,
    pub height: u32,
    /// Presentation timestamp in 90 kHz.
    pub pts_90k: i64,
}

/// A decode session over one progressive stream. Open it with a byte reader, then [`run`](Decoder::run)
/// pumps frames until the stream ends or a stop is requested. Resilient for 24/7 use — it resyncs to the
/// next keyframe on corruption and never tears itself down on a single bad frame.
pub struct Decoder {
    demux: Demuxer,
    codec: CodecContext,
    packet: Packet,
    frame: Frame,
    meta: Metadata,
    /// While true, drop everything until the next keyframe, then flush + go live.
    resync: bool,
}

impl Decoder {
    /// Open the demuxer over `reader` (init segment then endless media) and the decoder from its codec
    /// parameters. `running` lets a stop request interrupt the blocking pull — the demuxer's read callback
    /// returns EOF once it clears.
    pub fn open(reader: Box<dyn Read + Send>, running: Arc<AtomicBool>) -> Result<Self> {
        let demux = Demuxer::open(reader, running).context("open demuxer")?;
        // SAFETY: codecpar points into the demuxer's live video stream.
        let codec = unsafe { CodecContext::open(demux.codecpar()) }.context("open decoder")?;
        let meta = Metadata {
            width: demux.width().max(0) as u32,
            height: demux.height().max(0) as u32,
            fps: demux.fps(),
            codec: demux.codec().into(),
        };
        Ok(Self {
            demux,
            codec,
            packet: Packet::new()?,
            frame: Frame::new()?,
            meta,
            resync: true,
        })
    }

    /// Stream geometry, known once the stream is open.
    pub fn metadata(&self) -> Metadata {
        self.meta
    }

    /// Pump the stream, emitting each decoded RGB frame via `on_frame`, until the stream ends (EOF) or a
    /// stop is requested. Corruption resyncs to the next keyframe; it is never fatal on its own.
    pub fn run(&mut self, on_frame: &mut dyn FnMut(&RgbFrame)) -> Result<()> {
        loop {
            match self.demux.read(&mut self.packet)? {
                ReadOutcome::Eof => break,
                ReadOutcome::Skip => continue,
                ReadOutcome::Video => {}
            }

            // Resync gate: skip until a keyframe, then flush and go live.
            if self.resync {
                if !self.demux.is_key(&self.packet) {
                    continue;
                }
                self.resync = false;
                self.codec.flush();
            }

            if self.codec.send(&self.packet).is_err() {
                // Bad packet — flush and wait for the next keyframe.
                self.resync = true;
                self.codec.flush();
                continue;
            }

            loop {
                match self.codec.receive(&mut self.frame) {
                    Ok(Receive::Got) => {
                        if self.frame.corrupt() {
                            // Missing references / concealed error → resync.
                            self.resync = true;
                            continue;
                        }
                        let (w, h) = (self.frame.width(), self.frame.height());
                        let rgb = self.codec.frame_to_rgb(&self.frame).context("scale to rgb")?;
                        let f = RgbFrame {
                            data: &rgb,
                            width: w as u32,
                            height: h as u32,
                            pts_90k: self.demux.rescale_90k(self.frame.pts()),
                        };
                        on_frame(&f);
                    }
                    Ok(Receive::Again) | Ok(Receive::Eof) => break,
                    Err(_) => {
                        self.resync = true;
                        self.codec.flush();
                        break;
                    }
                }
            }
        }
        Ok(())
    }
}
