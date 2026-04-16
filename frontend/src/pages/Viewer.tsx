import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import { listVideos } from '../api/streams';
import { getBackendUrl } from '../api/client';
import type { VideoInfo, BBox, VideoUpdateMessage } from '../types';
import { VideoPlayer } from '../components/VideoPlayer';
import { BBoxOverlay } from '../components/BBoxOverlay';
import { useWebSocket } from '../hooks/useWebSocket';
import { useVideoRecorder } from '../hooks/useVideoRecorder';
import { RefreshCw, Square, Eye, EyeOff, Play, Pin, Monitor, Activity, Download, ChevronDown, Check } from 'lucide-react';
import clsx from 'clsx';

// Custom stream selector dropdown
const StreamSelector: React.FC<{
    streams: VideoInfo[];
    selectedId: number | null;
    onSelect: (id: number) => void;
    disabled: boolean;
}> = ({ streams, selectedId, onSelect, disabled }) => {
    const [open, setOpen] = useState(false);
    const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
    const triggerRef = useRef<HTMLDivElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    const selected = streams.find(s => s.id === selectedId);

    // Position the portal dropdown under the trigger button
    useEffect(() => {
        if (!open || !triggerRef.current) return;
        const rect = triggerRef.current.getBoundingClientRect();
        setDropdownStyle({
            position: 'fixed',
            top: rect.bottom + 4,
            left: rect.left,
            width: rect.width,
            zIndex: 9999,
        });
    }, [open]);

    // Close on outside click — must exclude both the trigger AND the portal dropdown
    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            const target = e.target as Node;
            const insideTrigger = triggerRef.current?.contains(target) ?? false;
            const insideDropdown = dropdownRef.current?.contains(target) ?? false;
            if (!insideTrigger && !insideDropdown) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    return (
        <div ref={triggerRef} className="relative w-72">
            <button
                onClick={() => !disabled && setOpen(o => !o)}
                disabled={disabled}
                className={clsx(
                    "w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border text-sm transition-colors",
                    "bg-zinc-900 border-zinc-700 text-zinc-200",
                    disabled
                        ? "opacity-60 cursor-not-allowed"
                        : "hover:border-zinc-500 hover:bg-zinc-800 cursor-pointer",
                    open && "border-primary/50 ring-1 ring-primary/20"
                )}
            >
                <div className="flex items-center gap-2 min-w-0">
                    <Monitor className="w-4 h-4 text-zinc-500 shrink-0" />
                    {selected ? (
                        <span className="truncate">
                            <span className="text-zinc-500 font-mono text-xs mr-1">#{selected.id}</span>
                            {selected.name}
                        </span>
                    ) : (
                        <span className="text-zinc-500">Select a stream...</span>
                    )}
                </div>
                <ChevronDown className={clsx("w-4 h-4 text-zinc-500 shrink-0 transition-transform", open && "rotate-180")} />
            </button>

            {open && createPortal(
                <div ref={dropdownRef} style={dropdownStyle} className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl overflow-hidden">
                    {streams.length === 0 ? (
                        <div className="px-3 py-6 text-center text-zinc-500 text-sm">
                            No active streams
                        </div>
                    ) : (
                        <ul className="max-h-64 overflow-y-auto py-1">
                            {streams.map(s => (
                                <li key={s.id}>
                                    <button
                                        onClick={() => {
                                            onSelect(s.id);
                                            setOpen(false);
                                        }}
                                        className={clsx(
                                            "w-full flex items-center gap-3 px-3 py-2.5 text-sm text-left transition-colors",
                                            s.id === selectedId
                                                ? "bg-primary/10 text-primary"
                                                : "hover:bg-zinc-800 text-zinc-200"
                                        )}
                                    >
                                        <span className="w-5 shrink-0">
                                            {s.id === selectedId && <Check className="w-4 h-4" />}
                                        </span>
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="font-medium truncate">{s.name}</span>
                                                <span className="text-zinc-500 font-mono text-xs shrink-0">#{s.id}</span>
                                            </div>
                                            <div className="text-xs text-zinc-500 mt-0.5">
                                                {s.width}×{s.height} · {s.fps.toFixed(0)} fps
                                            </div>
                                        </div>
                                        <span className="ml-auto shrink-0 w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>,
                document.body
            )}
        </div>
    );
};

export const Viewer: React.FC = () => {
    const [searchParams] = useSearchParams();
    const autoStreamId = parseInt(searchParams.get('stream_id') ?? '') || null;

    const [streams, setStreams] = useState<VideoInfo[]>([]);
    const [selectedStreamId, setSelectedStreamId] = useState<number | null>(null);
    const [manifestUrl, setManifestUrl] = useState<string | null>(null);

    const [minConfidence, setMinConfidence] = useState(0.0);
    const [retentionFrames, setRetentionFrames] = useState(1);
    const [showBBoxes, setShowBBoxes] = useState(true);
    const [showControls, setShowControls] = useState(true);

    const [originalRes, setOriginalRes] = useState({ width: 0, height: 0 });
    const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
    const [videoOffset, setVideoOffset] = useState({ x: 0, y: 0 });

    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const requestRef = useRef<number>(null);
    const selectedStreamIdRef = useRef<number | null>(null);

    // Keep ref in sync for use inside callbacks without stale closure
    useEffect(() => {
        selectedStreamIdRef.current = selectedStreamId;
    }, [selectedStreamId]);

    const handleStopWatching = useCallback(() => {
        setSelectedStreamId(null);
        setManifestUrl(null);
        setOriginalRes({ width: 0, height: 0 });
    }, []);

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

        // Detect stream end for currently watched stream
        if (
            currentId !== null &&
            videoId === currentId &&
            (msg.reason === 'stream_stopped' || msg.reason === 'stream_error' || msg.reason === 'deleted')
        ) {
            handleStreamEnded();
        }

        // Maintain streams list (only streaming videos shown)
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

    const [activeBBoxes, setActiveBBoxes] = useState<BBox[]>([]);

    const { isRecording, recordingDuration, stopRecording, saveRecording } = useVideoRecorder({
        videoRef,
        bboxes: showBBoxes ? activeBBoxes : [],
        originalWidth: originalRes.width,
        originalHeight: originalRes.height,
        minConfidence
    });

    useEffect(() => {
        return () => stopRecording();
    }, [selectedStreamId, stopRecording]);

    // Fetch initial list of streaming videos
    const fetchStreams = useCallback(async () => {
        try {
            const allVideos = await listVideos();
            setStreams(allVideos.filter(v => v.stream_status === 'streaming'));
        } catch {
            // silently ignore — WS-triggered refetch below handles recovery
        }
    }, []);

    // Initial fetch on mount
    useEffect(() => {
        fetchStreams();
    }, [fetchStreams]);

    // Re-fetch when WS first connects (recovers from a failed initial fetch)
    const prevConnectedRef = useRef(false);
    useEffect(() => {
        if (isConnected && !prevConnectedRef.current) {
            fetchStreams();
        }
        prevConnectedRef.current = isConnected;
    }, [isConnected, fetchStreams]);

    // Handle stream selection
    const handleStreamSelect = useCallback((id: number) => {
        const stream = streams.find(s => s.id === id);
        if (!stream?.dash_manifest_url) {
            toast.error('No DASH manifest available for this stream');
            return;
        }

        // Unsubscribe from previous if switching
        if (selectedStreamIdRef.current !== null && selectedStreamIdRef.current !== id) {
            unsubscribe(selectedStreamIdRef.current);
        }

        setSelectedStreamId(id);
        setManifestUrl(stream.dash_manifest_url);
        subscribe(id);
    }, [streams, subscribe, unsubscribe]);

    // Auto-select stream from URL param once streams list is populated
    const autoSelectedRef = useRef(false);
    useEffect(() => {
        if (autoSelectedRef.current || !autoStreamId || selectedStreamId !== null) return;
        const stream = streams.find(s => s.id === autoStreamId);
        if (stream?.dash_manifest_url) {
            autoSelectedRef.current = true;
            handleStreamSelect(autoStreamId);
        }
    }, [streams, autoStreamId, selectedStreamId, handleStreamSelect]);

    // Unsubscribe when stopping watching
    const handleStopWatchingWithUnsub = useCallback(() => {
        if (selectedStreamIdRef.current !== null) {
            unsubscribe(selectedStreamIdRef.current);
        }
        handleStopWatching();
    }, [unsubscribe, handleStopWatching]);

    // Resize Observer
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

        const videoElement = videoRef.current;
        if (videoElement) {
            videoElement.addEventListener('loadedmetadata', updateSize);
            videoElement.addEventListener('resize', updateSize);
        }

        return () => {
            observer.disconnect();
            if (videoElement) {
                videoElement.removeEventListener('loadedmetadata', updateSize);
                videoElement.removeEventListener('resize', updateSize);
            }
        };
    }, [selectedStreamId, originalRes]);

    // Animation Loop for BBox sync
    const animate = useCallback(() => {
        if (!videoRef.current || !selectedStreamId) {
            requestRef.current = requestAnimationFrame(animate);
            return;
        }

        const currentTime = videoRef.current.currentTime;
        const buffer = bboxBuffer.current;
        const currentPts = currentTime * 90000;
        const ptsPerFrame = 3000;
        const tolerance = ptsPerFrame * 2;
        const retentionWindow = ptsPerFrame * retentionFrames;
        const activeBBoxes: BBox[] = [];
        const MAX_PTS = 8589934592;

        for (let i = buffer.length - 1; i >= 0; i--) {
            const msg = buffer[i];
            const diff = currentPts - msg.pts;
            const k = Math.round(diff / MAX_PTS);
            const unwrappedPts = msg.pts + (k * MAX_PTS);

            if (unwrappedPts <= currentPts + tolerance && unwrappedPts >= currentPts - retentionWindow) {
                activeBBoxes.push(...msg.bboxes);
            }
        }

        setActiveBBoxes(activeBBoxes);
        requestRef.current = requestAnimationFrame(animate);
    }, [selectedStreamId, retentionFrames, bboxBuffer]);

    useEffect(() => {
        requestRef.current = requestAnimationFrame(animate);
        return () => {
            if (requestRef.current) cancelAnimationFrame(requestRef.current);
        };
    }, [animate]);

    const getFullManifestUrl = (path: string) => {
        if (path.startsWith('http')) return path;
        return `${getBackendUrl()}${path}`;
    };

    return (
        <div className="h-[calc(100vh-8rem)] flex flex-col gap-6">
            {/* Stream Selection Bar */}
            <div className="card p-4 flex items-center justify-between bg-surface/50 backdrop-blur-sm">
                <div className="flex items-center gap-3 flex-1">
                    <StreamSelector
                        streams={streams}
                        selectedId={selectedStreamId}
                        onSelect={handleStreamSelect}
                        disabled={!!selectedStreamId}
                    />

                    {!selectedStreamId && (
                        <button
                            onClick={fetchStreams}
                            className="btn btn-ghost p-2 rounded-full"
                            title="Refresh Streams"
                        >
                            <RefreshCw className="w-4 h-4" />
                        </button>
                    )}
                </div>

                {selectedStreamId && (
                    <div className="flex items-center gap-3">
                        <div className={clsx(
                            "flex items-center px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
                            isConnected
                                ? "bg-green-500/10 text-green-400 border-green-500/20"
                                : "bg-red-500/10 text-red-400 border-red-500/20"
                        )}>
                            <Activity className="w-3 h-3 mr-1.5" />
                            {isConnected ? 'Live' : 'Reconnecting...'}
                        </div>

                        <button
                            onClick={handleStopWatchingWithUnsub}
                            className="btn btn-danger text-xs px-3 py-1.5"
                        >
                            <Square className="w-3 h-3 mr-1.5" />
                            Stop Watching
                        </button>
                    </div>
                )}
            </div>

            {/* Main Viewer Area */}
            <div className="flex-1 flex gap-6 min-h-0">
                <div className="flex-1 bg-black rounded-xl overflow-hidden relative shadow-2xl border border-zinc-800 group">
                    {!selectedStreamId ? (
                        <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-600 bg-zinc-950">
                            <div className="p-6 rounded-full bg-zinc-900 mb-4">
                                <Play className="w-12 h-12 opacity-50" />
                            </div>
                            <p className="text-lg font-medium">Select a stream to start watching</p>
                        </div>
                    ) : (
                        <div ref={containerRef} className="relative w-full h-full">
                            {manifestUrl && (
                                <VideoPlayer
                                    ref={videoRef}
                                    manifestUrl={getFullManifestUrl(manifestUrl)}
                                    onResolutionChange={(w, h) => setOriginalRes({ width: w, height: h })}
                                    onError={(err) => {
                                        toast.error(err);
                                        handleStopWatchingWithUnsub();
                                    }}
                                />
                            )}
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

                            {/* Overlay Controls */}
                            <div className={clsx(
                                "absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/90 via-black/50 to-transparent transition-opacity duration-300",
                                showControls ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                            )}>
                                <div className="flex items-center justify-between max-w-3xl mx-auto bg-zinc-900/90 backdrop-blur-md rounded-xl p-4 border border-white/10 shadow-xl">
                                    <div className="flex items-center gap-6">
                                        <div className="flex flex-col gap-1">
                                            <label className="text-[10px] uppercase tracking-wider font-bold text-zinc-500">Confidence</label>
                                            <div className="flex items-center gap-3">
                                                <input
                                                    type="range"
                                                    min="0"
                                                    max="1"
                                                    step="0.05"
                                                    value={minConfidence}
                                                    onChange={(e) => setMinConfidence(parseFloat(e.target.value))}
                                                    className="w-24 accent-primary h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer"
                                                />
                                                <span className="text-xs font-mono text-primary w-8 text-right">{(minConfidence * 100).toFixed(0)}%</span>
                                            </div>
                                        </div>

                                        <div className="w-px h-8 bg-zinc-700" />

                                        <div className="flex flex-col gap-1">
                                            <label className="text-[10px] uppercase tracking-wider font-bold text-zinc-500">Retention</label>
                                            <div className="flex items-center gap-2">
                                                <input
                                                    type="number"
                                                    min="1"
                                                    max="30"
                                                    value={retentionFrames}
                                                    onChange={(e) => setRetentionFrames(parseInt(e.target.value))}
                                                    className="w-12 bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-xs text-center focus:border-primary outline-none"
                                                />
                                                <span className="text-xs text-zinc-400">frames</span>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-3">
                                        <div className="flex items-center gap-1 mr-2 border-r border-white/10 pr-3">
                                            {isRecording && (
                                                <button
                                                    onClick={saveRecording}
                                                    className="flex items-center px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/20 transition-all animate-pulse"
                                                    title="Save Buffered Video"
                                                >
                                                    <Download className="w-3 h-3 mr-1.5" />
                                                    Save Last {recordingDuration}s
                                                </button>
                                            )}
                                        </div>

                                        <button
                                            onClick={() => setShowBBoxes(!showBBoxes)}
                                            className={clsx(
                                                "flex items-center px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                                                showBBoxes
                                                    ? "bg-primary text-white shadow-lg shadow-primary/25"
                                                    : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                                            )}
                                        >
                                            {showBBoxes ? <Eye className="w-3 h-3 mr-1.5" /> : <EyeOff className="w-3 h-3 mr-1.5" />}
                                            AI Analytics {showBBoxes ? 'On' : 'Off'}
                                        </button>

                                        <button
                                            onClick={() => setShowControls(!showControls)}
                                            className={clsx(
                                                "p-2 rounded-lg transition-colors",
                                                showControls ? "text-primary bg-primary/10" : "text-zinc-400 hover:text-white"
                                            )}
                                            title="Toggle Controls Pin"
                                        >
                                            <Pin className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
