import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { User, Car, Truck, Dog, Cat, HelpCircle, X } from 'lucide-react';
import clsx from 'clsx';
import type { BBox, ClipSelection } from '../types';
import type { DvrState } from '../hooks/useDvrPlayer';

const PTS_TIMEBASE = 90000;
const CLUSTER_PX = 10;

const formatBehindLive = (secondsBehind: number): string => {
    if (secondsBehind <= 0.5) return 'LIVE';
    const total = Math.floor(secondsBehind);
    const hh = Math.floor(total / 3600);
    const mm = Math.floor((total % 3600) / 60);
    const ss = total % 60;
    const pad = (n: number) => n.toString().padStart(2, '0');
    return hh > 0 ? `-${hh}:${pad(mm)}:${pad(ss)}` : `-${pad(mm)}:${pad(ss)}`;
};

const CLASS_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
    person: User,
    car: Car,
    truck: Truck,
    dog: Dog,
    cat: Cat,
};

const iconFor = (className: string) => CLASS_ICON[className.toLowerCase()] ?? HelpCircle;

interface BboxCluster {
    x: number;           // pixel position
    seconds: number;     // stream time (seconds)
    classes: string[];   // unique class names
}

interface SeekbarProps {
    dvrState: DvrState;
    onSeek: (timeSec: number) => void;
    bboxGroups: Map<number, BBox[]>;
    minConfidence: number;
    clipSelection: ClipSelection | null;
    onClipSelectionChange: (sel: ClipSelection | null) => void;
}

export const Seekbar: React.FC<SeekbarProps> = ({
    dvrState,
    onSeek,
    bboxGroups,
    minConfidence,
    clipSelection,
    onClipSelectionChange,
}) => {
    const trackRef = useRef<HTMLDivElement>(null);
    const [trackWidth, setTrackWidth] = useState(0);
    const [hoverX, setHoverX] = useState<number | null>(null);
    const [hoveredCluster, setHoveredCluster] = useState<BboxCluster | null>(null);

    const { playhead, duration, dvrWindowSize, dvrStart, isLive, isReady } = dvrState;

    useLayoutEffect(() => {
        if (!trackRef.current) return;
        const el = trackRef.current;
        const observer = new ResizeObserver(entries => {
            for (const e of entries) setTrackWidth(e.contentRect.width);
        });
        observer.observe(el);
        setTrackWidth(el.getBoundingClientRect().width);
        return () => observer.disconnect();
    }, []);

    const timeToX = useCallback((t: number): number => {
        if (dvrWindowSize <= 0 || trackWidth <= 0) return 0;
        return ((t - dvrStart) / dvrWindowSize) * trackWidth;
    }, [dvrStart, dvrWindowSize, trackWidth]);

    const xToTime = useCallback((x: number): number => {
        if (dvrWindowSize <= 0 || trackWidth <= 0) return 0;
        const clampedX = Math.min(Math.max(x, 0), trackWidth);
        return dvrStart + (clampedX / trackWidth) * dvrWindowSize;
    }, [dvrStart, dvrWindowSize, trackWidth]);

    const playheadX = Math.min(Math.max(timeToX(playhead), 0), trackWidth);

    const clusters = useMemo<BboxCluster[]>(() => {
        if (!isReady || trackWidth <= 0 || dvrWindowSize <= 0) return [];
        const entries = Array.from(bboxGroups.entries()).sort((a, b) => a[0] - b[0]);
        const out: BboxCluster[] = [];
        for (const [pts, bboxes] of entries) {
            const seconds = pts / PTS_TIMEBASE;
            if (seconds < dvrStart || seconds > duration) continue;
            const visible = bboxes.filter(b => b.confidence >= minConfidence);
            if (visible.length === 0) continue;
            const x = timeToX(seconds);
            const last = out[out.length - 1];
            if (last && x - last.x <= CLUSTER_PX) {
                for (const b of visible) {
                    const key = b.class_name.toLowerCase();
                    if (!last.classes.includes(key)) last.classes.push(key);
                }
            } else {
                out.push({
                    x,
                    seconds,
                    classes: Array.from(new Set(visible.map(b => b.class_name.toLowerCase()))),
                });
            }
        }
        return out;
    }, [bboxGroups, isReady, trackWidth, dvrWindowSize, dvrStart, duration, timeToX, minConfidence]);

    const handleTrackPointerDown = useCallback((e: React.PointerEvent) => {
        if (e.button !== 0) return;
        if (!trackRef.current) return;
        const el = e.currentTarget as HTMLElement;
        el.setPointerCapture(e.pointerId);
        const rect = trackRef.current.getBoundingClientRect();
        onSeek(xToTime(e.clientX - rect.left));
    }, [onSeek, xToTime]);

    const handleTrackPointerMove = useCallback((e: React.PointerEvent) => {
        if (!trackRef.current) return;
        const el = e.currentTarget as HTMLElement;
        if (!el.hasPointerCapture(e.pointerId)) return;
        const rect = trackRef.current.getBoundingClientRect();
        onSeek(xToTime(e.clientX - rect.left));
    }, [onSeek, xToTime]);

    const handleTrackPointerUp = useCallback((e: React.PointerEvent) => {
        const el = e.currentTarget as HTMLElement;
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    }, []);

    // Clip drag state — captured at pointer-down to survive re-renders mid-drag.
    const clipDragRef = useRef<{
        pointerId: number;
        startClientX: number;
        initial: ClipSelection;
        trackWidth: number;
        dvrWindowSize: number;
        dvrStart: number;
        duration: number;
    } | null>(null);

    const handleClipPointerDown = useCallback((e: React.PointerEvent) => {
        if (e.button !== 0) return;
        if (!clipSelection) return;
        e.stopPropagation();
        e.preventDefault();
        const el = e.currentTarget as HTMLElement;
        el.setPointerCapture(e.pointerId);
        clipDragRef.current = {
            pointerId: e.pointerId,
            startClientX: e.clientX,
            initial: { ...clipSelection },
            trackWidth,
            dvrWindowSize,
            dvrStart,
            duration,
        };
    }, [clipSelection, trackWidth, dvrWindowSize, dvrStart, duration]);

    const handleClipPointerMove = useCallback((e: React.PointerEvent) => {
        const drag = clipDragRef.current;
        if (!drag || drag.pointerId !== e.pointerId) return;
        if (drag.trackWidth <= 0 || drag.dvrWindowSize <= 0) return;
        const secondsPerPx = drag.dvrWindowSize / drag.trackWidth;
        const dSec = (e.clientX - drag.startClientX) * secondsPerPx;
        const lengthSec = (drag.initial.endPts - drag.initial.startPts) / PTS_TIMEBASE;
        let startSec = drag.initial.startPts / PTS_TIMEBASE + dSec;
        const minStart = drag.dvrStart;
        const maxStart = drag.duration - lengthSec;
        if (startSec < minStart) startSec = minStart;
        if (startSec > maxStart) startSec = maxStart;
        onClipSelectionChange({
            startPts: Math.round(startSec * PTS_TIMEBASE),
            endPts: Math.round((startSec + lengthSec) * PTS_TIMEBASE),
        });
    }, [onClipSelectionChange]);

    const handleClipPointerUp = useCallback((e: React.PointerEvent) => {
        if (clipDragRef.current?.pointerId === e.pointerId) {
            const el = e.currentTarget as HTMLElement;
            if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
            clipDragRef.current = null;
        }
    }, []);

    const handleTrackHover = useCallback((e: React.MouseEvent) => {
        if (!trackRef.current) return;
        const rect = trackRef.current.getBoundingClientRect();
        setHoverX(e.clientX - rect.left);
    }, []);

    const handleTrackLeave = useCallback(() => {
        setHoverX(null);
    }, []);

    const hoverSeconds = hoverX !== null ? xToTime(hoverX) : null;
    const hoverBehind = hoverSeconds !== null ? (duration - hoverSeconds) : null;

    const clipStartX = clipSelection ? timeToX(clipSelection.startPts / PTS_TIMEBASE) : 0;
    const clipEndX = clipSelection ? timeToX(clipSelection.endPts / PTS_TIMEBASE) : 0;
    const clipWidth = Math.max(0, clipEndX - clipStartX);

    return (
        <div className="relative select-none" style={{ paddingTop: 18, paddingBottom: 6 }}>
            {/* Bbox hover dropdown */}
            {hoveredCluster && (
                <div
                    className="absolute z-30 flex items-center gap-1 px-2 py-1.5 rounded-md bg-zinc-900/95 border border-white/15 shadow-xl backdrop-blur-sm pointer-events-none"
                    style={{
                        left: Math.min(Math.max(hoveredCluster.x - 60, 0), Math.max(0, trackWidth - 120)),
                        bottom: 28,
                    }}
                >
                    {hoveredCluster.classes.slice(0, 8).map(cls => {
                        const Icon = iconFor(cls);
                        return (
                            <div key={cls} className="flex items-center gap-1 text-[11px] text-white/90">
                                <Icon className="w-3.5 h-3.5" />
                                <span className="capitalize">{cls}</span>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Hover time tooltip (only when not over a cluster) */}
            {hoverX !== null && hoverBehind !== null && !hoveredCluster && (
                <div
                    className="absolute z-20 px-1.5 py-0.5 rounded text-[10px] font-mono bg-black/80 text-white pointer-events-none"
                    style={{ left: hoverX, bottom: 22, transform: 'translateX(-50%)' }}
                >
                    {formatBehindLive(hoverBehind)}
                </div>
            )}

            {/* Clickable track */}
            <div
                ref={trackRef}
                onPointerDown={handleTrackPointerDown}
                onPointerMove={(e) => { handleTrackPointerMove(e); handleTrackHover(e); }}
                onPointerUp={handleTrackPointerUp}
                onPointerCancel={handleTrackPointerUp}
                onMouseLeave={handleTrackLeave}
                className="relative w-full cursor-pointer group/track touch-none"
                style={{ height: 20 }}
            >
                {/* Hit area — invisible but clickable */}
                <div className="absolute inset-0" />

                {/* Track background */}
                <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-white/15 group-hover/track:h-2 transition-all" />

                {/* Fill (up to playhead; full width in live mode so the bar looks "at live") */}
                <div
                    className={clsx(
                        'absolute left-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full transition-colors group-hover/track:h-2',
                        isLive ? 'bg-red-500' : 'bg-primary'
                    )}
                    style={{ width: isLive ? `${trackWidth}px` : `${playheadX}px` }}
                />

                {/* Clip selection overlay (z-20 so it sits above the bbox clusters at z-10) */}
                {clipSelection && clipWidth > 0 && (
                    <div
                        onPointerDown={handleClipPointerDown}
                        onPointerMove={handleClipPointerMove}
                        onPointerUp={handleClipPointerUp}
                        onPointerCancel={handleClipPointerUp}
                        className="absolute top-1/2 -translate-y-1/2 rounded-sm border-2 border-amber-400 bg-amber-400/30 cursor-grab active:cursor-grabbing group/clip z-20 touch-none"
                        style={{
                            left: `${clipStartX}px`,
                            width: `${Math.max(clipWidth, 8)}px`,
                            height: 18,
                        }}
                        title="Drag to move selection"
                    >
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onClipSelectionChange(null); }}
                            onPointerDown={(e) => e.stopPropagation()}
                            className="absolute -top-5 -right-1 w-4 h-4 rounded-full bg-zinc-900 border border-amber-400 text-amber-300 flex items-center justify-center opacity-100 transition-opacity"
                            title="Cancel clip"
                        >
                            <X className="w-2.5 h-2.5" />
                        </button>
                    </div>
                )}

                {/* Bbox clusters */}
                {clusters.map((c, i) => (
                    <BboxCircle
                        key={`${c.seconds}-${i}`}
                        cluster={c}
                        onClick={() => onSeek(Math.max(0, c.seconds - 1))}
                        onEnter={() => setHoveredCluster(c)}
                        onLeave={() => setHoveredCluster(null)}
                    />
                ))}
            </div>
        </div>
    );
};

const BboxCircle: React.FC<{
    cluster: BboxCluster;
    onClick: () => void;
    onEnter: () => void;
    onLeave: () => void;
}> = ({ cluster, onClick, onEnter, onLeave }) => {
    const Icon = iconFor(cluster.classes[0] ?? 'default');
    return (
        <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onClick(); }}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseEnter={onEnter}
            onMouseLeave={onLeave}
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-3.5 rounded-full bg-white border border-zinc-800 shadow flex items-center justify-center hover:scale-125 transition-transform z-10"
            style={{ left: `${cluster.x}px` }}
            aria-label="Bbox detection"
        >
            <Icon className="w-2.5 h-2.5 text-zinc-800" />
        </button>
    );
};

export { formatBehindLive };
