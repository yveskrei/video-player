import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { BBox, ClipSelection } from '../../types';
import type { DvrState } from '../../hooks/useDvrPlayer';
import { BBoxStrip } from './BBoxStrip';
import { ClipOverlay } from './ClipOverlay';

export const formatBehindLive = (secBehind: number): string => {
    if (secBehind <= 0.5) return 'LIVE';
    const total = Math.floor(secBehind);
    const hh = Math.floor(total / 3600);
    const mm = Math.floor((total % 3600) / 60);
    const ss = total % 60;
    const pad = (n: number) => n.toString().padStart(2, '0');
    return hh > 0 ? `-${hh}:${pad(mm)}:${pad(ss)}` : `-${pad(mm)}:${pad(ss)}`;
};

interface Props {
    dvrState: DvrState;
    // Full DVR window advertised by the backend, seconds. The seekbar renders
    // [duration - windowSec, duration] as its x-axis so fill-bar position
    // depends only on behind-live offset — constant across time when playing
    // at a fixed DVR position. Prior versions stretched the bar across
    // [dvrStart, duration] which drifted when either end moved relative to
    // playhead.
    windowSec: number;
    bboxGroups: Map<number, BBox[]>;
    minConfidence: number;
    showBBoxes: boolean;
    clipSelection: ClipSelection | null;
    onClipSelectionChange: (sel: ClipSelection | null) => void;
    onSeek: (timeSec: number) => void;
}

export const Seekbar: React.FC<Props> = ({
    dvrState,
    windowSec,
    bboxGroups,
    minConfidence,
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

    const { playhead, duration, dvrStart, isLive, isReady } = dvrState;

    // Visual x-axis: [duration - windowSec, duration]. For young streams
    // duration < windowSec, so viewStart is negative — the leftmost portion
    // represents "before the stream existed" and is greyed out, while the
    // seekable portion [dvrStart, duration] is rendered in normal track colour.
    const viewStart = duration - windowSec;
    const viewEnd = duration;

    const timeToX = useCallback((t: number): number => {
        if (windowSec <= 0 || trackWidth <= 0) return 0;
        return ((t - viewStart) / windowSec) * trackWidth;
    }, [viewStart, windowSec, trackWidth]);

    const xToTime = useCallback((x: number): number => {
        if (windowSec <= 0 || trackWidth <= 0) return 0;
        const clampedX = Math.min(Math.max(x, 0), trackWidth);
        return viewStart + (clampedX / trackWidth) * windowSec;
    }, [viewStart, windowSec, trackWidth]);

    const availableLeftX = Math.max(0, Math.min(trackWidth, timeToX(Math.max(dvrStart, 0))));
    const playheadX = Math.min(Math.max(timeToX(playhead), 0), trackWidth);

    // Clamp seeks to the actual seekable range (dvrStart..duration). Clicks
    // outside that area are ignored — otherwise we'd seek into dead zone on
    // young streams.
    const handleSeekClick = useCallback((clientX: number) => {
        if (!trackRef.current) return;
        const rect = trackRef.current.getBoundingClientRect();
        const t = xToTime(clientX - rect.left);
        const clamped = Math.min(Math.max(t, Math.max(dvrStart, 0)), duration);
        onSeek(clamped);
    }, [xToTime, dvrStart, duration, onSeek]);

    const handleTrackPointerDown = useCallback((e: React.PointerEvent) => {
        if (e.button !== 0) return;
        const el = e.currentTarget as HTMLElement;
        el.setPointerCapture(e.pointerId);
        handleSeekClick(e.clientX);
    }, [handleSeekClick]);

    const handleTrackPointerMove = useCallback((e: React.PointerEvent) => {
        const el = e.currentTarget as HTMLElement;
        if (el.hasPointerCapture(e.pointerId)) handleSeekClick(e.clientX);
        // Hover tooltip position (no drag)
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
    const hoverBehind = hoverSec !== null ? Math.max(0, duration - hoverSec) : null;

    return (
        <div className="relative select-none" style={{ paddingTop: 4, paddingBottom: 6 }}>
            <BBoxStrip
                bboxGroups={bboxGroups}
                minConfidence={minConfidence}
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
                {/* Base track (darker — represents the full configured DVR span, including areas before the stream started on young streams). */}
                <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-white/5 group-hover/track:h-2 transition-all" />

                {/* Available region — where DVR content actually exists. Brighter so the user can see the seekable area on young streams. */}
                {availableLeftX < trackWidth && (
                    <div
                        className="absolute top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-white/15 group-hover/track:h-2 transition-all"
                        style={{ left: availableLeftX, width: trackWidth - availableLeftX }}
                    />
                )}

                {/* Fill up to playhead. When live, fill to the right edge in red so the bar reads "at live". */}
                <div
                    className={clsx(
                        'absolute top-1/2 -translate-y-1/2 h-1.5 rounded-full transition-colors group-hover/track:h-2',
                        isLive ? 'bg-red-500' : 'bg-primary',
                    )}
                    style={{
                        left: availableLeftX,
                        width: isLive
                            ? Math.max(0, trackWidth - availableLeftX)
                            : Math.max(0, playheadX - availableLeftX),
                    }}
                />

                {clipSelection && (
                    <ClipOverlay
                        selection={clipSelection}
                        dvrStart={Math.max(dvrStart, 0)}
                        duration={duration}
                        trackWidth={trackWidth}
                        timeToX={timeToX}
                        onChange={onClipSelectionChange}
                    />
                )}
            </div>
        </div>
    );
};
