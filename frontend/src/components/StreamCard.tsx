import React from 'react';
import { Play } from 'lucide-react';
import type { VideoInfo } from '../types';

interface StreamCardProps {
    stream: VideoInfo;
    onSelect: (id: number) => void;
}

export const StreamCard: React.FC<StreamCardProps> = ({ stream, onSelect }) => {
    return (
        <button
            onClick={() => onSelect(stream.id)}
            className="card group relative aspect-video w-full overflow-hidden text-left transition-colors hover:bg-zinc-800/30 focus:outline-none focus:ring-2 focus:ring-primary/50"
            title={`Watch ${stream.name}`}
        >
            {/* Live badge */}
            <span className="absolute top-3 right-3 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border bg-green-500/10 text-green-400 border-green-500/20">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 mr-1.5 animate-pulse" />
                Live
            </span>

            {/* Centered play glyph (appears on hover) */}
            <div className="absolute inset-0 flex items-center justify-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white/5 opacity-60 transition-all group-hover:scale-110 group-hover:bg-primary/70 group-hover:opacity-100">
                    <Play className="h-6 w-6 fill-white text-white" />
                </div>
            </div>

            {/* Bottom info strip */}
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/50 to-transparent px-4 pb-3 pt-10">
                <div className="flex items-baseline gap-2">
                    <span className="font-mono text-sm text-zinc-500">#{stream.id}</span>
                    <span className="truncate font-medium text-zinc-200">{stream.name}</span>
                </div>
                <div className="mt-0.5 text-sm text-zinc-400">
                    {stream.width}×{stream.height} · {stream.fps.toFixed(0)} fps
                </div>
            </div>
        </button>
    );
};
