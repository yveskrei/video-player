//! Custom-AVIO fragmented-MP4 decoder. Consumes a cached progressive init
//! segment followed by a long-lived HTTP pull and emits RGB24 frames.

use std::ffi::CStr;
use std::io::Read;
use std::os::raw::{c_int, c_void};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use ffmpeg_next::ffi as ff;

use crate::config::PTS_TIMEBASE;

pub struct DecodedFrame {
    pub rgb: Vec<u8>,
    pub width: i32,
    pub height: i32,
    pub pts_90k: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct StreamMetadata {
    pub width: i32,
    pub height: i32,
    pub fps: f64,
}

struct ReaderState {
    init: Vec<u8>,
    init_pos: usize,
    body: reqwest::blocking::Response,
    stop: Arc<AtomicBool>,
    eof: bool,
}

unsafe extern "C" fn avio_read_cb(
    opaque: *mut c_void,
    buf: *mut u8,
    buf_size: c_int,
) -> c_int {
    if opaque.is_null() || buf.is_null() || buf_size <= 0 {
        return ff::AVERROR_EOF;
    }
    let state = &mut *(opaque as *mut ReaderState);
    if state.stop.load(Ordering::SeqCst) || state.eof {
        return ff::AVERROR_EOF;
    }

    let dst = std::slice::from_raw_parts_mut(buf, buf_size as usize);
    let mut written = 0usize;

    if state.init_pos < state.init.len() {
        let remaining = &state.init[state.init_pos..];
        let n = remaining.len().min(dst.len());
        dst[..n].copy_from_slice(&remaining[..n]);
        state.init_pos += n;
        written += n;
        if written == dst.len() {
            return written as c_int;
        }
    }

    match state.body.read(&mut dst[written..]) {
        Ok(0) => {
            state.eof = true;
            if written > 0 { written as c_int } else { ff::AVERROR_EOF }
        }
        Ok(n) => (written + n) as c_int,
        Err(e) => {
            tracing::warn!(error = ?e, "avio read failed");
            ff::AVERROR_EOF
        }
    }
}

pub struct StreamDecoder {
    fmt_ctx: *mut ff::AVFormatContext,
    avio_ctx: *mut ff::AVIOContext,
    codec_ctx: *mut ff::AVCodecContext,
    sws_ctx: *mut ff::SwsContext,
    packet: *mut ff::AVPacket,
    frame: *mut ff::AVFrame,
    rgb_frame: *mut ff::AVFrame,
    reader_state: *mut ReaderState,
    rgb_buffer_size: usize,
    video_stream_index: i32,
    time_base: ff::AVRational,
    metadata: StreamMetadata,
}

unsafe impl Send for StreamDecoder {}

impl StreamDecoder {
    pub fn open(
        init_bytes: Vec<u8>,
        body: reqwest::blocking::Response,
        stop: Arc<AtomicBool>,
    ) -> Result<Self> {
        let mut d = Self::blank();
        unsafe {
            d.install_reader(init_bytes, body, stop).context("reader")?;
            d.install_avio().context("avio alloc")?;
            d.install_fmt_ctx().context("fmt ctx alloc")?;
            d.open_input().context("open input")?;
            d.find_stream().context("find stream")?;
            d.open_decoder().context("open decoder")?;
            d.install_scaler().context("scaler")?;
            d.install_packet_and_frames().context("packet/frame alloc")?;
        }
        Ok(d)
    }

    fn blank() -> Self {
        Self {
            fmt_ctx: ptr::null_mut(),
            avio_ctx: ptr::null_mut(),
            codec_ctx: ptr::null_mut(),
            sws_ctx: ptr::null_mut(),
            packet: ptr::null_mut(),
            frame: ptr::null_mut(),
            rgb_frame: ptr::null_mut(),
            reader_state: ptr::null_mut(),
            rgb_buffer_size: 0,
            video_stream_index: -1,
            time_base: ff::AVRational { num: 0, den: 1 },
            metadata: StreamMetadata { width: 0, height: 0, fps: 0.0 },
        }
    }

    unsafe fn install_reader(
        &mut self,
        init: Vec<u8>,
        body: reqwest::blocking::Response,
        stop: Arc<AtomicBool>,
    ) -> Result<()> {
        let reader = Box::new(ReaderState { init, init_pos: 0, body, stop, eof: false });
        self.reader_state = Box::into_raw(reader);
        Ok(())
    }

    unsafe fn install_avio(&mut self) -> Result<()> {
        let buf_size: c_int = 64 * 1024;
        let buffer = ff::av_malloc(buf_size as usize) as *mut u8;
        if buffer.is_null() {
            bail!("av_malloc returned null");
        }
        let ctx = ff::avio_alloc_context(
            buffer,
            buf_size,
            0,
            self.reader_state as *mut c_void,
            Some(avio_read_cb),
            None,
            None,
        );
        if ctx.is_null() {
            ff::av_free(buffer as *mut c_void);
            bail!("avio_alloc_context returned null");
        }
        self.avio_ctx = ctx;
        Ok(())
    }

    unsafe fn install_fmt_ctx(&mut self) -> Result<()> {
        let ctx = ff::avformat_alloc_context();
        if ctx.is_null() {
            bail!("avformat_alloc_context returned null");
        }
        (*ctx).pb = self.avio_ctx;
        (*ctx).flags |= ff::AVFMT_FLAG_CUSTOM_IO;
        self.fmt_ctx = ctx;
        Ok(())
    }

    unsafe fn open_input(&mut self) -> Result<()> {
        let mut opts: *mut ff::AVDictionary = ptr::null_mut();
        ff::av_dict_set(&mut opts, c"fflags".as_ptr(), c"nobuffer".as_ptr(), 0);
        ff::av_dict_set(&mut opts, c"probesize".as_ptr(), c"500000".as_ptr(), 0);
        ff::av_dict_set(&mut opts, c"analyzeduration".as_ptr(), c"500000".as_ptr(), 0);

        let mut ctx = self.fmt_ctx;
        let ret = ff::avformat_open_input(&mut ctx, ptr::null(), ptr::null_mut(), &mut opts);
        ff::av_dict_free(&mut opts);
        // avformat_open_input frees & nulls fmt_ctx on failure; reflect that.
        self.fmt_ctx = ctx;
        if ret < 0 {
            bail!("avformat_open_input ret={}", ret);
        }
        Ok(())
    }

    unsafe fn find_stream(&mut self) -> Result<()> {
        let ret = ff::avformat_find_stream_info(self.fmt_ctx, ptr::null_mut());
        if ret < 0 {
            bail!("avformat_find_stream_info ret={}", ret);
        }
        let mut decoder_ptr: *const ff::AVCodec = ptr::null();
        let idx = ff::av_find_best_stream(
            self.fmt_ctx,
            ff::AVMediaType::AVMEDIA_TYPE_VIDEO,
            -1,
            -1,
            &mut decoder_ptr,
            0,
        );
        if idx < 0 || decoder_ptr.is_null() {
            bail!("no video stream in input");
        }
        self.video_stream_index = idx;

        let stream = *(*self.fmt_ctx).streams.offset(idx as isize);
        self.time_base = (*stream).time_base;

        let codec_ctx = ff::avcodec_alloc_context3(decoder_ptr);
        if codec_ctx.is_null() {
            bail!("avcodec_alloc_context3 returned null");
        }
        self.codec_ctx = codec_ctx;

        let ret = ff::avcodec_parameters_to_context(self.codec_ctx, (*stream).codecpar);
        if ret < 0 {
            bail!("avcodec_parameters_to_context ret={}", ret);
        }

        // fps from avg_frame_rate; 0 if unknown.
        let fr = (*stream).avg_frame_rate;
        self.metadata.fps = if fr.den != 0 { fr.num as f64 / fr.den as f64 } else { 0.0 };
        Ok(())
    }

    unsafe fn open_decoder(&mut self) -> Result<()> {
        let decoder = ff::avcodec_find_decoder((*self.codec_ctx).codec_id);
        if decoder.is_null() {
            bail!("no decoder for codec_id {:?}", (*self.codec_ctx).codec_id);
        }
        let ret = ff::avcodec_open2(self.codec_ctx, decoder, ptr::null_mut());
        if ret < 0 {
            bail!("avcodec_open2 ret={}", ret);
        }
        let w = (*self.codec_ctx).width;
        let h = (*self.codec_ctx).height;
        if w <= 0 || h <= 0 {
            bail!("decoder reports invalid dimensions: {}x{}", w, h);
        }
        self.metadata.width = w;
        self.metadata.height = h;
        Ok(())
    }

    unsafe fn install_scaler(&mut self) -> Result<()> {
        let w = self.metadata.width;
        let h = self.metadata.height;
        let sws = ff::sws_getContext(
            w,
            h,
            (*self.codec_ctx).pix_fmt,
            w,
            h,
            ff::AVPixelFormat::AV_PIX_FMT_RGB24,
            ff::SWS_BILINEAR as c_int,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null(),
        );
        if sws.is_null() {
            bail!("sws_getContext returned null");
        }
        self.sws_ctx = sws;
        self.rgb_buffer_size = ff::av_image_get_buffer_size(
            ff::AVPixelFormat::AV_PIX_FMT_RGB24,
            w,
            h,
            1,
        ) as usize;
        Ok(())
    }

    unsafe fn install_packet_and_frames(&mut self) -> Result<()> {
        self.packet = ff::av_packet_alloc();
        self.frame = ff::av_frame_alloc();
        self.rgb_frame = ff::av_frame_alloc();
        if self.packet.is_null() || self.frame.is_null() || self.rgb_frame.is_null() {
            bail!("packet/frame alloc returned null");
        }
        Ok(())
    }

    pub fn next_frame(&mut self) -> Result<Option<DecodedFrame>> {
        unsafe {
            loop {
                ff::av_packet_unref(self.packet);
                let ret = ff::av_read_frame(self.fmt_ctx, self.packet);
                if ret == ff::AVERROR_EOF {
                    ff::avcodec_send_packet(self.codec_ctx, ptr::null_mut());
                    return self.drain_one_frame();
                }
                if ret < 0 {
                    bail!("av_read_frame ret={}", ret);
                }
                if (*self.packet).stream_index != self.video_stream_index {
                    continue;
                }
                let send = ff::avcodec_send_packet(self.codec_ctx, self.packet);
                if send < 0 && send != ff::AVERROR(ff::EAGAIN) {
                    tracing::warn!(ret = send, "avcodec_send_packet non-fatal");
                }
                if let Some(frame) = self.drain_one_frame()? {
                    return Ok(Some(frame));
                }
            }
        }
    }

    unsafe fn drain_one_frame(&mut self) -> Result<Option<DecodedFrame>> {
        ff::av_frame_unref(self.frame);
        let ret = ff::avcodec_receive_frame(self.codec_ctx, self.frame);
        if ret == ff::AVERROR(ff::EAGAIN) || ret == ff::AVERROR_EOF {
            return Ok(None);
        }
        if ret < 0 {
            bail!("avcodec_receive_frame ret={}", ret);
        }

        let w = self.metadata.width;
        let h = self.metadata.height;
        let mut rgb = vec![0u8; self.rgb_buffer_size];

        ff::av_frame_unref(self.rgb_frame);
        let fill = ff::av_image_fill_arrays(
            (*self.rgb_frame).data.as_mut_ptr(),
            (*self.rgb_frame).linesize.as_mut_ptr(),
            rgb.as_mut_ptr(),
            ff::AVPixelFormat::AV_PIX_FMT_RGB24,
            w,
            h,
            1,
        );
        if fill < 0 {
            bail!("av_image_fill_arrays ret={}", fill);
        }

        let scaled = ff::sws_scale(
            self.sws_ctx,
            (*self.frame).data.as_ptr() as *const *const u8,
            (*self.frame).linesize.as_ptr(),
            0,
            h,
            (*self.rgb_frame).data.as_mut_ptr(),
            (*self.rgb_frame).linesize.as_ptr(),
        );
        if scaled <= 0 {
            bail!("sws_scale ret={}", scaled);
        }

        let raw_pts = (*self.frame).pts;
        let pts_90k = self.pts_to_90k(raw_pts);

        Ok(Some(DecodedFrame { rgb, width: w, height: h, pts_90k }))
    }

    fn pts_to_90k(&self, raw_pts: i64) -> u64 {
        if raw_pts == ff::AV_NOPTS_VALUE {
            return 0;
        }
        let num = self.time_base.num as i64;
        let den = self.time_base.den as i64;
        if den <= 0 || num < 0 {
            return 0;
        }
        let v = raw_pts
            .saturating_mul(num)
            .saturating_mul(PTS_TIMEBASE as i64)
            .checked_div(den)
            .unwrap_or(0);
        if v < 0 { 0 } else { v as u64 }
    }
}

impl StreamDecoder {
    pub fn metadata(&self) -> StreamMetadata {
        self.metadata
    }
}

impl Drop for StreamDecoder {
    fn drop(&mut self) {
        unsafe {
            if !self.packet.is_null() {
                let mut p = self.packet;
                ff::av_packet_free(&mut p);
            }
            if !self.frame.is_null() {
                let mut f = self.frame;
                ff::av_frame_free(&mut f);
            }
            if !self.rgb_frame.is_null() {
                let mut f = self.rgb_frame;
                ff::av_frame_free(&mut f);
            }
            if !self.sws_ctx.is_null() {
                ff::sws_freeContext(self.sws_ctx);
            }
            if !self.codec_ctx.is_null() {
                let mut cc = self.codec_ctx;
                ff::avcodec_free_context(&mut cc);
            }
            if !self.fmt_ctx.is_null() {
                let mut fc = self.fmt_ctx;
                ff::avformat_close_input(&mut fc);
            }
            if !self.avio_ctx.is_null() {
                let mut buf = (*self.avio_ctx).buffer as *mut c_void;
                if !buf.is_null() {
                    ff::av_freep(&mut buf as *mut _ as *mut c_void);
                }
                let mut avio = self.avio_ctx;
                ff::avio_context_free(&mut avio);
            }
            if !self.reader_state.is_null() {
                drop(Box::from_raw(self.reader_state));
            }
        }
    }
}

// Silence unused-import warnings on CStr when no debug paths use it in the future.
#[allow(dead_code)]
fn _cstr_keepalive() -> Option<&'static CStr> { None }
