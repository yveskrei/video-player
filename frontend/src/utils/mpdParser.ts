// MPD parsing lives on the main thread because the worker context has no
// DOMParser. The parse result is a plain JS object (structured-clonable)
// and is handed to the clip-export worker via postMessage.

export interface TimelineEntry {
    number: number;
    startSec: number;
    durationSec: number;
}

export interface SegmentTemplateInfo {
    initUrl: string;
    mediaTemplate: string;
    timescale: number;
    startNumber: number;
    timeline: TimelineEntry[];
    baseUrl: string;
}

export const resolveDashUrl = (manifestUrl: string, relativePath: string): string => {
    const idx = manifestUrl.lastIndexOf('/');
    const base = idx >= 0 ? manifestUrl.slice(0, idx + 1) : '';
    try {
        return new URL(relativePath, base || window.location.href).toString();
    } catch {
        return base + relativePath;
    }
};

export const parseMpd = (xml: string, manifestUrl: string): SegmentTemplateInfo => {
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
        const segDuration = fixedDuration / timescale;
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

export const formatSegmentUrl = (tpl: SegmentTemplateInfo, number: number): string => {
    const match = tpl.mediaTemplate.match(/\$Number(?:%0(\d+)d)?\$/);
    if (!match) throw new Error(`Unsupported media template: ${tpl.mediaTemplate}`);
    const pad = match[1] ? parseInt(match[1], 10) : 0;
    const nstr = pad > 0 ? number.toString().padStart(pad, '0') : number.toString();
    return resolveDashUrl(tpl.baseUrl, tpl.mediaTemplate.replace(match[0], nstr));
};
