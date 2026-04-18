import React, { useRef, useState } from 'react';
import clsx from 'clsx';
import {
    Play, Pause, SkipBack, SkipForward, Settings as SettingsIcon,
    Maximize, Minimize, Radio, Square, Download, Scissors, Save,
} from 'lucide-react';
import type { BBox, ClipSelection } from '../../types';
import type { DvrState } from '../../hooks/useDvrPlayer';
import { Seekbar, formatBehindLive } from './Seekbar';
import { SettingsMenu } from './SettingsMenu';

const PTS_TIMEBASE = 90000;

interface Props {
    dvrState: DvrState;
    windowSec: number;

    bboxGroups: Map<number, BBox[]>;
    showBBoxes: boolean;
    onShowBBoxesChange: (v: boolean) => void;
    analyticsLocked?: boolean;
    minConfidence: number;
    onMinConfidenceChange: (v: number) => void;
    retentionFrames: number;
    onRetentionFramesChange: (v: number) => void;

    clipSelection: ClipSelection | null;
    onClipSelectionChange: (sel: ClipSelection | null) => void;

    onSeekTo: (t: number) => void;
    onSeekBy: (delta: number) => void;
    onBackToLive: () => void;
    onTogglePlay: () => void;
    onStopWatching: () => void;

    isFullscreen: boolean;
    onToggleFullscreen: () => void;

    liveRecordingDuration: number;
    onSaveLiveClip: () => void;
    onCreateClip: () => void;
    onSaveClip: () => void;
    exportProgress: number | null;
}

export const PlayerControls: React.FC<Props> = (props) => {
    const {
        dvrState, windowSec,
        bboxGroups, showBBoxes, onShowBBoxesChange, analyticsLocked,
        minConfidence, onMinConfidenceChange,
        retentionFrames, onRetentionFramesChange,
        clipSelection, onClipSelectionChange,
        onSeekTo, onSeekBy, onBackToLive, onTogglePlay, onStopWatching,
        isFullscreen, onToggleFullscreen,
        liveRecordingDuration, onSaveLiveClip, onCreateClip, onSaveClip, exportProgress,
    } = props;

    const [settingsOpen, setSettingsOpen] = useState(false);
    const settingsBtnRef = useRef<HTMLButtonElement>(null);

    const { isLive, isPaused, playhead, duration } = dvrState;
    const behindLive = Math.max(0, duration - playhead);

    const saveButton = renderSaveButton({
        isLive,
        clipSelection,
        exportProgress,
        liveRecordingDuration,
        onSaveLiveClip,
        onCreateClip,
        onSaveClip,
    });

    return (
        <div className="bg-gradient-to-t from-black/95 via-black/70 to-transparent px-4 pt-6 pb-3">
            {/* Label row — LIVE or -MM:SS behind live, plus optional clip range. */}
            <div className="flex items-center gap-2 mb-1 px-0.5 h-5">
                <div
                    className={clsx(
                        'px-1.5 py-0.5 rounded text-[10px] font-mono border leading-none',
                        isLive
                            ? 'bg-red-500/20 text-red-300 border-red-500/40'
                            : 'bg-zinc-900/70 text-zinc-200 border-white/10',
                    )}
                >
                    {isLive ? 'LIVE' : formatBehindLive(behindLive)}
                </div>
                {clipSelection && !isLive && (
                    <div className="px-1.5 py-0.5 rounded text-[10px] font-mono border bg-amber-500/15 text-amber-200 border-amber-400/30 leading-none">
                        {formatBehindLive(Math.max(0, duration - clipSelection.startPts / PTS_TIMEBASE))}
                        {' → '}
                        {(() => {
                            const endBehind = Math.max(0, duration - clipSelection.endPts / PTS_TIMEBASE);
                            return endBehind <= 0.5 ? 'LIVE' : formatBehindLive(endBehind);
                        })()}
                    </div>
                )}
            </div>

            <Seekbar
                dvrState={dvrState}
                windowSec={windowSec}
                bboxGroups={bboxGroups}
                minConfidence={minConfidence}
                showBBoxes={showBBoxes && !analyticsLocked}
                clipSelection={clipSelection}
                onClipSelectionChange={onClipSelectionChange}
                onSeek={onSeekTo}
            />

            {/* Transport row. Left cluster: play/pause, stop, ±10s. Right cluster: save, back-to-live, settings, fullscreen. */}
            <div className="flex items-center justify-between mt-1.5">
                <div className="flex items-center gap-0.5">
                    <button
                        onClick={onTogglePlay}
                        className="p-2 rounded-md hover:bg-white/10 text-white transition"
                        title={isPaused ? 'Play' : 'Pause'}
                    >
                        {isPaused
                            ? <Play className="w-4 h-4 fill-current" />
                            : <Pause className="w-4 h-4 fill-current" />}
                    </button>
                    <button
                        onClick={onStopWatching}
                        className="p-2 rounded-md hover:bg-white/10 text-zinc-200 transition"
                        title="Stop watching"
                    >
                        <Square className="w-3.5 h-3.5 fill-current" />
                    </button>
                    <div className="w-px h-5 bg-white/10 mx-1" />
                    <button
                        onClick={() => onSeekBy(-10)}
                        className="p-2 rounded-md hover:bg-white/10 text-white transition flex items-center gap-0.5"
                        title="Back 10 seconds"
                    >
                        <SkipBack className="w-4 h-4" />
                        <span className="text-[10px] font-bold">10</span>
                    </button>
                    <button
                        onClick={() => onSeekBy(10)}
                        disabled={isLive}
                        className={clsx(
                            'p-2 rounded-md transition flex items-center gap-0.5',
                            isLive ? 'text-zinc-600 cursor-not-allowed' : 'text-white hover:bg-white/10',
                        )}
                        title="Forward 10 seconds"
                    >
                        <span className="text-[10px] font-bold">10</span>
                        <SkipForward className="w-4 h-4" />
                    </button>
                </div>

                <div className="flex items-center gap-1.5">
                    {saveButton}

                    <button
                        onClick={onBackToLive}
                        disabled={isLive}
                        className={clsx(
                            'flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[11px] font-semibold border transition',
                            isLive
                                ? 'bg-red-500/5 text-red-400/40 border-red-500/10 cursor-default'
                                : 'bg-red-500/20 text-red-300 border-red-500/30 hover:bg-red-500/30',
                        )}
                        title="Back to live"
                    >
                        <Radio className="w-3 h-3" />
                        BACK TO LIVE
                    </button>

                    <div className="relative">
                        <button
                            ref={settingsBtnRef}
                            onClick={() => setSettingsOpen(o => !o)}
                            className={clsx(
                                'p-2 rounded-md hover:bg-white/10 text-white transition',
                                settingsOpen && 'bg-white/10',
                            )}
                            title="Settings"
                        >
                            <SettingsIcon className="w-4 h-4" />
                        </button>
                        {settingsOpen && (
                            <SettingsMenu
                                showBBoxes={showBBoxes}
                                onShowBBoxesChange={onShowBBoxesChange}
                                analyticsLocked={analyticsLocked}
                                minConfidence={minConfidence}
                                onMinConfidenceChange={onMinConfidenceChange}
                                retentionFrames={retentionFrames}
                                onRetentionFramesChange={onRetentionFramesChange}
                                onClose={() => setSettingsOpen(false)}
                                triggerRef={settingsBtnRef}
                            />
                        )}
                    </div>

                    <button
                        onClick={onToggleFullscreen}
                        className="p-2 rounded-md hover:bg-white/10 text-white transition"
                        title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                    >
                        {isFullscreen
                            ? <Minimize className="w-4 h-4" />
                            : <Maximize className="w-4 h-4" />}
                    </button>
                </div>
            </div>
        </div>
    );
};

interface SaveButtonArgs {
    isLive: boolean;
    clipSelection: ClipSelection | null;
    exportProgress: number | null;
    liveRecordingDuration: number;
    onSaveLiveClip: () => void;
    onCreateClip: () => void;
    onSaveClip: () => void;
}

// Button has four states: exporting (disabled, shows progress), live-with-
// buffer (Save last 30s), DVR-with-clip (Save clip), DVR-no-clip (Create clip).
const renderSaveButton = ({
    isLive, clipSelection, exportProgress, liveRecordingDuration,
    onSaveLiveClip, onCreateClip, onSaveClip,
}: SaveButtonArgs) => {
    if (exportProgress !== null) {
        return (
            <button
                disabled
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-zinc-800 text-zinc-400 border border-white/10"
                title="Exporting clip"
            >
                <Save className="w-3.5 h-3.5 animate-pulse" />
                Saving… {Math.round(exportProgress * 100)}%
            </button>
        );
    }
    if (isLive) {
        if (liveRecordingDuration <= 0) {
            return (
                <button
                    disabled
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-zinc-800/50 text-zinc-500 border border-white/5"
                    title="Recording not ready yet"
                >
                    <Download className="w-3.5 h-3.5" />
                    Save last 30s
                </button>
            );
        }
        return (
            <button
                onClick={onSaveLiveClip}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-red-500/20 text-red-300 hover:bg-red-500/30 border border-red-500/30 transition"
                title="Save last 30s"
            >
                <Download className="w-3.5 h-3.5" />
                Save last {liveRecordingDuration}s
            </button>
        );
    }
    if (clipSelection) {
        return (
            <button
                onClick={onSaveClip}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-amber-500/20 text-amber-200 hover:bg-amber-500/30 border border-amber-400/40 transition"
                title="Save selected clip"
            >
                <Save className="w-3.5 h-3.5" />
                Save clip
            </button>
        );
    }
    return (
        <button
            onClick={onCreateClip}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-white/10 transition"
            title="Create clip"
        >
            <Scissors className="w-3.5 h-3.5" />
            Create clip
        </button>
    );
};
