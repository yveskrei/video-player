import React, { useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import type { ClipSelection } from '../../types';

const PTS_TIMEBASE = 90000;

interface Props {
    selection: ClipSelection;
    dvrStart: number;     // earliest seekable absolute time, seconds
    duration: number;     // live edge, seconds
    trackWidth: number;
    timeToX: (t: number) => number;
    onChange: (sel: ClipSelection | null) => void;
}

interface DragState {
    pointerId: number;
    startClientX: number;
    initialStartSec: number;
    lengthSec: number;
    trackWidth: number;
    viewWindowSec: number;   // seconds represented by the full trackWidth
}

export const ClipOverlay: React.FC<Props> = ({
    selection,
    dvrStart,
    duration,
    trackWidth,
    timeToX,
    onChange,
}) => {
    const dragRef = useRef<DragState | null>(null);

    const startX = timeToX(selection.startPts / PTS_TIMEBASE);
    const endX = timeToX(selection.endPts / PTS_TIMEBASE);
    const width = Math.max(0, endX - startX);

    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        const el = e.currentTarget as HTMLElement;
        el.setPointerCapture(e.pointerId);
        const startSec = selection.startPts / PTS_TIMEBASE;
        const lengthSec = (selection.endPts - selection.startPts) / PTS_TIMEBASE;
        // Derive seconds-per-pixel from the current view: the delta between
        // x=0 and x=trackWidth in time units is the full visual window.
        const viewWindowSec = trackWidth > 0
            ? (timeToXInverseSpan(timeToX, trackWidth))
            : 1;
        dragRef.current = {
            pointerId: e.pointerId,
            startClientX: e.clientX,
            initialStartSec: startSec,
            lengthSec,
            trackWidth,
            viewWindowSec,
        };
    }, [selection, trackWidth, timeToX]);

    const handlePointerMove = useCallback((e: React.PointerEvent) => {
        const d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId) return;
        if (d.trackWidth <= 0) return;
        const secondsPerPx = d.viewWindowSec / d.trackWidth;
        const dSec = (e.clientX - d.startClientX) * secondsPerPx;
        let startSec = d.initialStartSec + dSec;
        // Clamp inside the currently-available DVR range, keeping the clip
        // length invariant. The caller's auto-cancel effect takes over if
        // the clip slides out of the window entirely.
        const minStart = dvrStart;
        const maxStart = Math.max(dvrStart, duration - d.lengthSec);
        if (startSec < minStart) startSec = minStart;
        if (startSec > maxStart) startSec = maxStart;
        onChange({
            startPts: Math.round(startSec * PTS_TIMEBASE),
            endPts: Math.round((startSec + d.lengthSec) * PTS_TIMEBASE),
        });
    }, [dvrStart, duration, onChange]);

    const handlePointerUp = useCallback((e: React.PointerEvent) => {
        const d = dragRef.current;
        if (d && d.pointerId === e.pointerId) {
            const el = e.currentTarget as HTMLElement;
            if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
            dragRef.current = null;
        }
    }, []);

    if (width <= 0) return null;

    return (
        <div
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            className="absolute top-1/2 -translate-y-1/2 rounded-sm border-2 border-amber-400 bg-amber-400/30 cursor-grab active:cursor-grabbing z-20 touch-none"
            style={{ left: startX, width: Math.max(width, 8), height: 18 }}
            title="Drag to move selection"
        >
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onChange(null); }}
                onPointerDown={(e) => e.stopPropagation()}
                className="absolute -top-5 -right-1 w-4 h-4 rounded-full bg-zinc-900 border border-amber-400 text-amber-300 flex items-center justify-center"
                title="Cancel clip"
            >
                <X className="w-2.5 h-2.5" />
            </button>
        </div>
    );
};

// Helper: the full visual window width in seconds — derive by asking timeToX
// what time-span covers [0, trackWidth] pixels. Because timeToX is affine
// (at - b), `timeToX(1) - timeToX(0)` is the seconds→pixels slope, so the
// inverse is pixels→seconds, and trackWidth times that is the window span.
const timeToXInverseSpan = (timeToX: (t: number) => number, trackWidth: number): number => {
    const slopePxPerSec = timeToX(1) - timeToX(0);
    if (slopePxPerSec <= 0) return 1;
    return trackWidth / slopePxPerSec;
};
