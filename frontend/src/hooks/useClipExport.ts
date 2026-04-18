import { useCallback, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { exportDvrClip } from '../utils/exportDvrClip';
import { getBackendUrl } from '../api/client';
import type { BBox } from '../types';

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

export const useClipExport = () => {
    const [isExporting, setIsExporting] = useState(false);
    const [progress, setProgress] = useState<number | null>(null);
    const toastIdRef = useRef<string | null>(null);

    const exportClip = useCallback(async (args: ExportArgs): Promise<boolean> => {
        if (isExporting) return false;
        setIsExporting(true);
        setProgress(0);
        const tid = toast.loading('Exporting clip… 0%');
        toastIdRef.current = tid;

        const backendUrl = getBackendUrl();
        const manifestUrl = args.manifestUrl.startsWith('http')
            ? args.manifestUrl
            : `${backendUrl}${args.manifestUrl}`;

        try {
            await exportDvrClip({
                backendUrl,
                videoId: args.videoId,
                manifestUrl,
                startPts: args.startPts,
                endPts: args.endPts,
                bboxGroups: args.bboxGroups,
                showBBoxes: args.showBBoxes,
                minConfidence: args.minConfidence,
                originalWidth: args.originalWidth,
                originalHeight: args.originalHeight,
                onProgress: (f) => {
                    setProgress(f);
                    toast.loading(`Exporting clip… ${Math.round(f * 100)}%`, { id: tid });
                },
            });
            toast.success('Clip saved', { id: tid });
            return true;
        } catch (e) {
            console.error(e);
            toast.error(`Export failed: ${(e as Error).message}`, { id: tid });
            return false;
        } finally {
            setIsExporting(false);
            setProgress(null);
            toastIdRef.current = null;
        }
    }, [isExporting]);

    return { isExporting, progress, exportClip };
};
