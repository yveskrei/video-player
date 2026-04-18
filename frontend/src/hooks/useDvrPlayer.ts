import { useCallback, useEffect, useRef, useState } from 'react';
import type * as dashjs from 'dashjs';

// "At live edge" threshold. dash.js configures liveDelay=6s plus ~2s of
// encoding headroom; 12s keeps the LIVE badge from flickering on jitter.
const LIVE_THRESHOLD_SEC = 12;
const POLL_MS = 200;

export interface DvrState {
    playhead: number;        // video.currentTime, absolute, seconds
    duration: number;        // live edge, seconds, same scale as playhead
    dvrStart: number;        // earliest seekable position, seconds
    dvrWindowSize: number;   // duration - dvrStart
    isLive: boolean;
    isPaused: boolean;
    isReady: boolean;
}

const INITIAL: DvrState = {
    playhead: 0,
    duration: 0,
    dvrStart: 0,
    dvrWindowSize: 0,
    isLive: true,
    isPaused: false,
    isReady: false,
};

const readWin = (player: dashjs.MediaPlayerClass): { start: number; end: number } | null => {
    try {
        const w = player.getDvrWindow?.();
        if (w && Number.isFinite(w.end) && w.end > 0) {
            return { start: Math.max(0, w.start ?? 0), end: w.end };
        }
    } catch { /* ignore */ }
    return null;
};

export const useDvrPlayer = (
    videoRef: React.RefObject<HTMLVideoElement | null>,
    dvrWindowSec: number,
    streamStartMs: number | null,
) => {
    const [state, setState] = useState<DvrState>(INITIAL);
    const playerRef = useRef<dashjs.MediaPlayerClass | null>(null);

    const windowSecRef = useRef(dvrWindowSec);
    const streamStartMsRef = useRef(streamStartMs);
    useEffect(() => { windowSecRef.current = dvrWindowSec; }, [dvrWindowSec]);
    useEffect(() => { streamStartMsRef.current = streamStartMs; }, [streamStartMs]);

    // Monotonic wall-clock anchor on the MPD's live edge. `win.end` is the
    // authoritative live-edge reading *on the same scale as video.currentTime*
    // (presentation time), so it's what we have to use as `duration` — using
    // wall-clock via streamStartMs drifts because the backend's clock and the
    // MPD's availabilityStartTime are offset by ffmpeg startup + small framerate
    // mismatches, which over tens of seconds add up to minutes of apparent
    // "falling behind live" with no actual playhead movement.
    //
    // The wall-clock anchor here only smooths over MPD refresh cadence: between
    // MPD updates dash.js may not advance win.end, so we interpolate forward at
    // 1×. When a fresh win.end arrives past the interpolation, we snap up.
    const anchorRef = useRef<{ end: number; t: number } | null>(null);

    const setPlayer = useCallback((p: dashjs.MediaPlayerClass | null) => {
        playerRef.current = p;
        anchorRef.current = null;
    }, []);

    useEffect(() => {
        const id = setInterval(() => {
            const video = videoRef.current;
            const player = playerRef.current;
            if (!video || !player) return;

            const windowSec = windowSecRef.current > 0 ? windowSecRef.current : 300;
            const win = readWin(player);
            const now = performance.now();

            let duration = 0;
            let rawDvrStart = 0;

            if (win && win.end > 0) {
                const prev = anchorRef.current;
                // Backward jump of more than 2s = stream reset / manifest
                // rollover. Re-anchor rather than interpolating across it.
                const regressed = prev !== null && win.end < prev.end - 2;
                if (prev === null || win.end > prev.end || regressed) {
                    anchorRef.current = { end: win.end, t: now };
                }
                const anchor = anchorRef.current!;
                const elapsed = (now - anchor.t) / 1000;
                duration = Math.max(win.end, anchor.end + elapsed);
                rawDvrStart = win.start;
            } else if (video.seekable.length > 0) {
                duration = video.seekable.end(video.seekable.length - 1);
                rawDvrStart = video.seekable.start(0);
                anchorRef.current = null;
            } else if (streamStartMsRef.current && streamStartMsRef.current > 0) {
                // Pre-first-MPD fallback. Scale *will* be wrong here but it's
                // only used for the brief moment before dash.js parses the
                // manifest; the `win`-based branch takes over immediately.
                duration = (Date.now() - streamStartMsRef.current) / 1000;
                anchorRef.current = null;
            }

            // Cap dvrStart at (duration - windowSec) so a stale win.start can't
            // over-advertise retention. For young streams win.start=0 and the
            // cap is a no-op until the window fills up.
            const dvrStart = Math.max(rawDvrStart, duration - windowSec);
            const dvrWindowSize = Math.max(0, duration - dvrStart);

            const playhead = video.currentTime;
            const isPaused = video.paused;
            const behindLive = duration - playhead;
            // Pausing freezes the current frame — by definition behind live.
            const isLive = !isPaused && behindLive <= LIVE_THRESHOLD_SEC;
            const isReady = duration > 0 && video.readyState >= 1;

            setState(prev => {
                if (
                    prev.isReady === isReady
                    && prev.isLive === isLive
                    && prev.isPaused === isPaused
                    && Math.abs(prev.playhead - playhead) < 0.05
                    && Math.abs(prev.duration - duration) < 0.05
                    && Math.abs(prev.dvrStart - dvrStart) < 0.05
                    && Math.abs(prev.dvrWindowSize - dvrWindowSize) < 0.05
                ) return prev;
                return { playhead, duration, dvrStart, dvrWindowSize, isLive, isPaused, isReady };
            });
        }, POLL_MS);
        return () => clearInterval(id);
    }, [videoRef]);

    const play = useCallback(() => { videoRef.current?.play().catch(() => {}); }, [videoRef]);
    const pause = useCallback(() => { videoRef.current?.pause(); }, [videoRef]);
    const togglePlay = useCallback(() => {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused) v.play().catch(() => {});
        else v.pause();
    }, [videoRef]);

    const seekTo = useCallback((timeSec: number) => {
        const video = videoRef.current;
        const player = playerRef.current;
        if (!video || !player) return;
        // Clamp against the MPD's seekable range. Apply the seek
        // synchronously — the earlier refreshManifest-wrapped version
        // introduced a visible delay between click and playhead update
        // (manifest fetches can take hundreds of ms, during which the user
        // sees no response). Kick off a refresh in the background so
        // dash.js can pick up fresh segments if the seek landed in a range
        // it hadn't fetched yet.
        const w = readWin(player);
        const low = w ? w.start : (video.seekable.length > 0 ? video.seekable.start(0) : 0);
        const high = w ? w.end : (video.seekable.length > 0 ? video.seekable.end(video.seekable.length - 1) : (video.duration || 0));
        const target = Math.min(Math.max(timeSec, low), high);
        try { video.currentTime = target; } catch { /* ignore */ }
        try { player.refreshManifest(() => {}); } catch { /* ignore */ }
    }, [videoRef]);

    const seekBy = useCallback((deltaSec: number) => {
        const v = videoRef.current;
        if (!v) return;
        seekTo(v.currentTime + deltaSec);
    }, [videoRef, seekTo]);

    const seekToLive = useCallback(() => {
        const player = playerRef.current;
        if (!player) return;
        try {
            player.refreshManifest(() => {
                const p = playerRef.current;
                const v = videoRef.current;
                if (!p || !v) return;
                const w = readWin(p);
                const end = w ? w.end : (v.seekable.length > 0 ? v.seekable.end(v.seekable.length - 1) : 0);
                if (end <= 0) return;
                // Seek 5s behind live so the decoder has headroom.
                try {
                    v.currentTime = Math.max(end - 5, 0);
                    v.play().catch(() => {});
                } catch { /* ignore */ }
            });
        } catch { /* ignore */ }
    }, [videoRef]);

    return { state, setPlayer, play, pause, togglePlay, seekTo, seekBy, seekToLive };
};
