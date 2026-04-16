import { useEffect, useRef, useState, useCallback } from 'react';
import type * as dashjs from 'dashjs';

// Threshold for considering the playhead "at live edge".
// dash.js is configured with liveDelay=6s (see VideoPlayer.tsx), so at the live edge
// the gap between `duration` (live edge) and `time` (current position) is ~6s.
// Anything within liveDelay + a small margin counts as live.
const LIVE_DELAY_SEC = 6.0;
const LIVE_THRESHOLD_SEC = LIVE_DELAY_SEC + 2.0;
const POLL_INTERVAL_MS = 200;
// Hard cap on the DVR window regardless of what dash.js reports.
// Matches the backend's DASH_WINDOW_SIZE (150 segments × 2s = 300s) in stream_manager.py.
const DVR_WINDOW_CAP_SEC = 300;

export interface DvrState {
    playhead: number;
    duration: number;
    dvrWindowSize: number;
    dvrStart: number;
    isLive: boolean;
    isPaused: boolean;
    isReady: boolean;
}

const defaultState: DvrState = {
    playhead: 0,
    duration: 0,
    dvrWindowSize: 0,
    dvrStart: 0,
    isLive: true,
    isPaused: false,
    isReady: false,
};

export const useDvrPlayer = (videoRef: React.RefObject<HTMLVideoElement | null>) => {
    const [state, setState] = useState<DvrState>(defaultState);
    const playerRef = useRef<dashjs.MediaPlayerClass | null>(null);
    const manifestPollPausedRef = useRef<boolean>(false);

    const setPlayer = useCallback((p: dashjs.MediaPlayerClass | null) => {
        playerRef.current = p;
    }, []);

    useEffect(() => {
        const interval = setInterval(() => {
            const video = videoRef.current;
            const player = playerRef.current;
            if (!video || !player) return;

            try {
                // Use the manifest's DVR window (not HTMLMediaElement.seekable) — the
                // latter only reflects what dash.js has buffered, which at the live
                // edge is ~6s, making seek-back-into-DVR impossible.
                const win = player.getDvrWindow?.();
                let duration = win?.end ?? player.duration() ?? 0;
                let dvrStart = win?.start ?? 0;
                if (!Number.isFinite(duration) || duration <= 0) {
                    duration = video.duration && Number.isFinite(video.duration) ? video.duration : 0;
                }
                const dvrWindowSize = Math.min(DVR_WINDOW_CAP_SEC, Math.max(0, duration - dvrStart));
                dvrStart = Math.max(dvrStart, duration - dvrWindowSize);

                const playhead = player.time() ?? video.currentTime;
                const behindLive = duration - playhead;
                const isLive = behindLive <= LIVE_THRESHOLD_SEC + 0.01;
                const isPaused = video.paused;

                setState({
                    playhead,
                    duration,
                    dvrWindowSize,
                    dvrStart,
                    isLive,
                    isPaused,
                    isReady: duration > 0,
                });
            } catch {
                // dash.js can throw while reloading / tearing down — ignore until next tick
            }
        }, POLL_INTERVAL_MS);

        return () => clearInterval(interval);
    }, [videoRef]);

    const play = useCallback(() => {
        videoRef.current?.play().catch(() => {});
    }, [videoRef]);

    const pause = useCallback(() => {
        videoRef.current?.pause();
    }, [videoRef]);

    const togglePlay = useCallback(() => {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused) v.play().catch(() => {});
        else v.pause();
    }, [videoRef]);

    const seekTo = useCallback((timeSeconds: number) => {
        const video = videoRef.current;
        const player = playerRef.current;
        if (!video || !player) return;

        // Clamp bounds: prefer manifest DVR window, fall back to video.seekable.
        let win: { start: number; end: number } | null = null;
        try { win = player.getDvrWindow?.() ?? null; } catch { win = null; }

        let high = win?.end ?? 0;
        let low = win?.start ?? 0;
        if (high <= 0 && video.seekable.length > 0) {
            high = video.seekable.end(video.seekable.length - 1);
            low = video.seekable.start(0);
        }
        if (high <= 0) high = player.duration() || video.duration || 0;
        low = Math.max(low, high - DVR_WINDOW_CAP_SEC);
        const clamped = Math.min(Math.max(timeSeconds, low), high);

        const seekableStart = video.seekable.length > 0 ? video.seekable.start(0) : null;
        const seekableEnd = video.seekable.length > 0 ? video.seekable.end(video.seekable.length - 1) : null;
        console.debug('[DVR seek]', {
            requested: timeSeconds.toFixed(2),
            clamped: clamped.toFixed(2),
            low: low.toFixed(2),
            high: high.toFixed(2),
            before: video.currentTime.toFixed(2),
            dvrWindow: win ? `[${win.start.toFixed(1)}, ${win.end.toFixed(1)}]` : 'n/a',
            videoSeekable: seekableStart !== null ? `[${seekableStart.toFixed(1)}, ${seekableEnd!.toFixed(1)}]` : 'n/a',
        });

        // Use video.currentTime directly — dash.js listens for the `seeking` event and
        // fetches the needed segment. Calling `player.seek()` has been observed to snap
        // back to the live edge when the stream was initialized with liveDelay set.
        try {
            video.currentTime = clamped;
        } catch (e) {
            console.warn('[DVR seek] currentTime failed, falling back to player.seek', e);
            try { player.seek(clamped); } catch { /* ignore */ }
        }
    }, [videoRef]);

    const seekBy = useCallback((deltaSeconds: number) => {
        const player = playerRef.current;
        if (!player) return;
        const current = player.time() ?? 0;
        seekTo(current + deltaSeconds);
    }, [seekTo]);

    const seekToLive = useCallback(() => {
        const player = playerRef.current;
        if (!player) return;
        const win = player.getDvrWindow?.();
        const target = win?.end ?? player.duration() ?? 0;
        try { player.seek(target); } catch { /* ignore */ }
    }, []);

    const setManifestPollPaused = useCallback((paused: boolean) => {
        const player = playerRef.current;
        if (!player) return;
        if (manifestPollPausedRef.current === paused) return;
        manifestPollPausedRef.current = paused;
        try {
            player.updateSettings({
                streaming: {
                    manifestUpdateRetryInterval: paused ? 60_000 : 1000,
                },
            });
        } catch { /* ignore */ }
    }, []);

    return {
        state,
        setPlayer,
        play,
        pause,
        togglePlay,
        seekTo,
        seekBy,
        seekToLive,
        setManifestPollPaused,
    };
};
