import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { SlidersHorizontal, ChevronLeft, Trash2 } from 'lucide-react';
import { normalizeClassKey, type ConfidenceSettings } from '../../utils/confidence';

interface Props {
    showBBoxes: boolean;
    onShowBBoxesChange: (v: boolean) => void;
    analyticsLocked?: boolean;
    confidence: ConfidenceSettings;
    onConfidenceChange: (next: ConfidenceSettings) => void;
    retentionFrames: number;
    onRetentionFramesChange: (v: number) => void;
    playbackRate: number;
    onPlaybackRateChange: (v: number) => void;
    isLive: boolean;
    onClose: () => void;
    triggerRef?: React.RefObject<HTMLElement | null>;
}

type View = 'main' | 'confidence' | 'speed';

const SPEED_PRESETS = [0.5, 1, 1.5, 2] as const;
const SPEED_MIN = 0.25;
const SPEED_MAX = 2;
const SPEED_STEP = 0.05;
const formatSpeed = (v: number) => v.toFixed(2);

export const SettingsMenu: React.FC<Props> = ({
    showBBoxes,
    onShowBBoxesChange,
    analyticsLocked = false,
    confidence,
    onConfidenceChange,
    retentionFrames,
    onRetentionFramesChange,
    playbackRate,
    onPlaybackRateChange,
    isLive,
    onClose,
    triggerRef,
}) => {
    const menuRef = useRef<HTMLDivElement>(null);
    const [view, setView] = useState<View>('main');

    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            const t = e.target as Node;
            if (menuRef.current?.contains(t)) return;
            if (triggerRef?.current?.contains(t)) return;
            onClose();
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [onClose, triggerRef]);

    return (
        <div
            ref={menuRef}
            className="absolute bottom-full right-0 mb-2 w-64 rounded-md bg-zinc-900/95 backdrop-blur-md border border-white/10 shadow-2xl p-2 text-[11px] z-50"
            onClick={(e) => e.stopPropagation()}
        >
            {view === 'main' && (
                <>
                    <button
                        onClick={() => { if (!analyticsLocked) onShowBBoxesChange(!showBBoxes); }}
                        disabled={analyticsLocked}
                        className={clsx(
                            'w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded transition-colors',
                            analyticsLocked
                                ? 'text-zinc-500 cursor-not-allowed'
                                : showBBoxes
                                    ? 'bg-primary/15 text-primary'
                                    : 'text-zinc-300 hover:bg-white/5',
                        )}
                    >
                        <span>AI Analytics</span>
                        <span
                            className={clsx(
                                'inline-flex items-center justify-center w-14 h-5 rounded text-[10px] font-semibold tabular-nums',
                                analyticsLocked
                                    ? 'bg-zinc-800 text-zinc-500'
                                    : showBBoxes
                                        ? 'bg-primary text-white'
                                        : 'bg-zinc-700 text-zinc-300',
                            )}
                        >
                            {analyticsLocked ? 'LOADING' : showBBoxes ? 'ON' : 'OFF'}
                        </span>
                    </button>

                    <div className="h-px bg-white/5 my-1.5" />

                    <button
                        onClick={() => setView('confidence')}
                        className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded text-zinc-300 hover:bg-white/5 transition-colors"
                        title="Edit per-class confidence thresholds"
                    >
                        <span>Confidence</span>
                        <SlidersHorizontal className="w-3.5 h-3.5 text-zinc-400" />
                    </button>

                    <div className="px-2 py-1.5">
                        <div className="flex items-center justify-between mb-1.5">
                            <span className="text-zinc-300">Frame retention</span>
                            <span className="font-mono text-primary">{retentionFrames}</span>
                        </div>
                        <input
                            type="range"
                            min={1}
                            max={30}
                            step={1}
                            value={retentionFrames}
                            onChange={(e) => onRetentionFramesChange(parseInt(e.target.value))}
                            className="w-full accent-primary h-1 bg-zinc-700 rounded appearance-none cursor-pointer"
                        />
                    </div>

                    <button
                        onClick={() => setView('speed')}
                        className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded text-zinc-300 hover:bg-white/5 transition-colors"
                        title="Change playback speed"
                    >
                        <span>Playback speed</span>
                        <span className="flex items-center gap-1.5">
                            <span className="font-semibold text-primary tabular-nums">{formatSpeed(playbackRate)}</span>
                            <SlidersHorizontal className="w-3.5 h-3.5 text-zinc-400" />
                        </span>
                    </button>
                </>
            )}

            {view === 'confidence' && (
                <ConfidencePanel
                    confidence={confidence}
                    onConfidenceChange={onConfidenceChange}
                    onBack={() => setView('main')}
                />
            )}

            {view === 'speed' && (
                <PlaybackSpeedPanel
                    playbackRate={playbackRate}
                    onPlaybackRateChange={onPlaybackRateChange}
                    isLive={isLive}
                    onBack={() => setView('main')}
                />
            )}
        </div>
    );
};

const PlaybackSpeedPanel: React.FC<{
    playbackRate: number;
    onPlaybackRateChange: (v: number) => void;
    isLive: boolean;
    onBack: () => void;
}> = ({ playbackRate, onPlaybackRateChange, isLive, onBack }) => {
    // Live mode: presets > 1× are disabled and the slider max is clamped
    // to 1×. Fast playback at the live edge would drain dash.js's ~6 s
    // forward buffer and stall — so we prevent the user from choosing
    // an unsafe rate in the first place. When the playhead catches up to
    // live (from a fast DVR play-through), Viewer auto-resets rate to 1×.
    const sliderMax = isLive ? 1 : SPEED_MAX;

    return (
        <div>
            <div className="flex items-center gap-1 px-1 pb-1.5 mb-1.5 border-b border-white/5">
                <button
                    onClick={onBack}
                    className="p-1 rounded text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors"
                    title="Back"
                >
                    <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <span className="text-zinc-200 font-semibold">Playback speed</span>
            </div>

            {/* Preset row */}
            <div className="px-2 py-1.5">
                <div className="flex items-center gap-1">
                    {SPEED_PRESETS.map(p => {
                        const disabled = isLive && p > 1;
                        const active = Math.abs(playbackRate - p) < 0.001;
                        return (
                            <button
                                key={p}
                                onClick={() => { if (!disabled) onPlaybackRateChange(p); }}
                                disabled={disabled}
                                className={clsx(
                                    'flex-1 px-1 py-1 rounded text-[11px] font-semibold tabular-nums transition-colors',
                                    disabled
                                        ? 'bg-zinc-800/40 text-zinc-600 cursor-not-allowed'
                                        : active
                                            ? 'bg-primary text-white'
                                            : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700',
                                )}
                                title={disabled ? 'Fast speeds available in DVR only' : `Set speed to ${formatSpeed(p)}`}
                            >
                                {formatSpeed(p)}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Custom slider */}
            <div className="px-2 py-1.5">
                <div className="flex items-center gap-2 mb-1">
                    <span className="text-zinc-200 font-medium mr-auto">Custom</span>
                    <span className="font-semibold text-primary tabular-nums">{formatSpeed(playbackRate)}</span>
                </div>
                <input
                    type="range"
                    min={SPEED_MIN}
                    max={sliderMax}
                    step={SPEED_STEP}
                    value={Math.min(playbackRate, sliderMax)}
                    onChange={(e) => onPlaybackRateChange(parseFloat(e.target.value))}
                    className="w-full accent-primary h-1 bg-zinc-700 rounded appearance-none cursor-pointer"
                />
            </div>

            {isLive && (
                <div className="px-2 py-1 text-[10px] text-zinc-500 italic">
                    Fast speeds (&gt; 1×) available in DVR only.
                </div>
            )}
        </div>
    );
};

const ConfidencePanel: React.FC<{
    confidence: ConfidenceSettings;
    onConfidenceChange: (next: ConfidenceSettings) => void;
    onBack: () => void;
}> = ({ confidence, onConfidenceChange, onBack }) => {
    const [newClass, setNewClass] = useState('');

    // Keys are already lowercased (invariant of ConfidenceSettings). Preserve
    // insertion order so the user sees the list in the order they added to.
    const overrideEntries = Object.entries(confidence.overrides);

    const normalizedNew = normalizeClassKey(newClass);
    const canAdd = normalizedNew !== null && !(normalizedNew in confidence.overrides);

    const handleDefaultChange = (value: number) => {
        onConfidenceChange({ ...confidence, default: value });
    };

    const handleOverrideChange = (key: string, value: number) => {
        onConfidenceChange({
            ...confidence,
            overrides: { ...confidence.overrides, [key]: value },
        });
    };

    const handleRemoveOverride = (key: string) => {
        const next = { ...confidence.overrides };
        delete next[key];
        onConfidenceChange({ ...confidence, overrides: next });
    };

    const handleAdd = () => {
        if (!canAdd || normalizedNew === null) return;
        onConfidenceChange({
            ...confidence,
            overrides: { ...confidence.overrides, [normalizedNew]: 0.5 },
        });
        setNewClass('');
    };

    return (
        <div>
            <div className="flex items-center gap-1 px-1 pb-1.5 mb-1.5 border-b border-white/5">
                <button
                    onClick={onBack}
                    className="p-1 rounded text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors"
                    title="Back"
                >
                    <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <span className="text-zinc-200 font-semibold">Confidence</span>
            </div>

            {/* Default slider — always present, can't be removed. Subtle
                background tint distinguishes it from the removable overrides
                below. Right-side layout uses a fixed percentage slot and an
                invisible trash-sized spacer so the percentages line up with
                the override rows' percentage + trash-icon cluster. */}
            <div className="px-2 py-1.5 bg-white/[0.035] rounded">
                <div className="flex items-center gap-2 mb-1">
                    <span className="text-zinc-200 font-medium mr-auto">Default</span>
                    <span className="font-semibold text-primary tabular-nums">{(confidence.default * 100).toFixed(0)}%</span>
                </div>
                <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={confidence.default}
                    onChange={(e) => handleDefaultChange(parseFloat(e.target.value))}
                    className="w-full accent-primary h-1 bg-zinc-700 rounded appearance-none cursor-pointer"
                />
            </div>

            {overrideEntries.length > 0 && (
                <>
                    <div className="h-px bg-white/5 my-1" />
                    {/* ~3 rows visible, rest scroll. Default stays above,
                        outside this scroll container. */}
                    <div className="max-h-[144px] overflow-y-auto">
                        {overrideEntries.map(([key, value]) => (
                            <div key={key} className="px-2 py-1.5">
                                <div className="flex items-center gap-2 mb-1">
                                    <span className="text-zinc-200 font-medium truncate mr-auto" title={key}>{key}</span>
                                    <span className="font-semibold text-primary tabular-nums">{(value * 100).toFixed(0)}%</span>
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <input
                                        type="range"
                                        min={0}
                                        max={1}
                                        step={0.05}
                                        value={value}
                                        onChange={(e) => handleOverrideChange(key, parseFloat(e.target.value))}
                                        className="flex-1 min-w-0 accent-primary h-1 bg-zinc-700 rounded appearance-none cursor-pointer"
                                    />
                                    <button
                                        onClick={() => handleRemoveOverride(key)}
                                        className="w-4 h-4 shrink-0 flex items-center justify-center rounded text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors"
                                        title={`Remove override for "${key}"`}
                                    >
                                        <Trash2 className="w-3 h-3" />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </>
            )}

            <div className="h-px bg-white/5 my-1" />

            <div className="px-2 py-1.5">
                <div className="flex items-center gap-1.5">
                    <input
                        type="text"
                        value={newClass}
                        onChange={(e) => setNewClass(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && canAdd) handleAdd(); }}
                        placeholder="class name"
                        className="flex-1 min-w-0 px-2 py-1 text-[11px] rounded bg-zinc-800 border border-white/10 text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-primary/50"
                    />
                    <button
                        onClick={handleAdd}
                        disabled={!canAdd}
                        className={clsx(
                            'px-2.5 py-1 rounded text-[11px] font-semibold transition-colors',
                            canAdd
                                ? 'bg-primary/20 text-primary hover:bg-primary/30'
                                : 'bg-zinc-800 text-zinc-600 cursor-not-allowed',
                        )}
                        title={
                            normalizedNew === null
                                ? 'Type a class name'
                                : (normalizedNew in confidence.overrides)
                                    ? 'Override already exists'
                                    : 'Add override'
                        }
                    >
                        Add
                    </button>
                </div>
            </div>
        </div>
    );
};
