import * as Mp4Muxer from 'mp4-muxer';
import { createFile, DataStream as Mp4DataStream } from 'mp4box';
import type { BBox } from '../types';
import { drawBBoxes } from './drawing';

const PTS_TIMEBASE = 90000;
const MAX_CLIP_DURATION_SEC = 300;
const DEFAULT_FPS = 30;

interface ExportOptions {
    backendUrl: string;
    videoId: number;
    manifestUrl: string;
    startPts: number;
    endPts: number;
    bboxGroups: Map<number, BBox[]>;
    showBBoxes: boolean;
    minConfidence: number;
    originalWidth: number;
    originalHeight: number;
    onProgress: (fraction: number) => void;
}

interface TimelineEntry {
    number: number;     // segment number
    startSec: number;   // segment start time (stream seconds)
    durationSec: number;
}

interface SegmentTemplateInfo {
    initUrl: string;
    mediaTemplate: string;
    timescale: number;
    startNumber: number;
    timeline: TimelineEntry[];
    baseUrl: string;
}

const resolveDashUrl = (manifestUrl: string, relativePath: string): string => {
    const idx = manifestUrl.lastIndexOf('/');
    const base = idx >= 0 ? manifestUrl.slice(0, idx + 1) : '';
    try {
        return new URL(relativePath, base || window.location.href).toString();
    } catch {
        return base + relativePath;
    }
};

const parseMpd = (xml: string, manifestUrl: string): SegmentTemplateInfo => {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const tpl =
        doc.querySelector('Representation SegmentTemplate') ??
        doc.querySelector('AdaptationSet SegmentTemplate') ??
        doc.querySelector('SegmentTemplate');
    if (!tpl) throw new Error('MPD has no SegmentTemplate — unsupported format');

    const rep = doc.querySelector('Representation');
    const repId = rep?.getAttribute('id') ?? 'stream0';

    const initUrlRel = (tpl.getAttribute('initialization') ?? '').replace('$RepresentationID$', repId);
    const mediaTemplate = (tpl.getAttribute('media') ?? '').replace('$RepresentationID$', repId);
    const timescale = parseInt(tpl.getAttribute('timescale') ?? '1000', 10);
    const startNumber = parseInt(tpl.getAttribute('startNumber') ?? '1', 10);
    const fixedDuration = parseInt(tpl.getAttribute('duration') ?? '0', 10);

    const baseUrl = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);
    const timeline: TimelineEntry[] = [];
    const stl = tpl.querySelector('SegmentTimeline');
    if (stl) {
        let number = startNumber;
        let currentTime = 0;
        for (const s of Array.from(stl.querySelectorAll('S'))) {
            const t = s.getAttribute('t');
            if (t !== null) currentTime = parseInt(t, 10);
            const d = parseInt(s.getAttribute('d') ?? '0', 10);
            const r = parseInt(s.getAttribute('r') ?? '0', 10);
            for (let i = 0; i <= r; i++) {
                timeline.push({
                    number,
                    startSec: currentTime / timescale,
                    durationSec: d / timescale,
                });
                currentTime += d;
                number++;
            }
        }
    } else if (fixedDuration > 0) {
        // Fall back to uniform durations when no SegmentTimeline is present.
        const segDuration = fixedDuration / timescale;
        // We don't know the count without parsing timeShiftBufferDepth; generate 200 (>300s coverage).
        for (let i = 0; i < 200; i++) {
            timeline.push({
                number: startNumber + i,
                startSec: i * segDuration,
                durationSec: segDuration,
            });
        }
    }

    return {
        initUrl: resolveDashUrl(manifestUrl, initUrlRel),
        mediaTemplate,
        timescale,
        startNumber,
        timeline,
        baseUrl,
    };
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

export async function exportDvrClip(opts: ExportOptions): Promise<void> {
    const {
        manifestUrl, startPts, endPts,
        bboxGroups, showBBoxes, minConfidence,
        originalWidth, originalHeight,
        onProgress,
    } = opts;

    const startSec = startPts / PTS_TIMEBASE;
    const endSec = endPts / PTS_TIMEBASE;
    const durationSec = endSec - startSec;
    if (durationSec <= 0) throw new Error('Empty clip selection');
    if (durationSec > MAX_CLIP_DURATION_SEC) throw new Error(`Clip exceeds ${MAX_CLIP_DURATION_SEC}s cap`);
    if (originalWidth <= 0 || originalHeight <= 0) throw new Error('Video resolution not yet available');

    const mpdText = await (await fetch(manifestUrl)).text();
    const tpl = parseMpd(mpdText, manifestUrl);

    // Cover any segment that overlaps [startSec, endSec].
    const covering = tpl.timeline.filter(seg =>
        (seg.startSec + seg.durationSec) > startSec && seg.startSec < endSec
    );
    if (covering.length === 0) throw new Error('No DASH segments available for the selected range');

    // Fetch init, then segments in order.
    const initBuf = await fetchBuffer(tpl.initUrl);

    // Demux with mp4box: append init, then append each segment; we'll receive samples via onSamples.
    interface Sample {
        data: Uint8Array;
        cts: number;       // in file timescale
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

            // Build AVCC description from the track's avcC box (mp4box types don't expose avcC directly)
            const trak = file.getTrackById(track.id);
            const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0] as any;
            const avcC = entry?.avcC ?? entry?.hvcC;
            if (avcC) {
                const stream = new Mp4DataStream(undefined, 0, (Mp4DataStream as any).BIG_ENDIAN);
                avcC.write(stream);
                // mp4box writes the full box (including 8-byte header: size + type); strip it
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

    // Running fileStart offset — mp4box needs increasing fileStart for each append.
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
        onProgress(0.3 * ((i + 1) / covering.length));
    }
    file.flush();

    if (samples.length === 0) throw new Error('No video samples decoded from DASH segments');

    // Set up WebCodecs decode → composite → encode → mux
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
        output: async (frame) => {
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
                encodedFrames++;
            } finally {
                // frame.close() already called in the skip branch; close here if not already.
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

    // Feed samples in order. Track progress as we feed.
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
        if (i % 30 === 0) onProgress(0.3 + 0.6 * (i / samples.length));
    }

    await decoder.flush();
    await encoder.flush();
    muxer.finalize();

    const target = muxer.target as Mp4Muxer.ArrayBufferTarget;
    const blob = new Blob([target.buffer], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `clip-${new Date().toISOString()}.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    decoder.close();
    encoder.close();
    onProgress(1);
}
