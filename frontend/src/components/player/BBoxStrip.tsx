import React, { useMemo, useState } from 'react';
import { User, Car, Truck, Dog, Cat, HelpCircle } from 'lucide-react';
import type { BBox } from '../../types';

const PTS_TIMEBASE = 90000;
const BUCKET_SEC = 2;
const UNKNOWN = '__unknown__';

const CLASS_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
    person: User,
    car: Car,
    truck: Truck,
    dog: Dog,
    cat: Cat,
};

const isKnownClass = (c: string) => c in CLASS_ICON;
const iconFor = (c: string) => CLASS_ICON[c] ?? HelpCircle;

interface Bucket {
    seconds: number;
    classCounts: Map<string, number>;
    total: number;
}

interface Props {
    bboxGroups: Map<number, BBox[]>;
    minConfidence: number;
    // Absolute-time window currently visible on the seekbar (inclusive).
    viewStart: number;
    viewEnd: number;
    // Geometry from the parent Seekbar. Keep BBoxStrip dumb about its own
    // sizing so the two always stay in sync.
    trackWidth: number;
    timeToX: (t: number) => number;
    onSeek: (t: number) => void;
    show: boolean;
}

// Pick the dominant known class in a bucket; fall back to the unknown sentinel
// only if no known class is present. Known classes always beat unknowns.
const pickDominant = (counts: Map<string, number>): string => {
    let best: { cls: string; count: number } | null = null;
    for (const [cls, count] of counts) {
        if (!isKnownClass(cls)) continue;
        if (!best || count > best.count) best = { cls, count };
    }
    return best?.cls ?? UNKNOWN;
};

export const BBoxStrip: React.FC<Props> = ({
    bboxGroups,
    minConfidence,
    viewStart,
    viewEnd,
    trackWidth,
    timeToX,
    onSeek,
    show,
}) => {
    const [hovered, setHovered] = useState<Bucket | null>(null);

    // 2-second buckets (user spec). Fixed-time buckets keep aggregation cheap
    // and stable across re-renders.
    const buckets = useMemo<Bucket[]>(() => {
        if (!show || trackWidth <= 0) return [];
        const map = new Map<number, Bucket>();
        for (const [pts, bboxes] of bboxGroups) {
            const sec = pts / PTS_TIMEBASE;
            if (sec < viewStart || sec > viewEnd) continue;
            const id = Math.floor(sec / BUCKET_SEC);
            let b: Bucket | undefined;
            for (const bbox of bboxes) {
                if (bbox.confidence < minConfidence) continue;
                if (!b) {
                    b = map.get(id);
                    if (!b) {
                        b = {
                            seconds: id * BUCKET_SEC + BUCKET_SEC / 2,
                            classCounts: new Map(),
                            total: 0,
                        };
                        map.set(id, b);
                    }
                }
                const cls = bbox.class_name.toLowerCase();
                const key = isKnownClass(cls) ? cls : UNKNOWN;
                b.classCounts.set(key, (b.classCounts.get(key) ?? 0) + 1);
                b.total += 1;
            }
        }
        return Array.from(map.values()).sort((a, b) => a.seconds - b.seconds);
    }, [bboxGroups, minConfidence, viewStart, viewEnd, trackWidth, show]);

    if (!show) return <div style={{ height: 16, marginBottom: 2 }} />;

    return (
        <div className="relative w-full" style={{ height: 16, marginBottom: 2 }}>
            {buckets.map(b => {
                const x = timeToX(b.seconds);
                if (x < -8 || x > trackWidth + 8) return null;
                const dominant = pickDominant(b.classCounts);
                const Icon = iconFor(dominant === UNKNOWN ? 'default' : dominant);
                return (
                    <button
                        key={b.seconds}
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onSeek(Math.max(0, b.seconds - 1)); }}
                        onPointerDown={(e) => e.stopPropagation()}
                        onMouseEnter={() => setHovered(b)}
                        onMouseLeave={() => setHovered(null)}
                        className="absolute bottom-0 -translate-x-1/2 w-4 h-4 rounded-full bg-white border border-zinc-800 shadow flex items-center justify-center hover:scale-125 transition-transform z-10"
                        style={{ left: x }}
                        aria-label="bbox cluster"
                    >
                        <Icon className="w-3 h-3 text-zinc-800" />
                    </button>
                );
            })}
            {hovered && <HoverCard bucket={hovered} x={timeToX(hovered.seconds)} trackWidth={trackWidth} />}
        </div>
    );
};

const HoverCard: React.FC<{ bucket: Bucket; x: number; trackWidth: number }> = ({ bucket, x, trackWidth }) => {
    // Unknown row always sinks to the bottom so the dominant known class
    // leads the list.
    const rows = useMemo(() => {
        const entries = Array.from(bucket.classCounts.entries());
        entries.sort((a, b) => {
            if (a[0] === UNKNOWN && b[0] !== UNKNOWN) return 1;
            if (b[0] === UNKNOWN && a[0] !== UNKNOWN) return -1;
            return b[1] - a[1];
        });
        return entries;
    }, [bucket]);

    const CARD_W = 54;
    const left = Math.min(Math.max(x - CARD_W / 2, 0), Math.max(0, trackWidth - CARD_W));

    return (
        <div
            className="absolute z-30 flex flex-col gap-1 px-1.5 py-1 rounded-md bg-zinc-900/95 border border-white/15 shadow-xl backdrop-blur-sm pointer-events-none"
            style={{ left, bottom: 22, width: CARD_W }}
        >
            {rows.map(([cls, count]) => {
                const Icon = iconFor(cls === UNKNOWN ? 'default' : cls);
                return (
                    <div key={cls} className="flex items-center justify-between gap-1 text-[11px] text-white/90">
                        <Icon className="w-3.5 h-3.5 shrink-0" />
                        <span className="font-mono text-[10px] text-white/70 tabular-nums">{count}</span>
                    </div>
                );
            })}
        </div>
    );
};
