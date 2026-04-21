import { useCallback, useEffect, useRef, useState } from 'react';
import * as dashjs from 'dashjs';

// All times in DvrState are in absolute presentation seconds (same scale
// as video.currentTime on a live DASH stream). Window-relative values —
// what dash.js calls timeInDvrWindow — are kept internal to this hook;
// callers that need them can subtract dvrStart.
export interface DvrState {
    playhead: number;        // video.currentTime (absolute presentation seconds)
    duration: number;        // absolute presentation time of the live edge
    dvrStart: number;        // absolute presentation time of window start
    dvrWindowSize: number;   // duration - dvrStart
    behindLive: number;      // duration - playhead; 0 at live edge
    isLive: boolean;
    isPaused: boolean;
    isReady: boolean;
}

const INITIAL: DvrState = {
    playhead: 0,
    duration: 0,
    dvrStart: 0,
    dvrWindowSize: 0,
    behindLive: 0,
    isLive: true,
    isPaused: false,
    isReady: false,
};

// Slack on top of dash.js's own target live delay before un-setting "LIVE".
// Keeps the badge from flickering on jitter.
const LIVE_SLACK_SEC = 2;

export const useDvrPlayer = (
    videoRef: React.RefObject<HTMLVideoElement | null>,
    maxDvrWindowSec?: number,
) => {
    const [state, setState] = useState<DvrState>(INITIAL);
    const playerRef = useRef<dashjs.MediaPlayerClass | null>(null);

    const readState = useCallback((): DvrState | null => {
        const player = playerRef.current;
        const video = videoRef.current;
        if (!player || !video) return null;
        try {
            if (player.isDynamic()) {
                // Canonical dash.js live formulas. `win.end` is wall-clock-
                // derived and monotonic (once UTC sync is disabled). `win.start`
                // can jitter by tens of seconds across MPD refreshes because
                // of period-range clamping inside dash.js — so we don't trust
                // `win.size` as an authoritative window. Instead, clamp to the
                // backend's advertised max (`maxDvrWindowSec` from VideoInfo)
                // and derive `dvrStart` from `win.end` minus the capped size.
                // That pins the seekbar's left edge on a mature stream and
                // still degrades gracefully on young streams (where
                // `win.size < maxDvrWindowSec` and we pass it through).
                const win = player.getDvrWindow();
                const inWin = player.timeInDvrWindow();
                if (!win || !win.size || win.size <= 0) return null;
                const rawSize = win.size;
                const cappedSize = maxDvrWindowSec && maxDvrWindowSec > 0
                    ? Math.min(rawSize, maxDvrWindowSec)
                    : rawSize;
                const duration = win.end;                       // absolute live edge, authoritative
                const dvrStart = duration - cappedSize;         // stable left edge
                const playhead = win.start + inWin;             // = video.currentTime, absolute
                const behindLive = Math.max(0, duration - playhead);
                const targetDelay = typeof player.getTargetLiveDelay === 'function'
                    ? player.getTargetLiveDelay()
                    : 6;
                const isPaused = video.paused;
                const isLive = !isPaused && behindLive <= targetDelay + LIVE_SLACK_SEC;
                return {
                    playhead,
                    duration,
                    dvrStart,
                    dvrWindowSize: cappedSize,
                    behindLive,
                    isLive,
                    isPaused,
                    isReady: video.readyState >= 1,
                };
            }
            // VoD (reserved for future uploaded-video playback).
            const d = player.duration();
            const duration = Number.isFinite(d) ? d : 0;
            return {
                playhead: video.currentTime,
                duration,
                dvrStart: 0,
                dvrWindowSize: duration,
                behindLive: 0,
                isLive: false,
                isPaused: video.paused,
                isReady: video.readyState >= 1,
            };
        } catch {
            return null;
        }
    }, [videoRef, maxDvrWindowSec]);

    const flush = useCallback(() => {
        const next = readState();
        if (!next) return;
        setState(prev => {
            if (
                prev.isReady === next.isReady
                && prev.isLive === next.isLive
                && prev.isPaused === next.isPaused
                && Math.abs(prev.playhead - next.playhead) < 0.05
                && Math.abs(prev.duration - next.duration) < 0.05
                && Math.abs(prev.dvrStart - next.dvrStart) < 0.05
                && Math.abs(prev.behindLive - next.behindLive) < 0.05
            ) return prev;
            return next;
        });
    }, [readState]);

    const setPlayer = useCallback((p: dashjs.MediaPlayerClass | null) => {
        const prev = playerRef.current;
        if (prev) {
            try {
                prev.off(dashjs.MediaPlayer.events.PLAYBACK_TIME_UPDATED, flush);
                prev.off(dashjs.MediaPlayer.events.PLAYBACK_PAUSED, flush);
                prev.off(dashjs.MediaPlayer.events.PLAYBACK_STARTED, flush);
                prev.off(dashjs.MediaPlayer.events.PLAYBACK_SEEKED, flush);
            } catch { /* ignore */ }
        }
        playerRef.current = p;
        setState(INITIAL);
        if (p) {
            p.on(dashjs.MediaPlayer.events.PLAYBACK_TIME_UPDATED, flush);
            p.on(dashjs.MediaPlayer.events.PLAYBACK_PAUSED, flush);
            p.on(dashjs.MediaPlayer.events.PLAYBACK_STARTED, flush);
            p.on(dashjs.MediaPlayer.events.PLAYBACK_SEEKED, flush);
        }
    }, [flush]);

    // Paused-state safety net. PLAYBACK_TIME_UPDATED stops firing when
    // currentTime isn't advancing, but dash.js's internal 100 ms tick still
    // slides range.start/end, so behindLive must grow on pause. Poll at
    // 500 ms to pick that up without burning CPU.
    useEffect(() => {
        const id = setInterval(flush, 500);
        return () => clearInterval(id);
    }, [flush]);

    const play = useCallback(() => { videoRef.current?.play().catch(() => {}); }, [videoRef]);
    const pause = useCallback(() => { videoRef.current?.pause(); }, [videoRef]);
    const togglePlay = useCallback(() => {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused) v.play().catch(() => {});
        else v.pause();
    }, [videoRef]);

    // Mark `video.currentTime` writes as user-initiated for a short window
    // so the diagnostic interceptor in VideoPlayer.tsx can distinguish
    // user seeks from dash.js-internal ones.
    const markUserSeek = () => {
        const v = videoRef.current as (HTMLVideoElement & { __userSeekingUntil?: number }) | null;
        if (v) v.__userSeekingUntil = performance.now() + 500;
    };

    // All seek* functions take absolute presentation seconds. dash.js's
    // `player.seek(value)` wants an offset relative to DVRWindow.start and
    // clamps to the seekable range, so we subtract dvrStart once here.
    // Targets are rounded to whole seconds — the display label has only
    // integer resolution anyway, so seeking to fractional times gives the
    // user no additional accuracy but does complicate the "behind live"
    // readout at the moment of seek.
    const seekTo = useCallback((absoluteSec: number) => {
        const p = playerRef.current;
        if (!p) return;
        try {
            markUserSeek();
            const win = p.getDvrWindow();
            const rel = Math.max(0, Math.round(absoluteSec - (win?.start ?? 0)));
            p.seek(rel);
        } catch { /* ignore */ }
    }, [videoRef]);

    const seekBy = useCallback((deltaSec: number) => {
        const p = playerRef.current;
        if (!p) return;
        try {
            markUserSeek();
            const inWin = p.timeInDvrWindow();
            p.seek(Math.max(0, Math.round(inWin + deltaSec)));
        } catch { /* ignore */ }
    }, [videoRef]);

    const seekToLive = useCallback(() => {
        const p = playerRef.current;
        if (!p) return;
        try {
            markUserSeek();
            p.seekToOriginalLive();
        } catch { /* ignore */ }
    }, [videoRef]);

    return { state, setPlayer, play, pause, togglePlay, seekTo, seekBy, seekToLive };
};
