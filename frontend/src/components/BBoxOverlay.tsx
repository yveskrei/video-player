import React, { useEffect, useRef } from 'react';
import type { BBox } from '../types';
import { drawBBoxes } from '../utils/drawing';
import type { ConfidenceSettings } from '../utils/confidence';

interface BBoxOverlayProps {
    // Source of truth is a ref updated by the Viewer's animate loop. The
    // overlay draws on requestAnimationFrame so it lines up with the video's
    // paint cycle — setInterval got throttled under CPU pressure (dash.js
    // MPD parse, MSE appendBuffer, large React re-renders) and the overlay
    // would visibly halt for a couple of seconds even though the underlying
    // `bboxesRef` was being updated.
    bboxesRef: React.RefObject<BBox[]>;
    // versionRef is accepted for API compatibility but no longer consulted —
    // we always redraw on each RAF, since deciding whether to redraw was
    // never more expensive than actually redrawing ~30–50 small rects.
    versionRef?: React.RefObject<number>;
    originalWidth: number;
    originalHeight: number;
    // Filtering lives inside drawBBoxes; passing a ref avoids re-installing
    // the RAF loop every time the user nudges a slider.
    confidenceRef: React.RefObject<ConfidenceSettings>;
    show: boolean;
    width: number;
    height: number;
    offsetX?: number;
    offsetY?: number;
}

export const BBoxOverlay: React.FC<BBoxOverlayProps> = ({
    bboxesRef,
    originalWidth,
    originalHeight,
    confidenceRef,
    show,
    width,
    height,
    offsetX = 0,
    offsetY = 0,
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d', { alpha: true });
        if (!ctx) return;

        if (!show) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            return;
        }

        let raf = 0;
        const loop = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const bboxes = bboxesRef.current;
            if (bboxes && bboxes.length > 0) {
                drawBBoxes(ctx, bboxes, originalWidth, originalHeight, canvas.width, canvas.height, confidenceRef.current);
            }
            raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(raf);
    }, [bboxesRef, confidenceRef, originalWidth, originalHeight, show, width, height]);

    return (
        <canvas
            ref={canvasRef}
            width={width}
            height={height}
            className="absolute pointer-events-none"
            style={{
                left: `${offsetX}px`,
                top: `${offsetY}px`,
            }}
        />
    );
};
