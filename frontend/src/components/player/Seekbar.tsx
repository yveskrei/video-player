import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { BBox, ClipSelection } from '../../types';
import type { DvrState } from '../../hooks/useDvrPlayer';
import type { ConfidenceSettings } from '../../utils/confidence';
import { BBoxStrip } from './BBoxStrip';
import { ClipOverlay } from './ClipOverlay';

export const formatBehindLive = (secBehind: number): string => {
    if (secBehind <= 0.5) return 'LIVE';
    const total = Math.round(secBehind);
    const hh = Math.floor(total / 3600);
    const mm = Math.floor((total % 3600) / 60);
    const ss = total % 60;
    const pad = (n: number) => n.toString().padStart(2, '0');
    return hh > 0 ? `-${hh}:${pad(mm)}:${pad(ss)}` : `-${pad(mm)}:${pad(ss)}`;
};

interface Props {
    dvrState: DvrState;
    bboxGroups: Map<number, BBox[]>;
    confidence: ConfidenceSettings;
    showBBoxes: boolean;
    clipSelection: ClipSelection | null;
    onClipSelectionChange: (sel: ClipSelection | null) => void;
    onSeek: (timeSec: number) => void;
}

// Seekbar axis = [dvrStart, dvrStart + duration] — exactly the current DVR
// window reported by dash.js. Both endpoints slide forward at 1× wall-clock
// (internally via dash.js's 100 ms tick), so playhead fill = playhead /
// duration is stable whenever the user is playing at a fixed DVR offset or
// paused (where fill recedes at 1×/s, which is correct UX). No custom
// smoothing; no greyed "before-stream-started" region — duration == actual
// window size on young streams too.
export const Seekbar: React.FC<Props> = ({
    dvrState,
    bboxGroups,
    confidence,
    showBBoxes,
    clipSelection,
    onClipSelectionChange,
    onSeek,
}) => {
    const trackRef = useRef<HTMLDivElement>(null);
    const [trackWidth, setTrackWidth] = useState(0);
    const [hoverX, setHoverX] = useState<number | null>(null);

    useLayoutEffect(() => {
        if (!trackRef.current) return;
        const el = trackRef.current;
        const obs = new ResizeObserver(entries => {
            for (const e of entries) setTrackWidth(e.contentRect.width);
        });
        obs.observe(el);
        setTrackWidth(el.getBoundingClientRect().width);
        return () => obs.disconnect();
    }, []);

    const { playhead, duration, dvrStart, dvrWindowSize, isLive, isReady } = dvrState;

    // All times on this axis are absolute presentation seconds (same scale
    // as video.currentTime and pts/90000). Axis span = [dvrStart, duration]
    // (duration here = absolute live edge), so a click at x=0 seeks to the
    // oldest available segment and x=trackWidth seeks to live.
    const viewStart = dvrStart;
    const viewEnd = duration;

    const timeToX = useCallback((absTime: number): number => {
        if (dvrWindowSize <= 0 || trackWidth <= 0) return 0;
        return ((absTime - viewStart) / dvrWindowSize) * trackWidth;
    }, [viewStart, dvrWindowSize, trackWidth]);

    const xToTime = useCallback((x: number): number => {
        if (dvrWindowSize <= 0 || trackWidth <= 0) return viewStart;
        const clampedX = Math.min(Math.max(x, 0), trackWidth);
        return viewStart + (clampedX / trackWidth) * dvrWindowSize;
    }, [viewStart, dvrWindowSize, trackWidth]);

    const playheadX = dvrWindowSize > 0 && trackWidth > 0
        ? Math.min(Math.max(((playhead - dvrStart) / dvrWindowSize) * trackWidth, 0), trackWidth)
        : 0;

    const handleSeekClick = useCallback((clientX: number) => {
        if (!trackRef.current) return;
        const rect = trackRef.current.getBoundingClientRect();
        const t = xToTime(clientX - rect.left);
        const clamped = Math.min(Math.max(t, viewStart), viewEnd);
        onSeek(clamped);
    }, [xToTime, viewStart, viewEnd, onSeek]);

    const handleTrackPointerDown = useCallback((e: React.PointerEvent) => {
        if (e.button !== 0) return;
        const el = e.currentTarget as HTMLElement;
        el.setPointerCapture(e.pointerId);
        handleSeekClick(e.clientX);
    }, [handleSeekClick]);

    const handleTrackPointerMove = useCallback((e: React.PointerEvent) => {
        const el = e.currentTarget as HTMLElement;
        if (el.hasPointerCapture(e.pointerId)) handleSeekClick(e.clientX);
        if (trackRef.current) {
            const rect = trackRef.current.getBoundingClientRect();
            setHoverX(e.clientX - rect.left);
        }
    }, [handleSeekClick]);

    const handleTrackPointerUp = useCallback((e: React.PointerEvent) => {
        const el = e.currentTarget as HTMLElement;
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    }, []);

    const handleTrackLeave = useCallback(() => setHoverX(null), []);

    const hoverSec = hoverX !== null ? xToTime(hoverX) : null;
    const hoverBehind = hoverSec !== null ? Math.max(0, viewEnd - hoverSec) : null;

    return (
        <div className="relative select-none" style={{ paddingTop: 4, paddingBottom: 6 }}>
            <BBoxStrip
                bboxGroups={bboxGroups}
                confidence={confidence}
                viewStart={viewStart}
                viewEnd={viewEnd}
                trackWidth={trackWidth}
                timeToX={timeToX}
                onSeek={onSeek}
                show={showBBoxes && isReady}
            />

            {hoverX !== null && hoverBehind !== null && (
                <div
                    className="absolute z-20 px-1.5 py-0.5 rounded text-[10px] font-mono bg-black/80 text-white pointer-events-none"
                    style={{ left: hoverX, bottom: 22, transform: 'translateX(-50%)' }}
                >
                    {formatBehindLive(hoverBehind)}
                </div>
            )}

            <div
                ref={trackRef}
                onPointerDown={handleTrackPointerDown}
                onPointerMove={handleTrackPointerMove}
                onPointerUp={handleTrackPointerUp}
                onPointerCancel={handleTrackPointerUp}
                onMouseLeave={handleTrackLeave}
                className="relative w-full cursor-pointer group/track touch-none"
                style={{ height: 20 }}
            >
                {/* Track background — the full DVR window. */}
                <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-white/15 group-hover/track:h-2 transition-all" />

                {/* Fill to playhead. At live, fill to the right edge in red. */}
                <div
                    className={clsx(
                        'absolute left-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full transition-colors group-hover/track:h-2',
                        isLive ? 'bg-red-500' : 'bg-primary',
                    )}
                    style={{
                        width: isLive ? trackWidth : Math.max(0, playheadX),
                    }}
                />

                {clipSelection && (
                    <ClipOverlay
                        selection={clipSelection}
                        dvrStart={viewStart}
                        duration={viewEnd}
                        trackWidth={trackWidth}
                        timeToX={timeToX}
                        onChange={onClipSelectionChange}
                    />
                )}
            </div>
        </div>
    );
};
