import { useCallback, useEffect, useRef, useState } from 'react';
import * as Mp4Muxer from 'mp4-muxer';
import type { BBox } from '../types';
import { drawBBoxes } from '../utils/drawing';
import type { ConfidenceSettings } from '../utils/confidence';

const FPS = 30;
const BITRATE = 8_000_000;
const BUFFER_SEC = 30;
const FRAME_INTERVAL_MS = 1000 / FPS;

interface Props {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    bboxesRef: React.RefObject<BBox[]>;
    originalWidth: number;
    originalHeight: number;
    confidence: ConfidenceSettings;
    showBBoxes: boolean;
    enabled: boolean;
}

interface BufferChunk {
    chunk: EncodedVideoChunk;
    meta?: EncodedVideoChunkMetadata;
}

export const useLiveRecorder = ({
    videoRef,
    bboxesRef,
    originalWidth,
    originalHeight,
    confidence,
    showBBoxes,
    enabled,
}: Props) => {
    const [recordingDuration, setRecordingDuration] = useState(0);

    const encoderRef = useRef<VideoEncoder | null>(null);
    const decoderConfigRef = useRef<VideoDecoderConfig | null>(null);
    const chunksRef = useRef<BufferChunk[]>([]);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
    const workerRef = useRef<Worker | null>(null);
    const frameCountRef = useRef(0);
    const startPerfRef = useRef(0);

    // Hot-path inputs via refs so the worker tick always reads the latest
    // without tearing down the encoder on slider changes.
    const confidenceRef = useRef(confidence);
    const showBBoxesRef = useRef(showBBoxes);
    useEffect(() => { confidenceRef.current = confidence; }, [confidence]);
    useEffect(() => { showBBoxesRef.current = showBBoxes; }, [showBBoxes]);

    const cleanup = useCallback(() => {
        if (workerRef.current) {
            try { workerRef.current.postMessage('stop'); } catch { /* ignore */ }
            workerRef.current.terminate();
            workerRef.current = null;
        }
        const enc = encoderRef.current;
        if (enc && enc.state !== 'closed') {
            try { enc.close(); } catch { /* ignore */ }
        }
        encoderRef.current = null;
        decoderConfigRef.current = null;
        chunksRef.current = [];
        canvasRef.current = null;
        ctxRef.current = null;
        frameCountRef.current = 0;
        setRecordingDuration(0);
    }, []);

    useEffect(() => {
        if (!enabled || !videoRef.current || originalWidth <= 0 || originalHeight <= 0) {
            cleanup();
            return;
        }
        // If already set up for these dimensions, keep running.
        if (
            encoderRef.current
            && canvasRef.current?.width === originalWidth
            && canvasRef.current?.height === originalHeight
        ) return;

        cleanup();

        const canvas = document.createElement('canvas');
        canvas.width = originalWidth;
        canvas.height = originalHeight;
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return;
        canvasRef.current = canvas;
        ctxRef.current = ctx;

        let cancelled = false;

        (async () => {
            try {
                const encoder = new VideoEncoder({
                    output: (chunk, meta) => {
                        if (meta?.decoderConfig) decoderConfigRef.current = meta.decoderConfig;
                        chunksRef.current.push({ chunk, meta });

                        // Prune chunks older than BUFFER_SEC relative to newest.
                        const cutoffUs = chunk.timestamp - BUFFER_SEC * 1_000_000;
                        const buf = chunksRef.current;
                        while (buf.length > 0 && buf[0].chunk.timestamp < cutoffUs) buf.shift();

                        setRecordingDuration(Math.min(BUFFER_SEC, Math.round(buf.length / FPS)));
                    },
                    error: (e) => console.error('[LiveRecorder] encoder error', e),
                });

                // Baseline profile: no B-frames, chunks sort cleanly by
                // timestamp and there's no reorder delay to handle on save.
                let config: VideoEncoderConfig = {
                    codec: 'avc1.42001e',
                    width: originalWidth,
                    height: originalHeight,
                    bitrate: BITRATE,
                    framerate: FPS,
                };
                const support = await VideoEncoder.isConfigSupported(config);
                if (!support.supported) config = { ...config, codec: 'avc1.4d002a' };
                if (cancelled) return;

                encoder.configure(config);
                encoderRef.current = encoder;
                startPerfRef.current = performance.now();
                frameCountRef.current = 0;

                // Worker-driven timer: RAF is throttled in background tabs,
                // which would freeze the rolling buffer. A setInterval inside
                // a worker keeps ticking.
                const workerSrc = `
                    let id;
                    self.onmessage = (e) => {
                        if (e.data === 'start') id = setInterval(() => self.postMessage('tick'), ${FRAME_INTERVAL_MS});
                        else if (e.data === 'stop') { clearInterval(id); id = null; }
                    };
                `;
                const worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })));
                workerRef.current = worker;

                let lastFrameMs = 0;

                worker.onmessage = () => {
                    const v = videoRef.current;
                    const enc = encoderRef.current;
                    const c = canvasRef.current;
                    const cx = ctxRef.current;
                    if (!v || !enc || !c || !cx || enc.state !== 'configured') return;
                    if (v.readyState < 2) return;

                    const now = performance.now();
                    if (now - lastFrameMs < FRAME_INTERVAL_MS - 2) return;
                    lastFrameMs = now;

                    cx.drawImage(v, 0, 0, c.width, c.height);
                    if (showBBoxesRef.current) {
                        drawBBoxes(
                            cx,
                            bboxesRef.current ?? [],
                            originalWidth,
                            originalHeight,
                            c.width,
                            c.height,
                            confidenceRef.current,
                        );
                    }

                    const timestampUs = (now - startPerfRef.current) * 1000;
                    const frame = new VideoFrame(c, {
                        timestamp: timestampUs,
                        duration: FRAME_INTERVAL_MS * 1000,
                    });
                    // Keyframe every 2s so the buffer stays seekable after pruning.
                    const keyFrame = frameCountRef.current % (FPS * 2) === 0;
                    try { enc.encode(frame, { keyFrame }); } catch (e) { console.error(e); }
                    frame.close();
                    frameCountRef.current++;
                };

                worker.postMessage('start');
            } catch (e) {
                console.error('[LiveRecorder] init failed', e);
                cleanup();
            }
        })();

        return () => { cancelled = true; };
    }, [enabled, videoRef, bboxesRef, originalWidth, originalHeight, cleanup]);

    const saveRecording = useCallback(async () => {
        const enc = encoderRef.current;
        if (enc && enc.state === 'configured') {
            try { await enc.flush(); } catch { /* ignore */ }
        }
        const buf = chunksRef.current;
        if (buf.length === 0) return;

        const sorted = [...buf].sort((a, b) => a.chunk.timestamp - b.chunk.timestamp);
        const firstKeyIdx = sorted.findIndex(c => c.chunk.type === 'key');
        if (firstKeyIdx < 0) return;
        const valid = sorted.slice(firstKeyIdx);
        if (valid.length === 0) return;

        // If the first chunk's meta has been dropped (it predates buffer
        // start), re-attach the cached decoder config so the muxer knows
        // how to write the AVCC.
        if (!valid[0].meta?.decoderConfig && decoderConfigRef.current) {
            valid[0].meta = { ...valid[0].meta, decoderConfig: decoderConfigRef.current };
        }

        try {
            const muxer = new Mp4Muxer.Muxer({
                target: new Mp4Muxer.ArrayBufferTarget(),
                video: { codec: 'avc', width: originalWidth, height: originalHeight },
                firstTimestampBehavior: 'offset',
                fastStart: 'in-memory',
            });
            for (const { chunk, meta } of valid) {
                const dur = chunk.duration || (1_000_000 / FPS);
                muxer.addVideoChunk(chunk, meta, chunk.timestamp, dur);
            }
            muxer.finalize();

            const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `live-${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (e) {
            console.error('[LiveRecorder] mux failed', e);
        }
    }, [originalWidth, originalHeight]);

    return { recordingDuration, saveRecording };
};
