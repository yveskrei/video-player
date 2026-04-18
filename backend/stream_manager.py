import subprocess
import signal
import time
import threading
import logging
import os
import struct
import shutil
import queue as qmod
from pathlib import Path
from fastapi import HTTPException
from storage import storage
from enums import StreamStatus, VideoUpdateReason
from websocket_manager import manager as ws_manager, broadcast_sync

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

DASH_OUTPUT_DIR = Path("./dash_streams")
PROGRESSIVE_OUTPUT_DIR = Path("./progressive_streams")
DASH_SEGMENT_DURATION = 2   # seconds
DASH_WINDOW_SIZE = 150      # 150 × 2s = 300s DVR window
INIT_TIMEOUT = 20           # seconds to wait for DASH manifest (FFmpeg can
                            # spend several seconds probing before it emits
                            # its first segment, especially on -stream_loop
                            # -1 with -c:v copy)


class ProgressiveHub:
    """
    One-producer-many-consumers fan-out for live fMP4 fragments.

    The stdout drainer is the sole producer; each HTTP client owns its own
    queue. publish() clones the fragment into every subscriber's queue with
    put_nowait — a slow consumer drops its own fragments without affecting
    FFmpeg or other clients. latest_fragment is cached so a joining client
    gets video immediately instead of waiting up to one frag_duration.
    """

    def __init__(self) -> None:
        self._subs: set[qmod.Queue] = set()
        self._latest: bytes | None = None
        self._lock = threading.Lock()

    def subscribe(self) -> qmod.Queue:
        q: qmod.Queue = qmod.Queue(maxsize=200)
        with self._lock:
            self._subs.add(q)
            latest = self._latest
        if latest is not None:
            try:
                q.put_nowait(latest)
            except qmod.Full:
                pass
        return q

    def unsubscribe(self, q: qmod.Queue) -> None:
        with self._lock:
            self._subs.discard(q)

    def publish(self, fragment: bytes) -> None:
        with self._lock:
            self._latest = fragment
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(fragment)
            except qmod.Full:
                pass

    def close(self) -> None:
        with self._lock:
            subs = list(self._subs)
            self._subs.clear()
        for q in subs:
            try:
                q.put_nowait(None)
            except qmod.Full:
                pass


class StreamManager:

    _monitor_threads: dict = {}
    _stream_locks: dict = {}

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _get_lock(video_id: int) -> threading.Lock:
        if video_id not in StreamManager._stream_locks:
            StreamManager._stream_locks[video_id] = threading.Lock()
        return StreamManager._stream_locks[video_id]

    @staticmethod
    def _validate_video(video_data: dict) -> None:
        width = video_data.get("width")
        height = video_data.get("height")
        fps = video_data.get("fps")
        if not width or width <= 0:
            raise HTTPException(400, f"Invalid video width: {width}")
        if not height or height <= 0:
            raise HTTPException(400, f"Invalid video height: {height}")
        if not fps or fps <= 0:
            raise HTTPException(400, f"Invalid video fps: {fps}")

    @staticmethod
    def _build_video_payload(video_id: int) -> dict:
        """Build the video data dict sent in WebSocket VIDEO_UPDATE events."""
        video = storage.videos.get(video_id, {})
        stream = storage.active_streams.get(video_id)
        status = stream["status"] if stream else StreamStatus.STOPPED
        return {
            "id": video_id,
            "name": video.get("name", ""),
            "file_path": video.get("file_path", ""),
            "created_at": video.get("created_at", ""),
            "width": video.get("width", 0),
            "height": video.get("height", 0),
            "fps": video.get("fps", 0.0),
            "stream_status": status,
            "stream_start_time_ms": stream.get("start_time_ms") if stream else None,
            "dash_manifest_url": stream.get("dash_manifest_url") if stream else None,
            "prog_url": f"/progressive/{video_id}/prog.m4s" if stream else None,
            "prog_init_url": f"/progressive/{video_id}/progressive.mp4" if stream else None,
            # Authoritative DVR capacity in seconds. Frontend uses this
            # directly as the window size instead of trying to derive one
            # from dash.js's getDvrWindow() (which can jitter) or a hidden
            # constant (which drifts out of sync when the backend is tuned).
            "dvr_window_seconds": DASH_SEGMENT_DURATION * DASH_WINDOW_SIZE,
        }

    # ------------------------------------------------------------------
    # MP4 init segment extraction (ftyp + moov from FFmpeg stdout)
    # ------------------------------------------------------------------

    @staticmethod
    def _read_mp4_box(stdout) -> tuple[str, bytes]:
        """
        Read one complete MP4 box from stdout. Returns (box_type, box_bytes)
        where box_bytes is the header + payload concatenated (so callers can
        forward the raw on-wire bytes). Raises RuntimeError on unexpected EOF.
        """
        header = b""
        while len(header) < 8:
            chunk = stdout.read(8 - len(header))
            if not chunk:
                raise RuntimeError("FFmpeg stdout closed at MP4 box boundary")
            header += chunk

        box_size = struct.unpack(">I", header[:4])[0]
        box_type = header[4:8].decode("ascii", errors="ignore")

        if box_size == 1:
            ext = b""
            while len(ext) < 8:
                chunk = stdout.read(8 - len(ext))
                if not chunk:
                    raise RuntimeError("FFmpeg stdout closed reading extended box size")
                ext += chunk
            box_size = struct.unpack(">Q", ext)[0]
            header += ext
            remaining = box_size - 16
        elif box_size == 0:
            raise RuntimeError(f"Unsupported MP4 box with size=0 (extends to EOF): {box_type}")
        else:
            remaining = box_size - 8

        content = b""
        while len(content) < remaining:
            chunk = stdout.read(min(65536, remaining - len(content)))
            if not chunk:
                raise RuntimeError(f"FFmpeg stdout closed while reading {box_type} box content")
            content += chunk

        return box_type, header + content

    @staticmethod
    def _read_mp4_init(stdout) -> bytes:
        """
        Read ftyp + moov boxes from FFmpeg stdout pipe.
        Returns the raw bytes of the init segment.
        Raises RuntimeError if the pipe closes before moov is complete.
        """
        init_bytes = b""
        while True:
            box_type, box_bytes = StreamManager._read_mp4_box(stdout)
            init_bytes += box_bytes
            logger.debug(f"[Init] Read box: {box_type} ({len(box_bytes)} bytes)")
            if box_type == "moov":
                logger.info(f"[Init] Complete — {len(init_bytes)} bytes")
                break
            if len(init_bytes) > 10 * 1024 * 1024:
                raise RuntimeError("Init segment exceeds 10 MB safety limit — possible format issue")
        return init_bytes

    # ------------------------------------------------------------------
    # Background threads (stderr reader, stdout drainer, monitor)
    # ------------------------------------------------------------------

    @staticmethod
    def _stderr_reader(video_id: int, process) -> None:
        """Drain FFmpeg stderr to prevent pipe blocking."""
        try:
            for line in iter(process.stderr.readline, b""):
                if not line:
                    break
                logger.debug(f"[Stream {video_id}] FFmpeg: {line.decode('utf-8', errors='ignore').strip()}")
        except Exception as e:
            logger.debug(f"[Stream {video_id}] Stderr reader ended: {e}")

    @staticmethod
    def _fragment_publisher(video_id: int, process) -> None:
        """
        Drain FFmpeg stdout as whole fMP4 fragments (moof+mdat pairs) and
        publish each complete fragment to the stream's ProgressiveHub.

        Publishing fragment-granular (rather than byte-granular) lets a
        late-joining client start cleanly: every fragment begins with a
        moof + keyframe, so it's a valid decode restart point. Reading
        this thread is also the sole drainer of the pipe, which is what
        prevents FFmpeg from blocking regardless of subscriber count.
        """
        while process.poll() is None:
            stream = storage.active_streams.get(video_id)
            if not stream:
                break
            hub: "ProgressiveHub | None" = stream.get("hub")
            if hub is None:
                break
            try:
                first_type, first_bytes = StreamManager._read_mp4_box(process.stdout)
            except RuntimeError as e:
                logger.debug(f"[Stream {video_id}] Publisher EOF: {e}")
                break
            if first_type != "moof":
                # fMP4 is a strict moof+mdat sequence after the init. Anything
                # else would mean FFmpeg emitted an unexpected format; skip it
                # rather than poison the fan-out with a partial fragment.
                logger.warning(f"[Stream {video_id}] Expected moof, got {first_type}; skipping")
                continue
            try:
                second_type, second_bytes = StreamManager._read_mp4_box(process.stdout)
            except RuntimeError as e:
                logger.debug(f"[Stream {video_id}] Publisher EOF after moof: {e}")
                break
            if second_type != "mdat":
                logger.warning(f"[Stream {video_id}] Expected mdat after moof, got {second_type}; skipping")
                continue
            hub.publish(first_bytes + second_bytes)

    @staticmethod
    def _do_terminate(video_id: int, process, stderr_thread, fragment_publisher) -> None:
        """Kill FFmpeg, close the hub so every subscriber exits, join threads, clean dirs."""
        logger.info(f"[Stream {video_id}] Terminating FFmpeg...")

        # Close the hub so every subscriber's HTTP generator exits cleanly
        stream = storage.active_streams.get(video_id)
        if stream:
            hub = stream.get("hub")
            if hub is not None:
                hub.close()

        # Kill FFmpeg process group
        try:
            pgid = os.getpgid(process.pid)
            os.killpg(pgid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
                logger.info(f"[Stream {video_id}] FFmpeg terminated cleanly")
            except subprocess.TimeoutExpired:
                logger.warning(f"[Stream {video_id}] SIGTERM timeout — force killing")
                os.killpg(pgid, signal.SIGKILL)
                process.wait()
        except (ProcessLookupError, OSError) as e:
            logger.debug(f"[Stream {video_id}] Process cleanup: {e}")

        stderr_thread.join(timeout=2)
        if fragment_publisher is not None:
            fragment_publisher.join(timeout=2)

        # Remove output directories
        for d in [
            DASH_OUTPUT_DIR / str(video_id),
            PROGRESSIVE_OUTPUT_DIR / str(video_id),
        ]:
            if d.exists():
                shutil.rmtree(d, ignore_errors=True)
                logger.info(f"[Stream {video_id}] Removed {d}")

        # Remove from active_streams
        storage.active_streams.pop(video_id, None)

    @staticmethod
    def _monitor(video_id: int) -> None:
        """
        Lifecycle thread for a single stream:
          1. Read progressive init bytes from stdout → write progressive.mp4
          2. Poll for DASH manifest (INITIALIZING → STREAMING or TERMINATING)
          3. Watch for FFmpeg errors / death (STREAMING → TERMINATING)
          4. Terminate and clean up
        """
        stream = storage.active_streams.get(video_id)
        if not stream:
            return

        process = stream["process"]
        dash_manifest = DASH_OUTPUT_DIR / str(video_id) / "manifest.mpd"
        prog_dir = PROGRESSIVE_OUTPUT_DIR / str(video_id)

        # --- Start stderr reader ---
        stderr_thread = threading.Thread(
            target=StreamManager._stderr_reader,
            args=(video_id, process),
            daemon=True,
        )
        stderr_thread.start()

        fragment_publisher = None

        # --- Phase 0: extract progressive init segment from stdout ---
        try:
            logger.info(f"[Stream {video_id}] Reading progressive init from stdout...")
            init_bytes = StreamManager._read_mp4_init(process.stdout)
            prog_dir.mkdir(parents=True, exist_ok=True)
            (prog_dir / "progressive.mp4").write_bytes(init_bytes)
            stream["prog_init_ready"].set()
            logger.info(f"[Stream {video_id}] progressive.mp4 ready")
        except Exception as e:
            logger.error(f"[Stream {video_id}] Init extraction failed: {e}")
            stream = storage.active_streams.get(video_id)
            if stream:
                stream["status"] = StreamStatus.TERMINATING

        # --- Start fragment publisher (takes over stdout after init) ---
        fragment_publisher = threading.Thread(
            target=StreamManager._fragment_publisher,
            args=(video_id, process),
            daemon=True,
        )
        fragment_publisher.start()

        # --- Phase 1: INITIALIZING — poll for DASH manifest + enough segments ---
        # Don't transition to STREAMING until at least MIN_READY_SEGMENTS media
        # segments (chunk-*.m4s) exist. A dash.js 5.1.1 race in
        # StreamController._composePeriods crashes playback when the manifest is too
        # fresh: `stream.initialize()` can't populate its adapter's RegularPeriods
        # from a one-segment MPD in time, so addDVRMetric silently fails and the
        # player never fires STREAMS_COMPOSED. Requiring 3 segments guarantees
        # ffmpeg has rewritten the MPD at least twice with a real segment timeline.
        MIN_READY_SEGMENTS = 3
        stream = storage.active_streams.get(video_id)
        if stream and stream["status"] == StreamStatus.INITIALIZING:
            deadline = time.time() + INIT_TIMEOUT
            while time.time() < deadline:
                stream = storage.active_streams.get(video_id)
                if not stream or stream["status"] == StreamStatus.TERMINATING:
                    break
                if process.poll() is not None:
                    logger.error(f"[Stream {video_id}] FFmpeg died during initialization (rc={process.returncode})")
                    if stream:
                        stream["status"] = StreamStatus.TERMINATING
                    break
                ready = False
                if dash_manifest.exists():
                    segment_count = sum(1 for _ in dash_manifest.parent.glob("chunk-*.m4s"))
                    ready = segment_count >= MIN_READY_SEGMENTS
                if ready:
                    stream["status"] = StreamStatus.STREAMING
                    logger.info(f"[Stream {video_id}] → STREAMING")
                    broadcast_sync(
                        ws_manager.broadcast_video_update(
                            video_id,
                            VideoUpdateReason.STREAM_STARTED,
                            StreamManager._build_video_payload(video_id),
                        )
                    )
                    break
                time.sleep(0.5)
            else:
                # Loop exhausted — timeout
                logger.error(f"[Stream {video_id}] Initialization timeout — no manifest/segments after {INIT_TIMEOUT}s")
                stream = storage.active_streams.get(video_id)
                if stream and stream["status"] == StreamStatus.INITIALIZING:
                    stream["status"] = StreamStatus.TERMINATING

        # --- Phase 2: STREAMING — watch for FFmpeg death or manual stop ---
        stream = storage.active_streams.get(video_id)
        if stream and stream["status"] == StreamStatus.STREAMING:
            while True:
                stream = storage.active_streams.get(video_id)
                if not stream or stream["status"] == StreamStatus.TERMINATING:
                    break
                if process.poll() is not None:
                    logger.error(f"[Stream {video_id}] FFmpeg died during streaming (rc={process.returncode})")
                    if stream:
                        stream["status"] = StreamStatus.TERMINATING
                    broadcast_sync(
                        ws_manager.broadcast_video_update(
                            video_id,
                            VideoUpdateReason.STREAM_ERROR,
                            StreamManager._build_video_payload(video_id),
                        )
                    )
                    break
                time.sleep(1.0)

        # --- Phase 3: TERMINATING — cleanup ---
        StreamManager._do_terminate(video_id, process, stderr_thread, fragment_publisher)

        # Broadcast final STOPPED state (active_streams entry is now gone)
        if video_id in storage.videos:
            broadcast_sync(
                ws_manager.broadcast_video_update(
                    video_id,
                    VideoUpdateReason.STREAM_STOPPED,
                    StreamManager._build_video_payload(video_id),
                )
            )

        StreamManager._monitor_threads.pop(video_id, None)
        logger.info(f"[Stream {video_id}] Monitor thread done")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @classmethod
    def start_stream(cls, video_id: int) -> None:
        """
        Start streaming a video.
        Sets status to INITIALIZING immediately and returns.
        The monitor thread handles the rest of the lifecycle.
        """
        if video_id not in storage.videos:
            raise HTTPException(404, f"Video {video_id} not found")

        lock = cls._get_lock(video_id)
        with lock:
            if video_id in storage.active_streams:
                status = storage.active_streams[video_id]["status"]
                raise HTTPException(409, f"Stream is already {status}")

            video_data = storage.videos[video_id]
            cls._validate_video(video_data)

            fps = video_data["fps"]
            keyframe_interval = str(int(fps * 2))

            # Create DASH output directory
            dash_dir = DASH_OUTPUT_DIR / str(video_id)
            dash_dir.mkdir(parents=True, exist_ok=True)

            # One libx264 encoder for DASH; the progressive output is just a
            # remux of the source bitstream (`-c:v copy`), so the FFI library
            # gets a decodable fMP4 without paying for a second encode pass.
            # This reverts the ~2× CPU regression introduced when the
            # progressive branch was added with its own encoder.
            cmd = [
                "ffmpeg",
                "-v", "warning",
                # Probe only enough of the input to identify stream params.
                # The previous 50M / 100M were scanning far more than needed
                # and delayed the first output segment by several seconds,
                # tripping INIT_TIMEOUT before the DVR could be populated.
                "-probesize", "5M",
                "-analyzeduration", "5M",
                "-err_detect", "ignore_err",
                "-re",
                "-stream_loop", "-1",
                "-fflags", "+genpts",
                "-i", video_data["file_path"],

                # --- DASH output (re-encoded h264) ---
                "-map", "0:v:0",
                "-an",
                "-vf", f"fps=fps={fps}",
                "-c:v", "libx264",
                "-pix_fmt", "yuv420p",
                "-preset", "veryfast",
                "-tune", "zerolatency",
                "-b:v", "2M",
                "-maxrate", "2M",
                "-bufsize", "4M",
                "-g", keyframe_interval,
                "-f", "dash",
                "-seg_duration", str(DASH_SEGMENT_DURATION),
                "-window_size", str(DASH_WINDOW_SIZE),
                # 30 extra segments (= 60 s at seg_duration=2) retained
                # past the advertised MPD window. Covers the race between
                # dash.js fetching an oldest-edge segment and ffmpeg's
                # unlink on roll-off — the earlier 5-segment margin (10 s)
                # was enough for happy-path timing but not for the actual
                # client request latency + FS ops, which is what produced
                # the oldest-edge freeze.
                "-extra_window_size", "30",
                "-remove_at_exit", "1",
                "-streaming", "1",
                "-ldash", "1",
                "-use_template", "1",
                "-use_timeline", "1",
                str(dash_dir / "manifest.mpd"),

                # --- Progressive fMP4 → stdout (remux only, no re-encode) ---
                "-map", "0:v:0",
                "-an",
                "-c:v", "copy",
                "-f", "mp4",
                "-movflags", "frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset",
                "-frag_duration", "200000",
                "pipe:1",
            ]

            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
                bufsize=-1,
                preexec_fn=os.setsid,
            )

            logger.info(f"[Stream {video_id}] FFmpeg started (PID {process.pid})")

            storage.active_streams[video_id] = {
                "status": StreamStatus.INITIALIZING,
                "process": process,
                "pid": process.pid,
                "start_time_ms": int(time.time() * 1000),
                "dash_manifest_url": f"/dash/{video_id}/manifest.mpd",
                "prog_init_ready": threading.Event(),
                "hub": ProgressiveHub(),
            }

            broadcast_sync(
                ws_manager.broadcast_video_update(
                    video_id,
                    VideoUpdateReason.STREAM_INITIALIZING,
                    cls._build_video_payload(video_id),
                )
            )

            monitor = threading.Thread(
                target=cls._monitor, args=(video_id,), daemon=True
            )
            monitor.start()
            cls._monitor_threads[video_id] = monitor

    @classmethod
    def stop_stream(cls, video_id: int) -> None:
        """
        Request a stream to stop.
        Sets status to TERMINATING and kills FFmpeg.
        The monitor thread handles cleanup and broadcasts STOPPED when done.
        """
        lock = cls._get_lock(video_id)
        with lock:
            stream = storage.active_streams.get(video_id)
            if not stream:
                raise HTTPException(404, f"No active stream for video {video_id}")
            if stream["status"] == StreamStatus.TERMINATING:
                raise HTTPException(409, "Stream is already terminating")

            stream["status"] = StreamStatus.TERMINATING

            # Kill FFmpeg immediately to unblock any blocked stdout reads in the monitor
            try:
                pgid = os.getpgid(stream["pid"])
                os.killpg(pgid, signal.SIGTERM)
            except (ProcessLookupError, OSError):
                pass

    @classmethod
    def get_stream_status(cls, video_id: int) -> dict:
        if video_id not in storage.videos:
            raise HTTPException(404, f"Video {video_id} not found")
        stream = storage.active_streams.get(video_id)
        if not stream:
            return {"video_id": video_id, "status": StreamStatus.STOPPED}
        return {
            "video_id": video_id,
            "status": stream["status"],
            "pid": stream.get("pid"),
            "start_time_ms": stream.get("start_time_ms"),
        }

    @classmethod
    def cleanup_all_streams(cls) -> None:
        """Stop all active streams — called on application shutdown."""
        logger.info("Cleaning up all active streams...")
        for video_id in list(storage.active_streams.keys()):
            try:
                cls.stop_stream(video_id)
            except Exception as e:
                logger.debug(f"[Stream {video_id}] Cleanup stop: {e}")
        # Wait for monitor threads to finish
        for video_id, thread in list(cls._monitor_threads.items()):
            thread.join(timeout=8)
        logger.info("All streams cleaned up")


stream_manager = StreamManager()
