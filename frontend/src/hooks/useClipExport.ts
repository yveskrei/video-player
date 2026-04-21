import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { getBackendUrl } from '../api/client';
import type { BBox } from '../types';
import { parseMpd } from '../utils/mpdParser';

interface ExportArgs {
    videoId: number;
    manifestUrl: string;
    startPts: number;
    endPts: number;
    bboxGroups: Map<number, BBox[]>;
    showBBoxes: boolean;
    minConfidence: number;
    originalWidth: number;
    originalHeight: number;
}

type WorkerMessage =
    | { type: 'progress'; fraction: number }
    | { type: 'done'; buffer: ArrayBuffer }
    | { type: 'error'; message: string };

export const useClipExport = () => {
    const [isExporting, setIsExporting] = useState(false);
    const [progress, setProgress] = useState<number | null>(null);
    const activeWorkerRef = useRef<Worker | null>(null);

    // Kill any in-flight worker on unmount — otherwise a long transcode keeps
    // running in the background after the user navigates away.
    useEffect(() => () => {
        activeWorkerRef.current?.terminate();
        activeWorkerRef.current = null;
    }, []);

    const exportClip = useCallback(async (args: ExportArgs): Promise<boolean> => {
        if (isExporting) return false;
        setIsExporting(true);
        setProgress(0);
        const tid = toast.loading('Exporting clip… 0%');

        const backendUrl = getBackendUrl();
        const manifestUrl = args.manifestUrl.startsWith('http')
            ? args.manifestUrl
            : `${backendUrl}${args.manifestUrl}`;

        // MPD parsing lives on the main thread because DOMParser isn't
        // available inside Web Workers. The rest of the export pipeline
        // (segment fetch + transcode) runs in the worker.
        let tpl;
        try {
            const mpdText = await (await fetch(manifestUrl)).text();
            tpl = parseMpd(mpdText, manifestUrl);
        } catch (e) {
            toast.error(`Export failed: ${(e as Error).message}`, { id: tid });
            setIsExporting(false);
            setProgress(null);
            return false;
        }

        const worker = new Worker(
            new URL('../workers/exportClip.worker.ts', import.meta.url),
            { type: 'module' },
        );
        activeWorkerRef.current = worker;

        return new Promise<boolean>((resolve) => {
            const finish = (ok: boolean) => {
                worker.terminate();
                if (activeWorkerRef.current === worker) activeWorkerRef.current = null;
                setIsExporting(false);
                setProgress(null);
                resolve(ok);
            };

            worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
                const msg = e.data;
                if (msg.type === 'progress') {
                    setProgress(msg.fraction);
                    toast.loading(`Exporting clip… ${Math.round(msg.fraction * 100)}%`, { id: tid });
                } else if (msg.type === 'done') {
                    const blob = new Blob([msg.buffer], { type: 'video/mp4' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `clip-${new Date().toISOString()}.mp4`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    toast.success('Clip saved', { id: tid });
                    finish(true);
                } else if (msg.type === 'error') {
                    toast.error(`Export failed: ${msg.message}`, { id: tid });
                    finish(false);
                }
            };

            worker.onerror = (e) => {
                toast.error(`Export failed: ${e.message || 'worker error'}`, { id: tid });
                finish(false);
            };

            worker.postMessage({
                type: 'start',
                job: {
                    tpl,
                    startPts: args.startPts,
                    endPts: args.endPts,
                    bboxEntries: Array.from(args.bboxGroups.entries()),
                    showBBoxes: args.showBBoxes,
                    minConfidence: args.minConfidence,
                    originalWidth: args.originalWidth,
                    originalHeight: args.originalHeight,
                },
            });
        });
    }, [isExporting]);

    return { isExporting, progress, exportClip };
};
