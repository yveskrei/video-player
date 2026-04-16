import React, { useRef, useState } from 'react';
import clsx from 'clsx';
import {
    Play,
    Pause,
    SkipBack,
    SkipForward,
    Settings as SettingsIcon,
    Maximize,
    Minimize,
    Radio,
    Square,
    Download,
    Scissors,
    Save,
} from 'lucide-react';
import type { BBox, ClipSelection } from '../types';
import type { DvrState } from '../hooks/useDvrPlayer';
import { Seekbar, formatBehindLive } from './Seekbar';
import { SettingsMenu } from './SettingsMenu';

interface PlayerControlsProps {
    dvrState: DvrState;
    bboxGroups: Map<number, BBox[]>;
    clipSelection: ClipSelection | null;
    onClipSelectionChange: (sel: ClipSelection | null) => void;

    showBBoxes: boolean;
    onShowBBoxesChange: (v: boolean) => void;
    minConfidence: number;
    onMinConfidenceChange: (v: number) => void;
    retentionFrames: number;
    onRetentionFramesChange: (v: number) => void;

    onSeekTo: (timeSec: number) => void;
    onSeekBy: (deltaSec: number) => void;
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

export const PlayerControls: React.FC<PlayerControlsProps> = ({
    dvrState,
    bboxGroups,
    clipSelection,
    onClipSelectionChange,
    showBBoxes,
    onShowBBoxesChange,
    minConfidence,
    onMinConfidenceChange,
    retentionFrames,
    onRetentionFramesChange,
    onSeekTo,
    onSeekBy,
    onBackToLive,
    onTogglePlay,
    onStopWatching,
    isFullscreen,
    onToggleFullscreen,
    liveRecordingDuration,
    onSaveLiveClip,
    onCreateClip,
    onSaveClip,
    exportProgress,
}) => {
    const [settingsOpen, setSettingsOpen] = useState(false);
    const settingsButtonRef = useRef<HTMLButtonElement>(null);
    const { isLive, isPaused, playhead, duration } = dvrState;
    const behindLive = Math.max(0, duration - playhead);

    const saveButton = (() => {
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
    })();

    return (
        <div className="bg-gradient-to-t from-black/95 via-black/70 to-transparent px-4 pt-6 pb-3">
            {/* Mini-row above seekbar: LIVE/-MM:SS label (+ clip range chip when active) */}
            <div className="flex items-center gap-2 mb-1 px-0.5 h-5">
                <div
                    className={clsx(
                        'px-1.5 py-0.5 rounded text-[10px] font-mono border leading-none',
                        isLive
                            ? 'bg-red-500/20 text-red-300 border-red-500/40'
                            : 'bg-zinc-900/70 text-zinc-200 border-white/10'
                    )}
                >
                    {isLive ? 'LIVE' : formatBehindLive(behindLive)}
                </div>
                {clipSelection && !isLive && (
                    <div className="px-1.5 py-0.5 rounded text-[10px] font-mono border bg-amber-500/15 text-amber-200 border-amber-400/30 leading-none">
                        {formatBehindLive(duration - clipSelection.startPts / 90000)}
                        {' → '}
                        {(() => {
                            const endBehind = duration - clipSelection.endPts / 90000;
                            return endBehind <= 0.5 ? 'LIVE' : formatBehindLive(endBehind);
                        })()}
                    </div>
                )}
            </div>

            {/* Seekbar */}
            <Seekbar
                dvrState={dvrState}
                onSeek={onSeekTo}
                bboxGroups={bboxGroups}
                minConfidence={minConfidence}
                clipSelection={clipSelection}
                onClipSelectionChange={onClipSelectionChange}
            />

            {/* Transport row */}
            <div className="flex items-center justify-between mt-1.5">
                <div className="flex items-center gap-0.5">
                    <button
                        onClick={onTogglePlay}
                        className="p-2 rounded-md hover:bg-white/10 text-white transition"
                        title={isPaused ? 'Play' : 'Pause'}
                    >
                        {isPaused ? <Play className="w-4 h-4 fill-current" /> : <Pause className="w-4 h-4 fill-current" />}
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
                        onClick={() => onSeekBy(-15)}
                        className="p-2 rounded-md hover:bg-white/10 text-white transition flex items-center gap-0.5"
                        title="Back 15 seconds"
                    >
                        <SkipBack className="w-4 h-4" />
                        <span className="text-[10px] font-bold">15</span>
                    </button>
                    <button
                        onClick={() => onSeekBy(15)}
                        disabled={isLive}
                        className={clsx(
                            'p-2 rounded-md transition flex items-center gap-0.5',
                            isLive ? 'text-zinc-600 cursor-not-allowed' : 'text-white hover:bg-white/10'
                        )}
                        title="Forward 15 seconds"
                    >
                        <span className="text-[10px] font-bold">15</span>
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
                                : 'bg-red-500/20 text-red-300 border-red-500/30 hover:bg-red-500/30'
                        )}
                        title="Back to live"
                    >
                        <Radio className="w-3 h-3" />
                        BACK TO LIVE
                    </button>

                    <div className="relative">
                        <button
                            ref={settingsButtonRef}
                            onClick={() => setSettingsOpen(o => !o)}
                            className={clsx(
                                'p-2 rounded-md hover:bg-white/10 text-white transition',
                                settingsOpen && 'bg-white/10'
                            )}
                            title="Settings"
                        >
                            <SettingsIcon className="w-4 h-4" />
                        </button>
                        {settingsOpen && (
                            <SettingsMenu
                                showBBoxes={showBBoxes}
                                onShowBBoxesChange={onShowBBoxesChange}
                                minConfidence={minConfidence}
                                onMinConfidenceChange={onMinConfidenceChange}
                                retentionFrames={retentionFrames}
                                onRetentionFramesChange={onRetentionFramesChange}
                                onClose={() => setSettingsOpen(false)}
                                triggerRef={settingsButtonRef}
                            />
                        )}
                    </div>

                    <button
                        onClick={onToggleFullscreen}
                        className="p-2 rounded-md hover:bg-white/10 text-white transition"
                        title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                    >
                        {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
                    </button>
                </div>
            </div>
        </div>
    );
};
