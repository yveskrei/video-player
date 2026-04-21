// DVR-clip export pipeline. Runs in a dedicated Web Worker so the main
// thread stays idle while we decode → composite → encode a few minutes of
// H.264 samples with optional BBox overlays. The main thread just posts a
// job, receives progress/done/error messages, and writes the resulting
// MP4 ArrayBuffer to a download link.
//
// Message contract (see hooks/useClipExport.ts for the main-thread side):
//   Main → Worker: { type: 'start', job: ExportJob }
//   Worker → Main: { type: 'progress', fraction }
//                  { type: 'done', buffer: ArrayBuffer } (transferred)
//                  { type: 'error', message }

import * as Mp4Muxer from 'mp4-muxer';
import { createFile, DataStream as Mp4DataStream } from 'mp4box';
import type { BBox } from '../types';
import { drawBBoxes } from '../utils/drawing';
import type { SegmentTemplateInfo } from '../utils/mpdParser';

const PTS_TIMEBASE = 90000;
const MAX_CLIP_DURATION_SEC = 300;
const DEFAULT_FPS = 30;

interface ExportJob {
    // MPD is parsed on the main thread (DOMParser is unavailable in
    // workers) and the already-resolved SegmentTemplateInfo is handed in
    // via the job. See `utils/mpdParser.ts`.
    tpl: SegmentTemplateInfo;
    startPts: number;
    endPts: number;
    bboxEntries: Array<[number, BBox[]]>;
    showBBoxes: boolean;
    minConfidence: number;
    originalWidth: number;
    originalHeight: number;
}

const post = (msg: unknown, transfer?: Transferable[]) => {
    (self as unknown as Worker).postMessage(msg, transfer ?? []);
};

const resolveDashUrl = (baseUrl: string, relativePath: string): string => {
    try {
        return new URL(relativePath, baseUrl || self.location.href).toString();
    } catch {
        return baseUrl + relativePath;
    }
};

const formatSegmentUrl = (tpl: SegmentTemplateInfo, number: number): string => {
    const match = tpl.mediaTemplate.match(/\$Number(?:%0(\d+)d)?\$/);
    if (!match) throw new Error(`Unsupported media template: ${tpl.mediaTemplate}`);
    const pad = match[1] ? parseInt(match[1], 10) : 0;
    const nstr = pad > 0 ? number.toString().padStart(pad, '0') : number.toString();
    return resolveDashUrl(tpl.baseUrl, tpl.mediaTemplate.replace(match[0], nstr));
};

const fetchBuffer = async (url: string): Promise<ArrayBuffer> => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch failed: ${url} (${r.status})`);
    return await r.arrayBuffer();
};

const findClosestBboxGroup = (
    groups: Map<number, BBox[]>,
    targetPts: number,
    maxDistancePts: number,
): BBox[] => {
    let best: { pts: number; bboxes: BBox[] } | null = null;
    for (const [pts, bboxes] of groups) {
        const d = Math.abs(pts - targetPts);
        if (d > maxDistancePts) continue;
        if (!best || d < Math.abs(best.pts - targetPts)) best = { pts, bboxes };
    }
    return best?.bboxes ?? [];
};

async function runExport(job: ExportJob): Promise<ArrayBuffer> {
    const {
        tpl, startPts, endPts,
        bboxEntries, showBBoxes, minConfidence,
        originalWidth, originalHeight,
    } = job;

    const bboxGroups = new Map<number, BBox[]>(bboxEntries);

    const startSec = startPts / PTS_TIMEBASE;
    const endSec = endPts / PTS_TIMEBASE;
    const durationSec = endSec - startSec;
    if (durationSec <= 0) throw new Error('Empty clip selection');
    if (durationSec > MAX_CLIP_DURATION_SEC) throw new Error(`Clip exceeds ${MAX_CLIP_DURATION_SEC}s cap`);
    if (originalWidth <= 0 || originalHeight <= 0) throw new Error('Video resolution not yet available');

    const covering = tpl.timeline.filter(seg =>
        (seg.startSec + seg.durationSec) > startSec && seg.startSec < endSec
    );
    if (covering.length === 0) throw new Error('No DASH segments available for the selected range');

    const initBuf = await fetchBuffer(tpl.initUrl);

    interface Sample {
        data: Uint8Array;
        cts: number;
        timescale: number;
        duration: number;
        is_sync: boolean;
    }

    const file = createFile();
    interface TrackInfo { id: number; timescale: number; codec: string; width: number; height: number }
    let trackInfo: TrackInfo | null = null;
    let description: Uint8Array | null = null;
    const samples: Sample[] = [];

    await new Promise<void>((resolve, reject) => {
        file.onError = (e: string) => reject(new Error(`mp4box: ${e}`));
        file.onReady = (info: any) => {
            const track = info.videoTracks?.[0] ?? info.tracks?.find((t: any) => t.type === 'video');
            if (!track) { reject(new Error('No video track in DASH stream')); return; }
            trackInfo = {
                id: track.id,
                timescale: track.timescale,
                codec: track.codec,
                width: track.video?.width ?? originalWidth,
                height: track.video?.height ?? originalHeight,
            };

            const trak = file.getTrackById(track.id);
            const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0] as any;
            const avcC = entry?.avcC ?? entry?.hvcC;
            if (avcC) {
                const stream = new Mp4DataStream(undefined, 0, (Mp4DataStream as any).BIG_ENDIAN);
                avcC.write(stream);
                const full = new Uint8Array(stream.buffer);
                description = full.slice(8);
            }
            file.setExtractionOptions(track.id, null, { nbSamples: 100 });
            file.start();
            resolve();
        };

        const initArr = initBuf as ArrayBuffer & { fileStart: number };
        initArr.fileStart = 0;
        file.appendBuffer(initArr as any);
    });

    if (!trackInfo || !description) throw new Error('Failed to parse DASH init segment');
    const track: TrackInfo = trackInfo;
    const desc: Uint8Array = description;

    file.onSamples = (_id: number, _user: unknown, batch: any[]) => {
        for (const s of batch) {
            samples.push({
                data: s.data,
                cts: s.cts,
                timescale: s.timescale,
                duration: s.duration,
                is_sync: !!s.is_sync,
            });
        }
    };

    let fileOffset = initBuf.byteLength;
    for (let i = 0; i < covering.length; i++) {
        const seg = covering[i];
        try {
            const segBuf = await fetchBuffer(formatSegmentUrl(tpl, seg.number));
            const arr = segBuf as ArrayBuffer & { fileStart: number };
            arr.fileStart = fileOffset;
            file.appendBuffer(arr as any);
            fileOffset += segBuf.byteLength;
        } catch (e) {
            console.warn('Missing segment', seg.number, e);
        }
        post({ type: 'progress', fraction: 0.3 * ((i + 1) / covering.length) });
    }
    file.flush();

    if (samples.length === 0) throw new Error('No video samples decoded from DASH segments');

    const canvas = new OffscreenCanvas(originalWidth, originalHeight);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Could not get 2D context');

    const muxer = new Mp4Muxer.Muxer({
        target: new Mp4Muxer.ArrayBufferTarget(),
        video: { codec: 'avc', width: originalWidth, height: originalHeight },
        firstTimestampBehavior: 'offset',
        fastStart: 'in-memory',
    });

    const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta, chunk.timestamp, chunk.duration ?? undefined),
        error: (e) => console.error('Encoder error', e),
    });

    const encConfig: VideoEncoderConfig = {
        codec: 'avc1.42001e',
        width: originalWidth,
        height: originalHeight,
        bitrate: 4_000_000,
        framerate: DEFAULT_FPS,
    };
    if (!(await VideoEncoder.isConfigSupported(encConfig)).supported) {
        encConfig.codec = 'avc1.4d002a';
    }
    encoder.configure(encConfig);

    let encodedFrames = 0;
    const startPtsStreamUnits = Math.round(startSec * track.timescale);

    const decoder = new VideoDecoder({
        output: (frame) => {
            try {
                const framePtsStreamUnits = frame.timestamp * track.timescale / 1_000_000;
                const framePts90k = framePtsStreamUnits * PTS_TIMEBASE / track.timescale;
                if (framePts90k < startPts - 3000 || framePts90k > endPts + 3000) {
                    frame.close();
                    return;
                }
                ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
                if (showBBoxes) {
                    const matched = findClosestBboxGroup(bboxGroups, framePts90k, 6000);
                    if (matched.length > 0) {
                        drawBBoxes(
                            ctx as unknown as CanvasRenderingContext2D,
                            matched,
                            originalWidth, originalHeight,
                            canvas.width, canvas.height,
                            minConfidence,
                        );
                    }
                }
                const relMicros = Math.max(0, (framePtsStreamUnits - startPtsStreamUnits) * 1_000_000 / track.timescale);
                const vf = new VideoFrame(canvas, {
                    timestamp: relMicros,
                    duration: 1_000_000 / DEFAULT_FPS,
                });
                const keyFrame = encodedFrames % 60 === 0;
                encoder.encode(vf, { keyFrame });
                vf.close();
                frame.close();
                encodedFrames++;
            } catch (e) {
                try { frame.close(); } catch { /* already closed */ }
                console.error('Frame pipeline error', e);
            }
        },
        error: (e) => console.error('Decoder error', e),
    });

    decoder.configure({
        codec: track.codec,
        codedWidth: track.width,
        codedHeight: track.height,
        description: desc,
    });

    for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        const timestampMicros = Math.round(s.cts * 1_000_000 / s.timescale);
        const durationMicros = Math.round(s.duration * 1_000_000 / s.timescale);
        decoder.decode(new EncodedVideoChunk({
            type: s.is_sync ? 'key' : 'delta',
            timestamp: timestampMicros,
            duration: durationMicros,
            data: s.data,
        }));
        if (i % 30 === 0) post({ type: 'progress', fraction: 0.3 + 0.6 * (i / samples.length) });
    }

    await decoder.flush();
    await encoder.flush();
    muxer.finalize();

    decoder.close();
    encoder.close();

    const target = muxer.target as Mp4Muxer.ArrayBufferTarget;
    post({ type: 'progress', fraction: 1 });
    return target.buffer;
}

self.onmessage = async (e: MessageEvent) => {
    const msg = e.data;
    if (msg?.type !== 'start') return;
    try {
        const buffer = await runExport(msg.job as ExportJob);
        post({ type: 'done', buffer }, [buffer]);
    } catch (err) {
        post({ type: 'error', message: (err as Error).message || String(err) });
    }
};

export {};
