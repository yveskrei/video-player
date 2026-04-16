import React, { useEffect, useRef } from 'react';
import clsx from 'clsx';

interface SettingsMenuProps {
    showBBoxes: boolean;
    onShowBBoxesChange: (v: boolean) => void;
    minConfidence: number;
    onMinConfidenceChange: (v: number) => void;
    retentionFrames: number;
    onRetentionFramesChange: (v: number) => void;
    onClose: () => void;
    triggerRef?: React.RefObject<HTMLElement | null>;
}

export const SettingsMenu: React.FC<SettingsMenuProps> = ({
    showBBoxes,
    onShowBBoxesChange,
    minConfidence,
    onMinConfidenceChange,
    retentionFrames,
    onRetentionFramesChange,
    onClose,
    triggerRef,
}) => {
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            const target = e.target as Node;
            if (menuRef.current?.contains(target)) return;
            // Don't close when clicking the trigger button itself — its own click handler will toggle.
            if (triggerRef?.current?.contains(target)) return;
            onClose();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
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
            className="absolute bottom-full right-0 mb-2 w-56 rounded-md bg-zinc-900/95 backdrop-blur-md border border-white/10 shadow-2xl p-2 text-[11px] z-50"
            onClick={(e) => e.stopPropagation()}
        >
            <button
                onClick={() => onShowBBoxesChange(!showBBoxes)}
                className={clsx(
                    'w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded transition-colors',
                    showBBoxes ? 'bg-primary/15 text-primary' : 'text-zinc-300 hover:bg-white/5'
                )}
            >
                <span>AI Analytics</span>
                <span
                    className={clsx(
                        'inline-flex items-center justify-center w-10 h-5 rounded text-[10px] font-semibold',
                        showBBoxes ? 'bg-primary text-white' : 'bg-zinc-700 text-zinc-300'
                    )}
                >
                    {showBBoxes ? 'ON' : 'OFF'}
                </span>
            </button>

            <div className="h-px bg-white/5 my-1.5" />

            <div className="px-2 py-1.5">
                <div className="flex items-center justify-between mb-1.5">
                    <span className="text-zinc-300">Confidence</span>
                    <span className="font-mono text-primary">{(minConfidence * 100).toFixed(0)}%</span>
                </div>
                <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={minConfidence}
                    onChange={(e) => onMinConfidenceChange(parseFloat(e.target.value))}
                    className="w-full accent-primary h-1 bg-zinc-700 rounded appearance-none cursor-pointer"
                />
            </div>

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
        </div>
    );
};
