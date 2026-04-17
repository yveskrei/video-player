import { useEffect, useRef, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { listVideos, listBboxes } from '../api/streams';
import { getBackendUrl } from '../api/client';
import type { VideoInfo, BBox, VideoUpdateMessage, ClipSelection } from '../types';
import { VideoPlayer } from '../components/VideoPlayer';
import { BBoxOverlay } from '../components/BBoxOverlay';
import { PlayerControls } from '../components/PlayerControls';
import { StreamCard } from '../components/StreamCard';
import { useWebSocket } from '../hooks/useWebSocket';
import { useVideoRecorder } from '../hooks/useVideoRecorder';
import { useDvrPlayer } from '../hooks/useDvrPlayer';
import { exportDvrClip } from '../utils/exportDvrClip';
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

    const [minConfidence, setMinConfidence] = useState(0.0);
    const [retentionFrames, setRetentionFrames] = useState(1);
    const [showBBoxes, setShowBBoxes] = useState(true);

    const [originalRes, setOriginalRes] = useState({ width: 0, height: 0 });
    const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
    const [videoOffset, setVideoOffset] = useState({ x: 0, y: 0 });

    const [clipSelection, setClipSelection] = useState<ClipSelection | null>(null);
    const [exportProgress, setExportProgress] = useState<number | null>(null);
    const exportToastIdRef = useRef<string | null>(null);

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
    const requestRef = useRef<number>(null);
    const selectedStreamIdRef = useRef<number | null>(null);

    useEffect(() => {
        selectedStreamIdRef.current = selectedStreamId;
    }, [selectedStreamId]);

    const dvr = useDvrPlayer(videoRef);
    const isLive = dvr.state.isLive;

    const [bboxGroups, setBboxGroups] = useState<Map<number, BBox[]>>(new Map());
    const bboxGroupsRef = useRef(bboxGroups);
    useEffect(() => { bboxGroupsRef.current = bboxGroups; }, [bboxGroups]);

    const [activeBBoxes, setActiveBBoxes] = useState<BBox[]>([]);

    const { recordingDuration, saveRecording } = useVideoRecorder({
        videoRef,
        bboxes: showBBoxes ? activeBBoxes : [],
        originalWidth: originalRes.width,
        originalHeight: originalRes.height,
        minConfidence,
        enabled: isLive && selectedStreamId !== null,
    });

    const selectedStream = selectedStreamId !== null
        ? streams.find(s => s.id === selectedStreamId) ?? null
        : null;

    // -------------------------------------------------------------------
    // Stream lifecycle
    // -------------------------------------------------------------------

    const handleStopWatching = useCallback(() => {
        setSelectedStreamId(null);
        setManifestUrl(null);
        setOriginalRes({ width: 0, height: 0 });
        setBboxGroups(new Map());
        setClipSelection(null);
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
        const additions: Array<[number, BBox[]]> = [];
        for (const msg of buf) additions.push([msg.pts, msg.bboxes]);
        buf.length = 0;
        if (additions.length === 0) return;
        setBboxGroups(prev => {
            const next = new Map(prev);
            for (const [pts, bboxes] of additions) {
                const existing = next.get(pts);
                next.set(pts, existing ? [...existing, ...bboxes] : bboxes);
            }
            return next;
        });
    }, [bboxBuffer]);

    useEffect(() => {
        if (!dvr.state.isReady || dvr.state.dvrWindowSize <= 0) return;
        const minPts = dvr.state.dvrStart * PTS_TIMEBASE;
        setBboxGroups(prev => {
            let changed = false;
            const next = new Map(prev);
            for (const pts of next.keys()) {
                if (pts < minPts) {
                    next.delete(pts);
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [dvr.state.dvrStart, dvr.state.dvrWindowSize, dvr.state.isReady]);

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

    const handleStreamSelect = useCallback(async (id: number) => {
        const stream = streams.find(s => s.id === id);
        if (!stream?.dash_manifest_url) {
            toast.error('No DASH manifest available for this stream');
            return;
        }

        if (selectedStreamIdRef.current !== null && selectedStreamIdRef.current !== id) {
            unsubscribe(selectedStreamIdRef.current);
        }

        autoSelectedRef.current = true;
        setSelectedStreamId(id);
        setManifestUrl(stream.dash_manifest_url);
        setBboxGroups(new Map());
        setClipSelection(null);
        setSearchParams(prev => {
            const next = new URLSearchParams(prev);
            next.set('stream_id', String(id));
            return next;
        }, { replace: true });
        subscribe(id);

        try {
            const history = await listBboxes(id);
            const seeded = new Map<number, BBox[]>();
            for (const g of history.groups) seeded.set(g.pts, g.bboxes);
            setBboxGroups(seeded);
        } catch (e) {
            console.warn('Failed to fetch historical bboxes', e);
        }
    }, [streams, subscribe, unsubscribe, setSearchParams]);

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
    // BBox sync animation loop
    // -------------------------------------------------------------------
    const animate = useCallback(() => {
        drainBboxBuffer();

        if (!videoRef.current || !selectedStreamId) {
            requestRef.current = requestAnimationFrame(animate);
            return;
        }

        const currentTime = videoRef.current.currentTime;
        const currentPts = currentTime * PTS_TIMEBASE;
        const ptsPerFrame = 3000;
        const tolerance = ptsPerFrame * 2;
        const retentionWindow = ptsPerFrame * retentionFrames;

        const active: BBox[] = [];
        for (const [pts, bboxes] of bboxGroupsRef.current) {
            if (pts <= currentPts + tolerance && pts >= currentPts - retentionWindow) {
                active.push(...bboxes);
            }
        }

        setActiveBBoxes(active);
        requestRef.current = requestAnimationFrame(animate);
    }, [selectedStreamId, retentionFrames, drainBboxBuffer]);

    useEffect(() => {
        requestRef.current = requestAnimationFrame(animate);
        return () => {
            if (requestRef.current) cancelAnimationFrame(requestRef.current);
        };
    }, [animate]);

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

    useEffect(() => {
        if (!clipSelection) return;
        const { duration } = dvr.state;
        const lengthSec = (clipSelection.endPts - clipSelection.startPts) / PTS_TIMEBASE;
        const startSec = clipSelection.startPts / PTS_TIMEBASE;
        const idealEndSec = startSec + DEFAULT_CLIP_SEC;
        if (lengthSec < DEFAULT_CLIP_SEC && idealEndSec <= duration) {
            const newEndSec = Math.min(idealEndSec, duration);
            setClipSelection({
                startPts: clipSelection.startPts,
                endPts: Math.round(newEndSec * PTS_TIMEBASE),
            });
        }
    }, [dvr.state.duration, clipSelection]);

    const shiftClipSelectionBy = useCallback((deltaSec: number) => {
        setClipSelection(prev => {
            if (!prev) return prev;
            const { duration, dvrStart } = dvr.state;
            const lengthSec = (prev.endPts - prev.startPts) / PTS_TIMEBASE;
            let startSec = prev.startPts / PTS_TIMEBASE + deltaSec;
            if (startSec < dvrStart) startSec = dvrStart;
            if (startSec + lengthSec > duration) startSec = Math.max(dvrStart, duration - lengthSec);
            return {
                startPts: Math.round(startSec * PTS_TIMEBASE),
                endPts: Math.round((startSec + lengthSec) * PTS_TIMEBASE),
            };
        });
    }, [dvr.state]);

    // -------------------------------------------------------------------
    // Seek / transport
    // -------------------------------------------------------------------
    const handleSeekTo = useCallback((t: number) => { dvr.seekTo(t); }, [dvr]);

    const handleSeekBy = useCallback((delta: number) => {
        if (delta > 0 && dvr.state.isLive) return;
        dvr.seekBy(delta);
        if (clipSelection) shiftClipSelectionBy(delta);
        showSkipFeedback(delta);
    }, [dvr, clipSelection, shiftClipSelectionBy, showSkipFeedback]);

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
        if (!clipSelection || !manifestUrl || !selectedStreamId) return;
        const lengthSec = (clipSelection.endPts - clipSelection.startPts) / PTS_TIMEBASE;
        if (lengthSec > MAX_CLIP_SEC) {
            toast.error(`Clip is too long (max ${MAX_CLIP_SEC}s)`);
            return;
        }
        const fullManifestUrl = manifestUrl.startsWith('http')
            ? manifestUrl
            : `${getBackendUrl()}${manifestUrl}`;

        setExportProgress(0);
        const tid = toast.loading('Exporting clip… 0%');
        exportToastIdRef.current = tid;
        try {
            await exportDvrClip({
                backendUrl: getBackendUrl(),
                videoId: selectedStreamId,
                manifestUrl: fullManifestUrl,
                startPts: clipSelection.startPts,
                endPts: clipSelection.endPts,
                bboxGroups: bboxGroupsRef.current,
                showBBoxes,
                minConfidence,
                originalWidth: originalRes.width,
                originalHeight: originalRes.height,
                onProgress: (f) => {
                    setExportProgress(f);
                    toast.loading(`Exporting clip… ${Math.round(f * 100)}%`, { id: tid });
                },
            });
            toast.success('Clip saved', { id: tid });
            setClipSelection(null);
        } catch (e) {
            console.error(e);
            toast.error(`Export failed: ${(e as Error).message}`, { id: tid });
        } finally {
            setExportProgress(null);
            exportToastIdRef.current = null;
        }
    }, [clipSelection, manifestUrl, selectedStreamId, showBBoxes, minConfidence, originalRes]);

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
    // Pause-at-oldest manifest throttle
    // -------------------------------------------------------------------
    useEffect(() => {
        const atOldest = dvr.state.isReady && (dvr.state.playhead - dvr.state.dvrStart) < 1;
        const shouldThrottle = dvr.state.isPaused && atOldest;
        dvr.setManifestPollPaused(shouldThrottle);
    }, [dvr, dvr.state.isPaused, dvr.state.playhead, dvr.state.dvrStart, dvr.state.isReady]);

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

    const shouldShowControls = showControls || dvr.state.isPaused || !!clipSelection || exportProgress !== null;

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
                        <VideoPlayer
                            ref={videoRef}
                            manifestUrl={getFullManifestUrl(manifestUrl)}
                            onResolutionChange={(w, h) => setOriginalRes({ width: w, height: h })}
                            onError={(err) => { toast.error(err); handleStopWatchingWithUnsub(); }}
                            onPlayerReady={dvr.setPlayer}
                        />
                    )}

                    {/* Click-to-play layer between the video and the controls */}
                    <div
                        className="absolute inset-0 z-[1] cursor-pointer"
                        onClick={handleVideoSurfaceClick}
                        onDoubleClick={handleVideoSurfaceDblClick}
                    />

                    <BBoxOverlay
                        bboxes={activeBBoxes}
                        originalWidth={originalRes.width}
                        originalHeight={originalRes.height}
                        width={containerSize.width}
                        height={containerSize.height}
                        minConfidence={minConfidence}
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
                            minConfidence={minConfidence}
                            onMinConfidenceChange={setMinConfidence}
                            retentionFrames={retentionFrames}
                            onRetentionFramesChange={setRetentionFrames}
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
