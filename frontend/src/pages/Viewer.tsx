import { useEffect, useRef, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { listVideos, listBboxes } from '../api/streams';
import { getBackendUrl } from '../api/client';
import type { VideoInfo, BBox, VideoUpdateMessage, ClipSelection } from '../types';
import { DEFAULT_CONFIDENCE, type ConfidenceSettings } from '../utils/confidence';
import { VideoPlayer } from '../components/VideoPlayer';
import { BBoxOverlay } from '../components/BBoxOverlay';
import { PlayerControls } from '../components/player/PlayerControls';
import { StreamCard } from '../components/StreamCard';
import { useWebSocket } from '../hooks/useWebSocket';
import { useLiveRecorder } from '../hooks/useLiveRecorder';
import { useDvrPlayer } from '../hooks/useDvrPlayer';
import { useClipExport } from '../hooks/useClipExport';
import { RefreshCw, Tv } from 'lucide-react';
import clsx from 'clsx';

const PTS_TIMEBASE = 90000;
const DEFAULT_CLIP_SEC = 30;
const MAX_CLIP_SEC = 300;
const CONTROLS_HIDE_MS = 3000;

export const Viewer: React.FC = () => {
    const [searchParams, setSearchParams] = useSearchParams();
    const autoStreamId = parseInt(searchParams.get('stream_id') ?? '') || null;

    const [streams, setStreams] = useState<VideoInfo[]>([]);
    const [selectedStreamId, setSelectedStreamId] = useState<number | null>(null);
    const [manifestUrl, setManifestUrl] = useState<string | null>(null);

    // Confidence settings: a default threshold plus per-class overrides.
    // Keys in `overrides` are lowercased class names (normalized on add).
    // Reset on stream change — per-stream state, not cross-stream.
    const [confidence, setConfidence] = useState<ConfidenceSettings>(DEFAULT_CONFIDENCE);
    // Mirror into a ref for the BBoxOverlay's RAF draw loop (reads the
    // ref on every tick instead of re-installing the loop on every slider
    // change).
    const confidenceRef = useRef<ConfidenceSettings>(confidence);
    useEffect(() => { confidenceRef.current = confidence; }, [confidence]);
    const [retentionFrames, setRetentionFrames] = useState(1);

    // Playback speed. Reset on stream change (matches confidence pattern).
    // Writes to video.playbackRate via an effect below. Disabled above 1× in
    // live — the UI enforces that; this state trusts its input.
    const [playbackRate, setPlaybackRate] = useState(1);
    const [showBBoxes, setShowBBoxes] = useState(true);
    // Analytics are locked OFF while the historical-bbox fetch is in flight
    // for a freshly-selected stream. Showing them mid-load produces a
    // jarring "incomplete" strip that fills in progressively over a few
    // seconds. Better UX is to hide entirely, disable the toggle, then
    // flip them on once history has landed.
    const [analyticsLocked, setAnalyticsLocked] = useState(false);
    // `playerReady` gates the player UI on "dash.js has seeked to live and
    // is playing" instead of showing the bare black <video> + the seekbar
    // briefly reading as DVR before auto-play snaps to live. Once granted
    // for a stream it stays granted — seeking into DVR doesn't demote it.
    const [playerReady, setPlayerReady] = useState(false);

    const [originalRes, setOriginalRes] = useState({ width: 0, height: 0 });
    const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
    const [videoOffset, setVideoOffset] = useState({ x: 0, y: 0 });

    const [clipSelection, setClipSelection] = useState<ClipSelection | null>(null);
    const { isExporting, progress: exportProgress, exportClip } = useClipExport();

    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showControls, setShowControls] = useState(true);
    const hideControlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const [skipFeedback, setSkipFeedback] = useState<{ delta: number; key: number } | null>(null);
    const skipFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const skipFeedbackKeyRef = useRef(0);

    const showSkipFeedback = useCallback((delta: number) => {
        skipFeedbackKeyRef.current += 1;
        setSkipFeedback({ delta, key: skipFeedbackKeyRef.current });
        if (skipFeedbackTimeoutRef.current) clearTimeout(skipFeedbackTimeoutRef.current);
        skipFeedbackTimeoutRef.current = setTimeout(() => setSkipFeedback(null), 700);
    }, []);

    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const playerBoxRef = useRef<HTMLDivElement>(null);
    const selectedStreamIdRef = useRef<number | null>(null);

    useEffect(() => {
        selectedStreamIdRef.current = selectedStreamId;
    }, [selectedStreamId]);

    // Cap the visual DVR window to what the backend actually retains
    // (VideoInfo.dvr_window_seconds). dash.js's `getDvrWindow().size` can
    // transiently report values much larger than the backend max due to
    // how it clamps range.start against period ranges — that jitter shows
    // up as the seekbar's left-edge hover label bouncing between -05:00
    // and -08:00 on a 300s-configured stream. Clamping to the advertised
    // max pins the bar.
    const selectedStreamInfo = selectedStreamId !== null
        ? streams.find(s => s.id === selectedStreamId)
        : undefined;
    const maxDvrWindowSec = selectedStreamInfo?.dvr_window_seconds ?? 300;

    const dvr = useDvrPlayer(videoRef, maxDvrWindowSec);
    const isLive = dvr.state.isLive;

    // bboxGroupsRef is the hot-path source of truth. Drain/trim/history
    // merging all mutate it in place. `bboxGroups` state is a throttled mirror
    // (at most 2Hz) for consumers that render by React (the Seekbar cluster
    // list). This keeps per-message setState cascades off the main thread —
    // 30 bbox msgs/sec × full Map-clone × Seekbar re-render was saturating it
    // enough to stutter the <video> element.
    const bboxGroupsRef = useRef<Map<number, BBox[]>>(new Map());
    const [bboxGroups, setBboxGroups] = useState<Map<number, BBox[]>>(bboxGroupsRef.current);
    const stateMirrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scheduleStateMirror = useCallback(() => {
        if (stateMirrorTimerRef.current !== null) return;
        stateMirrorTimerRef.current = setTimeout(() => {
            stateMirrorTimerRef.current = null;
            setBboxGroups(new Map(bboxGroupsRef.current));
        }, 500);
    }, []);
    useEffect(() => () => {
        if (stateMirrorTimerRef.current !== null) clearTimeout(stateMirrorTimerRef.current);
    }, []);

    // Active bboxes for the current video frame live in a ref, not React
    // state. The overlay reads the ref on every draw; the `activeVersion`
    // counter is bumped only when content actually changes so the overlay
    // can skip redraws when nothing is different.
    const activeBBoxesRef = useRef<BBox[]>([]);
    const activeVersionRef = useRef<number>(0);
    const recorderBBoxesRef = useRef<BBox[]>([]);

    const { recordingDuration, saveRecording } = useLiveRecorder({
        videoRef,
        bboxesRef: recorderBBoxesRef,
        originalWidth: originalRes.width,
        originalHeight: originalRes.height,
        confidence,
        showBBoxes,
        enabled: isLive && selectedStreamId !== null,
    });

    const selectedStream = selectedStreamId !== null
        ? streams.find(s => s.id === selectedStreamId) ?? null
        : null;

    // -------------------------------------------------------------------
    // Stream lifecycle
    // -------------------------------------------------------------------

    const historyFetchedForRef = useRef<number | null>(null);

    const handleStopWatching = useCallback(() => {
        setSelectedStreamId(null);
        setManifestUrl(null);
        setOriginalRes({ width: 0, height: 0 });
        bboxGroupsRef.current = new Map();
        historyFetchedForRef.current = null;
        maxDeletionPtsRef.current = 0;
        setBboxGroups(new Map());
        setClipSelection(null);
        setAnalyticsLocked(false);
        setShowBBoxes(true);
        setConfidence(DEFAULT_CONFIDENCE);
        setPlaybackRate(1);
        setPlayerReady(false);
        setSearchParams(prev => {
            const next = new URLSearchParams(prev);
            next.delete('stream_id');
            return next;
        }, { replace: true });
    }, [setSearchParams]);

    const handleStreamEnded = useCallback(() => {
        toast('Stream ended', {
            icon: '🛑',
            style: { borderRadius: '10px', background: '#333', color: '#fff' },
        });
        handleStopWatching();
    }, [handleStopWatching]);

    const handleVideoUpdate = useCallback((msg: VideoUpdateMessage) => {
        const videoId = msg.video?.id;
        if (videoId === undefined) return;
        const currentId = selectedStreamIdRef.current;

        if (
            currentId !== null &&
            videoId === currentId &&
            (msg.reason === 'stream_stopped' || msg.reason === 'stream_error' || msg.reason === 'deleted')
        ) {
            handleStreamEnded();
        }

        if (msg.reason === 'deleted') {
            setStreams(prev => prev.filter(s => s.id !== videoId));
        } else if (msg.video) {
            if (msg.video.stream_status === 'streaming') {
                setStreams(prev => {
                    const exists = prev.some(s => s.id === videoId);
                    return exists
                        ? prev.map(s => s.id === videoId ? msg.video! : s)
                        : [...prev, msg.video!];
                });
            } else {
                setStreams(prev => prev.filter(s => s.id !== videoId));
            }
        }
    }, [handleStreamEnded]);

    const { isConnected, bboxBuffer, subscribe, unsubscribe } = useWebSocket({ onVideoUpdate: handleVideoUpdate });

    const drainBboxBuffer = useCallback(() => {
        const buf = bboxBuffer.current;
        if (buf.length === 0) return;
        const groups = bboxGroupsRef.current;
        for (const msg of buf) {
            const existing = groups.get(msg.pts);
            if (existing) existing.push(...msg.bboxes);
            else groups.set(msg.pts, msg.bboxes);
        }
        buf.length = 0;
        scheduleStateMirror();
    }, [bboxBuffer, scheduleStateMirror]);

    // Monotonic deletion threshold — only advances. A temporary dip in
    // dvrStart would otherwise nuke bboxes we had already received and
    // that are still within the backend's retention window. Once deleted
    // they're gone until a page refresh, so we refuse to delete on backward
    // movements, AND we keep a generous cushion below the current dvrStart
    // (`BBOX_CLEANUP_BUFFER_SEC`) so a small rewind or MPD re-poll that
    // momentarily nudges dvrStart forward doesn't evict pts that will
    // shortly reappear in the visible window.
    const BBOX_CLEANUP_BUFFER_SEC = 30;
    const maxDeletionPtsRef = useRef<number>(0);
    useEffect(() => {
        if (!dvr.state.isReady || dvr.state.dvrWindowSize <= 0) return;
        const minPts = Math.max(0, (dvr.state.dvrStart - BBOX_CLEANUP_BUFFER_SEC) * PTS_TIMEBASE);
        if (minPts <= maxDeletionPtsRef.current) return;
        maxDeletionPtsRef.current = minPts;
        const groups = bboxGroupsRef.current;
        let changed = false;
        for (const pts of groups.keys()) {
            if (pts < minPts) {
                groups.delete(pts);
                changed = true;
            }
        }
        if (changed) scheduleStateMirror();
    }, [dvr.state.dvrStart, dvr.state.dvrWindowSize, dvr.state.isReady, scheduleStateMirror]);

    const fetchStreams = useCallback(async () => {
        try {
            const allVideos = await listVideos();
            setStreams(allVideos.filter(v => v.stream_status === 'streaming'));
        } catch { /* WS-triggered refetch below recovers */ }
    }, []);

    useEffect(() => { fetchStreams(); }, [fetchStreams]);

    const prevConnectedRef = useRef(false);
    useEffect(() => {
        if (isConnected && !prevConnectedRef.current) fetchStreams();
        prevConnectedRef.current = isConnected;
    }, [isConnected, fetchStreams]);

    // -------------------------------------------------------------------
    // Stream selection / historical bbox hydration
    // -------------------------------------------------------------------

    const autoSelectedRef = useRef(false);

    const handleStreamSelect = useCallback((id: number) => {
        const stream = streams.find(s => s.id === id);
        if (!stream?.dash_manifest_url) {
            toast.error('No DASH manifest available for this stream');
            return;
        }

        if (selectedStreamIdRef.current !== null && selectedStreamIdRef.current !== id) {
            unsubscribe(selectedStreamIdRef.current);
        }

        autoSelectedRef.current = true;
        bboxGroupsRef.current = new Map();
        historyFetchedForRef.current = null;
        maxDeletionPtsRef.current = 0;
        setSelectedStreamId(id);
        setManifestUrl(stream.dash_manifest_url);
        setBboxGroups(new Map());
        setClipSelection(null);
        // Reset confidence thresholds per-stream: the user's overrides
        // for one stream's class set aren't meaningful on another.
        setConfidence(DEFAULT_CONFIDENCE);
        // Reset playback speed to real-time for the new stream.
        setPlaybackRate(1);
        // Lock analytics until historical bbox fetch resolves (see the
        // effect further down). Hides the overlay + seekbar strip so the
        // user doesn't see a partial view mid-load.
        setAnalyticsLocked(true);
        setShowBBoxes(false);
        // Gate the player UI until dash.js has seeked to live. Otherwise
        // the user sees a black <video> with the seekbar briefly reading
        // "DVR" before auto-play snaps to the live edge.
        setPlayerReady(false);
        setSearchParams(prev => {
            const next = new URLSearchParams(prev);
            next.set('stream_id', String(id));
            return next;
        }, { replace: true });
        subscribe(id);
        // History is fetched by the effect below once the player reports
        // ready — parsing ~MB of JSON on the main thread while dash.js is
        // booting is what made first-frame feel like "forever".
    }, [streams, subscribe, unsubscribe, setSearchParams]);

    // Deferred history hydration: runs once per selected stream, only after
    // dvrState.isReady so the video has a chance to start before we bring a
    // potentially-huge historical bbox dump onto the main thread. When the
    // fetch settles (success or failure) we release the analytics lock and
    // flip showBBoxes back on so the overlay/strip appear fully populated
    // at once.
    useEffect(() => {
        const id = selectedStreamId;
        if (id === null || !dvr.state.isReady) return;
        if (historyFetchedForRef.current === id) return;
        historyFetchedForRef.current = id;
        let cancelled = false;
        (async () => {
            try {
                const history = await listBboxes(id);
                if (cancelled || selectedStreamIdRef.current !== id) return;
                const groups = bboxGroupsRef.current;
                let changed = false;
                for (const g of history.groups) {
                    if (!groups.has(g.pts)) {
                        groups.set(g.pts, g.bboxes);
                        changed = true;
                    }
                }
                if (changed) scheduleStateMirror();
            } catch (e) {
                console.warn('Failed to fetch historical bboxes', e);
            } finally {
                if (!cancelled && selectedStreamIdRef.current === id) {
                    setAnalyticsLocked(false);
                    setShowBBoxes(true);
                }
            }
        })();
        return () => { cancelled = true; };
    }, [selectedStreamId, dvr.state.isReady, scheduleStateMirror]);

    const handleStopWatchingWithUnsub = useCallback(() => {
        if (selectedStreamIdRef.current !== null) unsubscribe(selectedStreamIdRef.current);
        handleStopWatching();
    }, [unsubscribe, handleStopWatching]);

    useEffect(() => {
        if (autoSelectedRef.current || !autoStreamId || selectedStreamId !== null) return;
        const stream = streams.find(s => s.id === autoStreamId);
        if (stream?.dash_manifest_url) {
            autoSelectedRef.current = true;
            handleStreamSelect(autoStreamId);
        }
    }, [streams, autoStreamId, selectedStreamId, handleStreamSelect]);

    // -------------------------------------------------------------------
    // Layout / resize (only relevant while watching)
    // -------------------------------------------------------------------
    useEffect(() => {
        if (!containerRef.current || !videoRef.current) return;

        const updateSize = () => {
            if (containerRef.current && videoRef.current) {
                const containerRect = containerRef.current.getBoundingClientRect();
                const videoElement = videoRef.current;
                const videoWidth = videoElement.videoWidth || originalRes.width;
                const videoHeight = videoElement.videoHeight || originalRes.height;

                if (videoWidth && videoHeight) {
                    const containerAspect = containerRect.width / containerRect.height;
                    const videoAspect = videoWidth / videoHeight;
                    let displayWidth, displayHeight, xOffset = 0, yOffset = 0;

                    if (containerAspect > videoAspect) {
                        displayHeight = containerRect.height;
                        displayWidth = displayHeight * videoAspect;
                        xOffset = (containerRect.width - displayWidth) / 2;
                    } else {
                        displayWidth = containerRect.width;
                        displayHeight = displayWidth / videoAspect;
                        yOffset = (containerRect.height - displayHeight) / 2;
                    }

                    setContainerSize({ width: displayWidth, height: displayHeight });
                    setVideoOffset({ x: xOffset, y: yOffset });
                } else {
                    setContainerSize({ width: containerRect.width, height: containerRect.height });
                    setVideoOffset({ x: 0, y: 0 });
                }
            }
        };

        updateSize();
        const observer = new ResizeObserver(updateSize);
        observer.observe(containerRef.current);
        const v = videoRef.current;
        v.addEventListener('loadedmetadata', updateSize);
        v.addEventListener('resize', updateSize);
        return () => {
            observer.disconnect();
            v.removeEventListener('loadedmetadata', updateSize);
            v.removeEventListener('resize', updateSize);
        };
    }, [selectedStreamId, originalRes]);

    // -------------------------------------------------------------------
    // BBox sync animation loop — writes to refs, never to React state, so
    // the overlay's own RAF loop picks up the new set without re-rendering
    // the Viewer / controls tree on every video frame.
    // -------------------------------------------------------------------
    const showBBoxesRef = useRef(showBBoxes);
    useEffect(() => { showBBoxesRef.current = showBBoxes; }, [showBBoxes]);
    const retentionFramesRef = useRef(retentionFrames);
    useEffect(() => { retentionFramesRef.current = retentionFrames; }, [retentionFrames]);
    const selectedStreamIdForAnimRef = useRef(selectedStreamId);
    useEffect(() => { selectedStreamIdForAnimRef.current = selectedStreamId; }, [selectedStreamId]);

    useEffect(() => {
        let raf = 0;
        const loop = () => {
            drainBboxBuffer();
            const video = videoRef.current;
            const streamId = selectedStreamIdForAnimRef.current;
            if (video && streamId !== null) {
                // Recompute every RAF — no currentTime-change gate. Browsers
                // can stutter their currentTime reporting even while the
                // video is actively playing, and gating left the overlay
                // painting a stale frame for seconds. Per-tick iteration of
                // bboxGroupsRef is cheap (~9k keys max) and the overlay's
                // 30 Hz redraw picks up changes immediately.
                const currentPts = video.currentTime * PTS_TIMEBASE;
                const ptsPerFrame = 3000;
                const tolerance = ptsPerFrame;
                // retentionFrames = N → show the current frame plus N−1 prior
                // frames (user-defined semantics). Always include a 1-frame
                // forward tolerance so bboxes that arrive a tick before the
                // matching video frame still get rendered.
                const retentionWindow = ptsPerFrame * Math.max(0, retentionFramesRef.current - 1);
                const lo = currentPts - retentionWindow;
                const hi = currentPts + tolerance;

                const active: BBox[] = [];
                for (const [pts, bboxes] of bboxGroupsRef.current) {
                    if (pts >= lo && pts <= hi) {
                        for (const b of bboxes) active.push(b);
                    }
                }
                activeBBoxesRef.current = active;
                recorderBBoxesRef.current = showBBoxesRef.current ? active : [];
                activeVersionRef.current++;
            } else if (activeBBoxesRef.current.length > 0) {
                activeBBoxesRef.current = [];
                recorderBBoxesRef.current = [];
                activeVersionRef.current++;
            }
            raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(raf);
    }, [drainBboxBuffer, videoRef]);

    // -------------------------------------------------------------------
    // Clip selection
    // -------------------------------------------------------------------
    const makeDefaultClipSelection = useCallback((): ClipSelection | null => {
        const { playhead, duration, isReady } = dvr.state;
        if (!isReady || duration <= 0) return null;
        const startSec = playhead;
        const endSec = Math.min(playhead + DEFAULT_CLIP_SEC, duration);
        return {
            startPts: Math.round(startSec * PTS_TIMEBASE),
            endPts: Math.round(endSec * PTS_TIMEBASE),
        };
    }, [dvr.state]);

    // Once dash.js is both manifest-ready and has seeked to live, consider
    // the player fully loaded. We don't demote this flag back to false when
    // the user seeks into DVR — the initial black-screen → auto-snap-to-
    // live transition is the only window we want to hide.
    useEffect(() => {
        if (selectedStreamId === null) return;
        if (!dvr.state.isReady || !dvr.state.isLive) return;
        setPlayerReady(true);
    }, [selectedStreamId, dvr.state.isReady, dvr.state.isLive]);

    // If the playhead lands on live (either via BACK TO LIVE or by naturally
    // catching up to the live edge), the clip-selection overlay is no longer
    // meaningful — the "Create clip"/"Save clip" buttons have already been
    // swapped out for "Save last Xs", so we drop the overlay here too.
    useEffect(() => {
        if (clipSelection && dvr.state.isLive) setClipSelection(null);
    }, [clipSelection, dvr.state.isLive]);

    // Cancel the clip when it slides off the left edge of the DVR. Otherwise
    // the yellow box tries to render at a negative pixel position — visually
    // "beyond the boundaries" — and the user has likely forgotten they
    // created a selection anyway.
    useEffect(() => {
        if (!clipSelection) return;
        if (!dvr.state.isReady) return;
        const clipStartSec = clipSelection.startPts / PTS_TIMEBASE;
        if (clipStartSec < dvr.state.dvrStart) {
            setClipSelection(null);
        }
    }, [clipSelection, dvr.state.dvrStart, dvr.state.isReady]);

    // -------------------------------------------------------------------
    // Seek / transport
    // -------------------------------------------------------------------
    const handleSeekTo = useCallback((t: number) => { dvr.seekTo(t); }, [dvr]);

    // Skip does not shift the clip: the clip is anchored to an absolute PTS
    // range by design, so seeking around it leaves the selection where the
    // user put it.
    const handleSeekBy = useCallback((delta: number) => {
        if (delta > 0 && dvr.state.isLive) return;
        dvr.seekBy(delta);
        showSkipFeedback(delta);
    }, [dvr, showSkipFeedback]);

    const handleBackToLive = useCallback(() => {
        setClipSelection(null);
        dvr.seekToLive();
        dvr.play();
    }, [dvr]);

    const handleTogglePlay = useCallback(() => { dvr.togglePlay(); }, [dvr]);

    const handleCreateClip = useCallback(() => {
        if (isLive) return;
        const sel = makeDefaultClipSelection();
        if (sel) setClipSelection(sel);
    }, [isLive, makeDefaultClipSelection]);

    const handleSaveLiveClip = useCallback(() => { saveRecording(); }, [saveRecording]);

    const handleSaveDvrClip = useCallback(async () => {
        if (!clipSelection || !manifestUrl || !selectedStreamId || isExporting) return;
        const lengthSec = (clipSelection.endPts - clipSelection.startPts) / PTS_TIMEBASE;
        if (lengthSec > MAX_CLIP_SEC) {
            toast.error(`Clip is too long (max ${MAX_CLIP_SEC}s)`);
            return;
        }
        const ok = await exportClip({
            videoId: selectedStreamId,
            manifestUrl,
            startPts: clipSelection.startPts,
            endPts: clipSelection.endPts,
            bboxGroups: bboxGroupsRef.current,
            showBBoxes,
            confidence,
            originalWidth: originalRes.width,
            originalHeight: originalRes.height,
        });
        if (ok) setClipSelection(null);
    }, [clipSelection, manifestUrl, selectedStreamId, isExporting, exportClip, showBBoxes, confidence, originalRes]);

    // -------------------------------------------------------------------
    // Fullscreen
    // -------------------------------------------------------------------
    const handleToggleFullscreen = useCallback(() => {
        if (!playerBoxRef.current) return;
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        } else {
            playerBoxRef.current.requestFullscreen().catch(() => {});
        }
    }, []);

    useEffect(() => {
        const onFsChange = () => setIsFullscreen(document.fullscreenElement === playerBoxRef.current);
        document.addEventListener('fullscreenchange', onFsChange);
        return () => document.removeEventListener('fullscreenchange', onFsChange);
    }, []);

    // -------------------------------------------------------------------
    // Tab-visibility: snap back to live on return if user was at live
    // when the tab was hidden. Browsers throttle background-tab video
    // playback (Chrome ~1 fps) but dash.js's range.end keeps advancing
    // at wall-clock, so currentTime falls behind by however long the tab
    // was hidden. DVR positions are NOT touched — the user chose those
    // deliberately.
    // -------------------------------------------------------------------
    const dvrRef = useRef(dvr);
    useEffect(() => { dvrRef.current = dvr; }, [dvr]);

    const wasAtLiveWhenHiddenRef = useRef(false);
    useEffect(() => {
        if (!selectedStreamId) return;
        const onVisibilityChange = () => {
            const d = dvrRef.current;
            if (document.hidden) {
                wasAtLiveWhenHiddenRef.current = d.state.isLive;
            } else if (wasAtLiveWhenHiddenRef.current) {
                d.seekToLive();
                wasAtLiveWhenHiddenRef.current = false;
            }
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', onVisibilityChange);
            wasAtLiveWhenHiddenRef.current = false;
        };
    }, [selectedStreamId]);

    // -------------------------------------------------------------------
    // Playback speed — write to video.playbackRate, and auto-reset to 1×
    // when a fast (>1×) playthrough catches up to live.
    // -------------------------------------------------------------------
    useEffect(() => {
        const v = videoRef.current;
        if (v) v.playbackRate = playbackRate;
    }, [playbackRate]);

    useEffect(() => {
        // Fast-forward through DVR reaches live edge → drop back to 1×
        // so the user transitions cleanly into real-time playback. Also
        // handles the "Back to Live" button while playing fast: seeking
        // to live flips `isLive` true, which triggers this reset.
        if (dvr.state.isLive && playbackRate > 1) {
            setPlaybackRate(1);
        }
    }, [dvr.state.isLive, playbackRate]);

    // -------------------------------------------------------------------
    // Auto-hide controls
    // -------------------------------------------------------------------
    const resetHideControls = useCallback(() => {
        setShowControls(true);
        if (hideControlsTimeoutRef.current) clearTimeout(hideControlsTimeoutRef.current);
        if (dvr.state.isPaused) return;
        hideControlsTimeoutRef.current = setTimeout(() => setShowControls(false), CONTROLS_HIDE_MS);
    }, [dvr.state.isPaused]);

    useEffect(() => {
        if (!selectedStreamId) return;
        resetHideControls();
        return () => {
            if (hideControlsTimeoutRef.current) clearTimeout(hideControlsTimeoutRef.current);
        };
    }, [selectedStreamId, resetHideControls]);

    // -------------------------------------------------------------------
    // Keyboard shortcuts
    // -------------------------------------------------------------------
    useEffect(() => {
        if (!selectedStreamId) return;
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            const tag = target?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;

            if (e.code === 'Space') {
                e.preventDefault();
                handleTogglePlay();
                resetHideControls();
            } else if (e.key === 'f' || e.key === 'F') {
                e.preventDefault();
                handleToggleFullscreen();
            } else if (e.key === 'Escape') {
                if (clipSelection) setClipSelection(null);
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                handleSeekBy(-5);
                resetHideControls();
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                handleSeekBy(5);
                resetHideControls();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [selectedStreamId, handleTogglePlay, handleToggleFullscreen, handleSeekBy, clipSelection, resetHideControls]);

    // -------------------------------------------------------------------
    // Render
    // -------------------------------------------------------------------
    const getFullManifestUrl = (path: string) => path.startsWith('http') ? path : `${getBackendUrl()}${path}`;

    const handleVideoSurfaceClick = useCallback(() => {
        handleTogglePlay();
        resetHideControls();
    }, [handleTogglePlay, resetHideControls]);

    const handleVideoSurfaceDblClick = useCallback(() => {
        handleToggleFullscreen();
    }, [handleToggleFullscreen]);

    const shouldShowControls = playerReady && (showControls || dvr.state.isPaused || !!clipSelection || exportProgress !== null);

    // ================================================================
    // Grid view — shown when no stream is selected.
    // ================================================================
    if (selectedStreamId === null) {
        return (
            <div className="space-y-8">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                    <div>
                        <h2 className="text-2xl font-bold text-white">Stream Viewer</h2>
                        <p className="text-zinc-400 mt-1">
                            {streams.length === 0
                                ? 'No streams are currently live.'
                                : `${streams.length} active stream${streams.length === 1 ? '' : 's'}.`}
                        </p>
                    </div>
                    <div className="flex space-x-3">
                        <button onClick={fetchStreams} className="btn btn-secondary">
                            <RefreshCw className="w-4 h-4 mr-2" />
                            Refresh
                        </button>
                    </div>
                </div>

                {streams.length === 0 ? (
                    <div className="card flex flex-col items-center justify-center p-16 text-center">
                        <div className="mb-4 rounded-full bg-zinc-800 p-5">
                            <Tv className="h-8 w-8 text-zinc-500" />
                        </div>
                        <p className="text-base font-medium text-zinc-300">No active streams</p>
                        <p className="mt-1 text-sm text-zinc-500">
                            Start a stream from the Management tab to watch it here.
                        </p>
                    </div>
                ) : (
                    <div className="card p-4">
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                            {streams.map(s => (
                                <StreamCard key={s.id} stream={s} onSelect={handleStreamSelect} />
                            ))}
                        </div>
                    </div>
                )}
            </div>
        );
    }

    // ================================================================
    // Player view — full-area with auto-hide title + controls overlays.
    // ================================================================
    return (
        <div className="h-[calc(100vh-8rem)]">
            <div
                ref={playerBoxRef}
                className={clsx(
                    'relative h-full w-full overflow-hidden rounded-xl border border-zinc-800 bg-black shadow-2xl group',
                    isFullscreen && 'rounded-none border-0'
                )}
                onMouseMove={resetHideControls}
            >
                <div ref={containerRef} className="relative h-full w-full">
                    {manifestUrl && (
                        <div
                            className={clsx(
                                'absolute inset-0 transition-opacity duration-200',
                                playerReady ? 'opacity-100' : 'opacity-0',
                            )}
                        >
                            <VideoPlayer
                                ref={videoRef}
                                manifestUrl={getFullManifestUrl(manifestUrl)}
                                onResolutionChange={(w, h) => setOriginalRes({ width: w, height: h })}
                                onError={(err) => { toast.error(err); handleStopWatchingWithUnsub(); }}
                                onPlayerReady={dvr.setPlayer}
                            />
                        </div>
                    )}

                    {/* Loading overlay — shown until dash.js is at live. */}
                    {!playerReady && (
                        <div className="absolute inset-0 z-[2] flex items-center justify-center bg-black">
                            <div className="flex flex-col items-center gap-3 text-zinc-400">
                                <div className="w-10 h-10 rounded-full border-2 border-zinc-700 border-t-primary animate-spin" />
                                <span className="text-xs">Connecting to live…</span>
                            </div>
                        </div>
                    )}

                    {/* Click-to-play layer between the video and the controls.
                        Disabled while loading so a mis-click can't pause a
                        video the user can't see. */}
                    {playerReady && (
                        <div
                            className="absolute inset-0 z-[1] cursor-pointer"
                            onClick={handleVideoSurfaceClick}
                            onDoubleClick={handleVideoSurfaceDblClick}
                        />
                    )}

                    <BBoxOverlay
                        bboxesRef={activeBBoxesRef}
                        versionRef={activeVersionRef}
                        originalWidth={originalRes.width}
                        originalHeight={originalRes.height}
                        width={containerSize.width}
                        height={containerSize.height}
                        confidenceRef={confidenceRef}
                        show={showBBoxes}
                        offsetX={videoOffset.x}
                        offsetY={videoOffset.y}
                    />

                    {skipFeedback && (
                        <div
                            key={skipFeedback.key}
                            className={clsx(
                                'pointer-events-none absolute top-1/2 z-[3] -translate-y-1/2',
                                'flex h-24 w-24 items-center justify-center rounded-full bg-black/55 text-lg font-semibold text-white',
                                'animate-[skipFade_700ms_ease-out_forwards]',
                                skipFeedback.delta < 0 ? 'left-16' : 'right-16'
                            )}
                        >
                            {skipFeedback.delta > 0 ? '+' : ''}{skipFeedback.delta}s
                        </div>
                    )}

                    {/* Title overlay — auto-hides in sync with the bottom controls */}
                    <div
                        className={clsx(
                            'absolute left-0 right-0 top-0 z-10 transition-opacity duration-300',
                            shouldShowControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
                        )}
                    >
                        <div className="bg-gradient-to-b from-black/90 via-black/50 to-transparent px-5 pb-8 pt-4">
                            <div className="flex items-baseline gap-2 text-white">
                                <span className="text-sm font-medium truncate">
                                    {selectedStream?.name ?? 'Stream'}
                                </span>
                                <span className="shrink-0 font-mono text-[11px] text-zinc-400">
                                    #{selectedStreamId}
                                </span>
                                {selectedStream && (
                                    <span className="ml-auto shrink-0 font-mono text-[11px] text-zinc-500">
                                        {selectedStream.width}×{selectedStream.height} · {selectedStream.fps.toFixed(0)}fps
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Bottom controls */}
                    <div
                        className={clsx(
                            'absolute bottom-0 left-0 right-0 z-10 transition-opacity duration-300',
                            shouldShowControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
                        )}
                        onMouseMove={(e) => { e.stopPropagation(); resetHideControls(); }}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                    >
                        <PlayerControls
                            dvrState={dvr.state}
                            bboxGroups={bboxGroups}
                            clipSelection={clipSelection}
                            onClipSelectionChange={setClipSelection}
                            showBBoxes={showBBoxes}
                            onShowBBoxesChange={setShowBBoxes}
                            analyticsLocked={analyticsLocked}
                            confidence={confidence}
                            onConfidenceChange={setConfidence}
                            retentionFrames={retentionFrames}
                            onRetentionFramesChange={setRetentionFrames}
                            playbackRate={playbackRate}
                            onPlaybackRateChange={setPlaybackRate}
                            onSeekTo={handleSeekTo}
                            onSeekBy={handleSeekBy}
                            onBackToLive={handleBackToLive}
                            onTogglePlay={handleTogglePlay}
                            onStopWatching={handleStopWatchingWithUnsub}
                            isFullscreen={isFullscreen}
                            onToggleFullscreen={handleToggleFullscreen}
                            liveRecordingDuration={recordingDuration}
                            onSaveLiveClip={handleSaveLiveClip}
                            onCreateClip={handleCreateClip}
                            onSaveClip={handleSaveDvrClip}
                            exportProgress={exportProgress}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};
