//! Safe RAII wrappers over `ffmpeg-sys-next` — the only module that touches raw
//! FFI / `unsafe`. Each wrapper owns exactly one resource and frees it in `Drop`.
//! `Demuxer` reads a valid fMP4 via libavformat over a custom AVIO fed by the
//! host's byte reader; `CodecContext` + `Packet` + `Frame` + the YUV→RGB24
//! scaler decode it. No encode/mux path (decode-only build).

use std::io::Read;
use std::os::raw::{c_int, c_void};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Once};

use anyhow::{Context, Result};
use ffmpeg_sys_next as ffi;

fn check(op: &'static str, code: c_int) -> Result<c_int> {
    if code < 0 {
        Err(anyhow::anyhow!("{op} failed (code {code})"))
    } else {
        Ok(code)
    }
}

#[inline]
fn eagain() -> c_int {
    ffi::AVERROR(libc::EAGAIN)
}

fn rational(num: c_int, den: c_int) -> ffi::AVRational {
    ffi::AVRational { num, den }
}

// One-time init
static INIT: Once = Once::new();

/// Idempotent global FFmpeg setup; keeps libav* quiet since we surface errors via `Result`.
pub fn init() {
    INIT.call_once(|| unsafe {
        ffi::av_log_set_level(ffi::AV_LOG_ERROR as c_int);
    });
}

// Codec selection
/// The decoders our static FFmpeg build enables.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Codec {
    H264,
    Hevc,
}

/// Outcome of `avcodec_receive_*`, as a value instead of an errno.
pub enum Receive {
    Got,
    Again,
    Eof,
}

// Packet
pub struct Packet {
    ptr: *mut ffi::AVPacket,
}

// SAFETY: single-owner AVPacket, moved (never shared) with its context.
unsafe impl Send for Packet {}

impl Packet {
    pub fn new() -> Result<Self> {
        let ptr = unsafe {
            ffi::av_packet_alloc()
        };
        if ptr.is_null() {
            anyhow::bail!("av_packet_alloc returned null");
        }
        Ok(Self { ptr })
    }

    /// Replace the payload with a fresh padded copy of `data` and stamp its timing.
    pub fn set(&mut self, data: &[u8], pts: i64, dur: i64) -> Result<()> {
        // SAFETY: valid AVPacket; av_new_packet buffer is fully overwritten by the copy.
        unsafe {
            ffi::av_packet_unref(self.ptr);
            check("av_new_packet", ffi::av_new_packet(self.ptr, data.len() as c_int))?;
            ptr::copy_nonoverlapping(
                data.as_ptr(),
                (*self.ptr).data,
                data.len(),
            );
            (*self.ptr).pts = pts;
            (*self.ptr).dts = pts;
            (*self.ptr).duration = dur;
        }
        Ok(())
    }
}

impl Drop for Packet {
    fn drop(&mut self) {
        // SAFETY: ptr was allocated by av_packet_alloc and is freed exactly once.
        unsafe {
            let mut p = self.ptr;
            ffi::av_packet_free(&mut p);
        }
    }
}

// Frame
pub struct Frame {
    ptr: *mut ffi::AVFrame,
}

// SAFETY: single-owner, moved together with its context. Never shared.
unsafe impl Send for Frame {}

impl Frame {
    pub fn new() -> Result<Self> {
        let ptr = unsafe {
            ffi::av_frame_alloc()
        };
        if ptr.is_null() {
            anyhow::bail!("av_frame_alloc returned null");
        }
        Ok(Self { ptr })
    }

    pub fn width(&self) -> i32 {
        unsafe {
            (*self.ptr).width
        }
    }

    pub fn height(&self) -> i32 {
        unsafe {
            (*self.ptr).height
        }
    }

    pub fn pts(&self) -> i64 {
        unsafe {
            (*self.ptr).pts
        }
    }

    /// True if libavcodec flagged this frame as damaged; drives the keyframe resync.
    pub fn corrupt(&self) -> bool {
        // SAFETY: valid AVFrame for the life of self.
        unsafe {
            (*self.ptr).decode_error_flags != 0
        }
    }

    fn unref(&mut self) {
        unsafe {
            ffi::av_frame_unref(self.ptr)
        }
    }
}

impl Drop for Frame {
    fn drop(&mut self) {
        // SAFETY: ptr came from av_frame_alloc; freed once.
        unsafe {
            let mut f = self.ptr;
            ffi::av_frame_free(&mut f);
        }
    }
}

// SwsScaler — convert between a source format and a destination format
struct SwsScaler {
    ptr: *mut ffi::SwsContext,
    src_w: i32,
    src_h: i32,
    src_fmt: c_int,
    dst_fmt: ffi::AVPixelFormat,
    scratch: *mut ffi::AVFrame, // holds dst plane pointers
    dst_size: usize,
}

impl SwsScaler {
    /// SAFETY: `src_fmt`/`w`/`h` must match the frames passed to `scale`.
    unsafe fn new(
        w: i32,
        h: i32,
        src_fmt: ffi::AVPixelFormat,
        dst_fmt: ffi::AVPixelFormat,
    ) -> Result<Self> {
        unsafe {
            let ptr = ffi::sws_getContext(
                w, h, src_fmt, w, h, dst_fmt,
                ffi::SWS_BILINEAR as c_int,
                ptr::null_mut(), ptr::null_mut(), ptr::null(),
            );
            if ptr.is_null() {
                anyhow::bail!("sws_getContext returned null");
            }
            let scratch = ffi::av_frame_alloc();
            if scratch.is_null() {
                ffi::sws_freeContext(ptr);
                anyhow::bail!("av_frame_alloc(sws) returned null");
            }
            let dst_size = ffi::av_image_get_buffer_size(
                dst_fmt,
                w,
                h,
                1,
            ) as usize;
            Ok(Self {
                ptr,
                src_w: w,
                src_h: h,
                src_fmt: src_fmt as c_int,
                dst_fmt,
                scratch,
                dst_size,
            })
        }
    }

    /// Scale a decoded `Frame` into a freshly-allocated tightly-packed buffer.
    /// SAFETY: `frame` must match this scaler's dimensions/format.
    unsafe fn scale_from_frame(&mut self, frame: &Frame) -> Result<Vec<u8>> {
        let mut buf = vec![0u8; self.dst_size];
        unsafe {
            ffi::av_frame_unref(self.scratch);
            check(
                "av_image_fill_arrays",
                ffi::av_image_fill_arrays(
                    (*self.scratch).data.as_mut_ptr(),
                    (*self.scratch).linesize.as_mut_ptr(),
                    buf.as_mut_ptr(),
                    self.dst_fmt,
                    self.src_w,
                    self.src_h,
                    1,
                ),
            )?;
            let got = ffi::sws_scale(
                self.ptr,
                (*frame.ptr).data.as_ptr() as *const *const u8,
                (*frame.ptr).linesize.as_ptr(),
                0,
                self.src_h,
                (*self.scratch).data.as_mut_ptr(),
                (*self.scratch).linesize.as_ptr(),
            );
            if got <= 0 {
                anyhow::bail!("sws_scale failed (code {got})");
            }
        }
        Ok(buf)
    }

}

impl Drop for SwsScaler {
    fn drop(&mut self) {
        // SAFETY: both pointers were allocated here and are freed once.
        unsafe {
            if !self.scratch.is_null() {
                let mut f = self.scratch;
                ffi::av_frame_free(&mut f);
            }
            if !self.ptr.is_null() {
                ffi::sws_freeContext(self.ptr);
            }
        }
    }
}

// CodecContext — the decoder + a lazily (re)built RGB scaler
pub struct CodecContext {
    ptr: *mut ffi::AVCodecContext,
    scaler: Option<SwsScaler>,
}

// SAFETY: single-owner; never shared (no Sync).
unsafe impl Send for CodecContext {}

impl CodecContext {
    /// Open a decoder from the demuxer's `AVCodecParameters` (extradata = `avcC`/`hvcC`), so libavcodec
    /// decodes native length-prefixed AVCC — no Annex-B rewrite. Unsupported codec → clean error.
    ///
    /// # Safety
    /// `par` must point to valid codec parameters (the demuxer's video stream) live for this call.
    pub unsafe fn open(par: *const ffi::AVCodecParameters) -> Result<Self> {
        init();
        // SAFETY: par is valid per the contract; `ctx` owns the context so any `?` frees it.
        unsafe {
            let id = (*par).codec_id;
            let decoder = ffi::avcodec_find_decoder(id);
            if decoder.is_null() {
                anyhow::bail!("no decoder for codec id {}", id as i32);
            }
            let ptr = ffi::avcodec_alloc_context3(decoder);
            if ptr.is_null() {
                anyhow::bail!("avcodec_alloc_context3 returned null");
            }
            let ctx = Self { ptr, scaler: None };
            check(
                "avcodec_parameters_to_context",
                ffi::avcodec_parameters_to_context(ptr, par),
            )?;
            check(
                "avcodec_open2",
                ffi::avcodec_open2(ptr, decoder, ptr::null_mut()),
            )?;
            Ok(ctx)
        }
    }

    /// Queue a packet. A full decoder (`EAGAIN`) is not an error.
    pub fn send(&mut self, pkt: &Packet) -> Result<()> {
        let ret = unsafe {
            ffi::avcodec_send_packet(self.ptr, pkt.ptr)
        };
        if ret == 0 || ret == eagain() {
            Ok(())
        } else {
            check("avcodec_send_packet", ret).map(|_| ())
        }
    }

    /// Drop buffered decoder state (used to resync after a discontinuity).
    pub fn flush(&mut self) {
        unsafe {
            ffi::avcodec_flush_buffers(self.ptr)
        }
    }

    /// Pull one decoded frame, if available.
    pub fn receive(&mut self, frame: &mut Frame) -> Result<Receive> {
        frame.unref();
        let ret = unsafe {
            ffi::avcodec_receive_frame(self.ptr, frame.ptr)
        };
        if ret == 0 {
            Ok(Receive::Got)
        } else if ret == eagain() {
            Ok(Receive::Again)
        } else if ret == ffi::AVERROR_EOF {
            Ok(Receive::Eof)
        } else {
            Err(anyhow::anyhow!("avcodec_receive_frame failed (code {ret})"))
        }
    }

    /// Convert a decoded frame to tightly-packed RGB24, rebuilding the scaler on a dim/format change.
    pub fn frame_to_rgb(&mut self, frame: &Frame) -> Result<Vec<u8>> {
        let (w, h) = (frame.width(), frame.height());
        if w <= 0 || h <= 0 {
            anyhow::bail!("invalid frame dimensions {w}x{h}");
        }
        // SAFETY: reading pix_fmt from an open context is valid.
        let fmt = unsafe {
            (*self.ptr).pix_fmt
        };
        let stale = match &self.scaler {
            None => true,
            Some(s) => s.src_w != w || s.src_h != h || s.src_fmt != fmt as c_int,
        };
        let scaler = if stale {
            // SAFETY: fmt/w/h are the current frame's actual format/dimensions.
            let s = unsafe {
                SwsScaler::new(
                    w,
                    h,
                    fmt,
                    ffi::AVPixelFormat::AV_PIX_FMT_RGB24,
                )?
            };
            self.scaler.insert(s)
        } else {
            self.scaler.as_mut().context("scaler not initialized")?
        };
        // SAFETY: scaler matches this frame.
        unsafe {
            scaler.scale_from_frame(frame)
        }
    }
}

impl Drop for CodecContext {
    fn drop(&mut self) {
        // SAFETY: ptr came from avcodec_alloc_context3; freed once (also frees extradata).
        unsafe {
            if !self.ptr.is_null() {
                let mut c = self.ptr;
                ffi::avcodec_free_context(&mut c);
            }
        }
    }
}

// Demuxer — libavformat reading a valid fMP4 over a custom AVIO fed by a host byte reader.

/// The reader libavformat pulls from, plus the run flag that lets a stop request interrupt it. Boxed and
/// handed to `avio_alloc_context` as `opaque`; freed with the `Demuxer`.
struct ReaderState {
    reader: Box<dyn Read + Send>,
    running: Arc<AtomicBool>,
}

/// AVIO read callback. Drains the Rust reader into libavformat's buffer; returns `AVERROR_EOF` on
/// end-of-stream, a read error, or once the run flag clears (so a stop unwinds `av_read_frame` cleanly).
/// Panic-guarded — a callback must never unwind across the C boundary.
unsafe extern "C" fn read_packet(opaque: *mut c_void, buf: *mut u8, buf_size: c_int) -> c_int {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if buf_size <= 0 || buf.is_null() || opaque.is_null() {
            return ffi::AVERROR_EOF;
        }
        // SAFETY: opaque is the ReaderState we passed to avio_alloc_context; buf/buf_size are the
        // libavformat-owned scratch buffer, valid for this call.
        let state = unsafe { &mut *(opaque as *mut ReaderState) };
        if !state.running.load(Ordering::Relaxed) {
            return ffi::AVERROR_EOF;
        }
        let slice = unsafe { std::slice::from_raw_parts_mut(buf, buf_size as usize) };
        match state.reader.read(slice) {
            Ok(0) => ffi::AVERROR_EOF,
            Ok(n) => n as c_int,
            Err(_) => ffi::AVERROR_EOF,
        }
    }));
    result.unwrap_or(ffi::AVERROR_EOF)
}

/// Outcome of reading one packet.
pub enum ReadOutcome {
    Video,
    Skip,
    Eof,
}

pub struct Demuxer {
    fmt: *mut ffi::AVFormatContext,
    avio: *mut ffi::AVIOContext,
    reader_state: *mut ReaderState,
    video_index: c_int,
    time_base: ffi::AVRational,
    par: *mut ffi::AVCodecParameters,
    codec: Codec,
    width: i32,
    height: i32,
    fps: f64,
}

// SAFETY: single-owner; the raw FFmpeg pointers and the boxed reader move with it and are never shared.
unsafe impl Send for Demuxer {}

impl Demuxer {
    const AVIO_BUF: usize = 64 * 1024;

    /// Open a demuxer over a byte reader that yields the init segment then the endless media. libavformat
    /// probes the `mov` format and reads the moov/moof boxes; the video stream's `codecpar` is exposed for
    /// the decoder. Every failure frees exactly what was allocated so far.
    pub fn open(reader: Box<dyn Read + Send>, running: Arc<AtomicBool>) -> Result<Self> {
        init();
        // SAFETY: standard custom-AVIO libavformat setup.
        unsafe {
            let avio_buf = ffi::av_malloc(Self::AVIO_BUF) as *mut u8;
            if avio_buf.is_null() {
                anyhow::bail!("av_malloc(avio) returned null");
            }
            let reader_state = Box::into_raw(Box::new(ReaderState { reader, running }));

            let avio = ffi::avio_alloc_context(
                avio_buf,
                Self::AVIO_BUF as c_int,
                0,
                reader_state as *mut c_void,
                Some(read_packet),
                None,
                None,
            );
            if avio.is_null() {
                ffi::av_free(avio_buf as *mut c_void);
                drop(Box::from_raw(reader_state));
                anyhow::bail!("avio_alloc_context returned null");
            }

            let fmt = ffi::avformat_alloc_context();
            if fmt.is_null() {
                Self::free_avio(avio);
                drop(Box::from_raw(reader_state));
                anyhow::bail!("avformat_alloc_context returned null");
            }
            (*fmt).pb = avio;
            (*fmt).flags |= ffi::AVFMT_FLAG_CUSTOM_IO as c_int;

            let mut opened = fmt;
            let ret = ffi::avformat_open_input(
                &mut opened,
                ptr::null(),
                ptr::null(),
                ptr::null_mut(),
            );
            if ret < 0 {
                // avformat_open_input freed the context but not our custom pb.
                Self::free_avio(avio);
                drop(Box::from_raw(reader_state));
                anyhow::bail!("avformat_open_input failed (code {ret})");
            }

            // From here `this` owns everything, so any `?`/bail below frees it all via Drop.
            let mut this = Self {
                fmt: opened,
                avio,
                reader_state,
                video_index: -1,
                time_base: rational(1, 90_000),
                par: ptr::null_mut(),
                codec: Codec::H264,
                width: 0,
                height: 0,
                fps: 0.0,
            };

            check(
                "avformat_find_stream_info",
                ffi::avformat_find_stream_info(this.fmt, ptr::null_mut()),
            )?;

            let idx = ffi::av_find_best_stream(
                this.fmt,
                ffi::AVMediaType::AVMEDIA_TYPE_VIDEO,
                -1,
                -1,
                ptr::null_mut(),
                0,
            );
            if idx < 0 {
                anyhow::bail!("no video stream in progressive input");
            }
            let st = *(*this.fmt).streams.add(idx as usize);
            let par = (*st).codecpar;
            let codec = match (*par).codec_id {
                ffi::AVCodecID::AV_CODEC_ID_H264 => Codec::H264,
                ffi::AVCodecID::AV_CODEC_ID_HEVC => Codec::Hevc,
                other => anyhow::bail!("unsupported video codec id {}", other as i32),
            };
            let guessed = ffi::av_guess_frame_rate(this.fmt, st, ptr::null_mut());
            let fps = Self::rate_to_f64(guessed).or_else(|| Self::rate_to_f64((*st).avg_frame_rate)).unwrap_or(0.0);

            this.video_index = idx;
            this.par = par;
            this.codec = codec;
            this.width = (*par).width;
            this.height = (*par).height;
            this.fps = fps;
            this.time_base = (*st).time_base;
            Ok(this)
        }
    }

    fn rate_to_f64(r: ffi::AVRational) -> Option<f64> {
        if r.num > 0 && r.den > 0 {
            Some(r.num as f64 / r.den as f64)
        } else {
            None
        }
    }

    /// Free the custom AVIO and its (possibly-reallocated) buffer.
    /// SAFETY: `avio` came from `avio_alloc_context` and is freed once.
    unsafe fn free_avio(avio: *mut ffi::AVIOContext) {
        unsafe {
            ffi::av_freep(&mut (*avio).buffer as *mut _ as *mut c_void);
            let mut a = avio;
            ffi::avio_context_free(&mut a);
        }
    }

    pub fn codec(&self) -> Codec {
        self.codec
    }

    pub fn width(&self) -> i32 {
        self.width
    }

    pub fn height(&self) -> i32 {
        self.height
    }

    pub fn fps(&self) -> f64 {
        self.fps
    }

    /// The video stream's codec parameters, for [`CodecContext::open`]. Valid while `self` lives.
    pub fn codecpar(&self) -> *const ffi::AVCodecParameters {
        self.par
    }

    /// Read the next packet into `pkt`: `Video` for the video stream, `Skip` otherwise, `Eof` at end/stop.
    pub fn read(&mut self, pkt: &mut Packet) -> Result<ReadOutcome> {
        // SAFETY: fmt is a live input context; pkt is our owned packet.
        unsafe {
            ffi::av_packet_unref(pkt.ptr);
            let ret = ffi::av_read_frame(self.fmt, pkt.ptr);
            if ret == ffi::AVERROR_EOF {
                return Ok(ReadOutcome::Eof);
            }
            if ret < 0 {
                anyhow::bail!("av_read_frame failed (code {ret})");
            }
            if (*pkt.ptr).stream_index != self.video_index {
                return Ok(ReadOutcome::Skip);
            }
            Ok(ReadOutcome::Video)
        }
    }

    /// True if `pkt` is a keyframe (drives the resync gate).
    pub fn is_key(&self, pkt: &Packet) -> bool {
        // SAFETY: pkt is a valid packet.
        unsafe { (*pkt.ptr).flags & ffi::AV_PKT_FLAG_KEY != 0 }
    }

    /// Rescale a stream-time-base pts to the 90 kHz the backend expects.
    pub fn rescale_90k(&self, pts: i64) -> i64 {
        // SAFETY: pure arithmetic.
        unsafe { ffi::av_rescale_q(pts, self.time_base, rational(1, 90_000)) }
    }
}

impl Drop for Demuxer {
    fn drop(&mut self) {
        // SAFETY: close the input (leaves the custom pb intact), then free the AVIO + its buffer and the
        // boxed reader — each exactly once.
        unsafe {
            if !self.fmt.is_null() {
                let mut f = self.fmt;
                ffi::avformat_close_input(&mut f);
            }
            if !self.avio.is_null() {
                Self::free_avio(self.avio);
            }
            if !self.reader_state.is_null() {
                drop(Box::from_raw(self.reader_state));
            }
        }
    }
}
