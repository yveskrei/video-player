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
DASH_WINDOW_SIZE = 5
INIT_TIMEOUT = 10           # seconds to wait for DASH manifest


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
        }

    # ------------------------------------------------------------------
    # MP4 init segment extraction (ftyp + moov from FFmpeg stdout)
    # ------------------------------------------------------------------

    @staticmethod
    def _read_mp4_init(stdout) -> bytes:
        """
        Read ftyp + moov boxes from FFmpeg stdout pipe.
        Returns the raw bytes of the init segment.
        Raises RuntimeError if the pipe closes before moov is complete.
        """
        init_bytes = b""

        while True:
            # Read 8-byte box header (size + type)
            header = b""
            while len(header) < 8:
                chunk = stdout.read(8 - len(header))
                if not chunk:
                    raise RuntimeError("FFmpeg stdout closed before init segment was complete")
                header += chunk

            box_size = struct.unpack(">I", header[:4])[0]
            box_type = header[4:8].decode("ascii", errors="ignore")

            if box_size == 1:
                # Extended 64-bit size follows the type field
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

            # Read box content
            content = b""
            while len(content) < remaining:
                chunk = stdout.read(min(65536, remaining - len(content)))
                if not chunk:
                    raise RuntimeError(f"FFmpeg stdout closed while reading {box_type} box content")
                content += chunk

            init_bytes += header + content
            logger.debug(f"[Init] Read box: {box_type} ({box_size} bytes)")

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
    def _stdout_reader(video_id: int, process) -> None:
        """
        Drain FFmpeg stdout after init is extracted.
        Prevents FFmpeg from blocking when no HTTP consumer is connected.
        When a consumer is active, pushes chunks to its queue.
        """
        while process.poll() is None:
            try:
                chunk = process.stdout.read1(65536)
            except Exception:
                break
            if not chunk:
                time.sleep(0.005)
                continue
            stream = storage.active_streams.get(video_id)
            if not stream:
                break
            q = stream.get("consumer_queue")
            if q is not None:
                try:
                    q.put_nowait(chunk)
                except qmod.Full:
                    pass  # slow consumer — drop chunk rather than block FFmpeg

    @staticmethod
    def _do_terminate(video_id: int, process, stderr_thread, stdout_reader) -> None:
        """Kill FFmpeg, signal the consumer queue, join threads, clean dirs."""
        logger.info(f"[Stream {video_id}] Terminating FFmpeg...")

        # Signal consumer so its HTTP generator exits cleanly
        stream = storage.active_streams.get(video_id)
        if stream:
            q = stream.get("consumer_queue")
            if q is not None:
                try:
                    q.put_nowait(None)  # sentinel: tells consumer to stop
                except qmod.Full:
                    pass

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
        if stdout_reader is not None:
            stdout_reader.join(timeout=2)

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

        stdout_reader = None

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

        # --- Start stdout drainer (takes over stdout after init) ---
        stdout_reader = threading.Thread(
            target=StreamManager._stdout_reader,
            args=(video_id, process),
            daemon=True,
        )
        stdout_reader.start()

        # --- Phase 1: INITIALIZING — poll for DASH manifest ---
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
                if dash_manifest.exists():
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
                logger.error(f"[Stream {video_id}] Initialization timeout — no manifest after {INIT_TIMEOUT}s")
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
        StreamManager._do_terminate(video_id, process, stderr_thread, stdout_reader)

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

            cmd = [
                "ffmpeg",
                "-v", "warning",
                "-probesize", "50M",
                "-analyzeduration", "100M",
                "-err_detect", "ignore_err",
                "-re",
                "-stream_loop", "-1",
                "-fflags", "+genpts",
                "-i", video_data["file_path"],
                "-filter_complex",
                f"[0:v]fps=fps={fps}[v_base]; [v_base]split=2[v_dash][v_prog]",

                # --- DASH output ---
                "-map", "[v_dash]",
                "-an",
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
                "-extra_window_size", str(DASH_WINDOW_SIZE),
                "-remove_at_exit", "1",
                "-streaming", "1",
                "-ldash", "1",
                str(dash_dir / "manifest.mpd"),

                # --- Progressive fMP4 → stdout ---
                "-map", "[v_prog]",
                "-an",
                "-c:v", "libx264",
                "-pix_fmt", "yuv420p",
                "-preset", "ultrafast",
                "-tune", "zerolatency",
                "-b:v", "2M",
                "-g", keyframe_interval,
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
                "consumer_queue": None,
                "prog_consumer_active": False,
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
