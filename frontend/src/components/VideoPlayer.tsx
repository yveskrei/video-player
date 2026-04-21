import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import * as dashjs from 'dashjs';
import toast from 'react-hot-toast';

interface VideoPlayerProps {
    manifestUrl: string;
    onResolutionChange: (width: number, height: number) => void;
    onError?: (error: string) => void;
    onPlayerReady?: (player: dashjs.MediaPlayerClass) => void;
}

export const VideoPlayer = forwardRef<HTMLVideoElement, VideoPlayerProps>(({ manifestUrl, onResolutionChange, onError, onPlayerReady }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const playerRef = useRef<dashjs.MediaPlayerClass | null>(null);
    const onPlayerReadyRef = useRef(onPlayerReady);

    useImperativeHandle(ref, () => videoRef.current!);

    useEffect(() => {
        onPlayerReadyRef.current = onPlayerReady;
    }, [onPlayerReady]);

    useEffect(() => {
        if (!manifestUrl || !videoRef.current) return;
        if (playerRef.current) return;

        const MAX_RETRIES = 3;
        // The watchdog exists for a specific dash.js 5.1.1 race where
        // STREAMS_COMPOSED never fires (see comment below). It's *not* for
        // slow networks. 4s was aggressive enough to trigger on healthy-but-
        // slow inits; 10s is long enough that only the real bug fires it,
        // and the readyState≥1 check below means any sign of life counts as
        // progress.
        const READY_TIMEOUT_MS = 10000;

        let retriesLeft = MAX_RETRIES;
        let watchdog: ReturnType<typeof setTimeout> | null = null;
        let disposed = false;

        const clearWatchdog = () => {
            if (watchdog) {
                clearTimeout(watchdog);
                watchdog = null;
            }
        };

        const handleResize = () => {
            if (videoRef.current) {
                onResolutionChange(videoRef.current.videoWidth, videoRef.current.videoHeight);
            }
        };

        const handleCanPlay = () => {
            clearWatchdog();
        };

        const createAndInit = () => {
            if (disposed || !videoRef.current) return;

            const player = dashjs.MediaPlayer().create();

            player.updateSettings({
                streaming: {
                    // UTC sync DISABLED intentionally. The previous config used
                    // `urn:mpeg:dash:utc:direct:2014` with `value: new
                    // Date().toISOString()` captured once at init, which dash.js
                    // then treats as THE reference time for every subsequent
                    // re-sync. The computed `clientServerTimeShift` grows more
                    // negative every second (shift = parse(staticValue) -
                    // Date.now()), and feeds into
                    // `range.end = (Date.now() - AST + shift*1000)/1000`, which
                    // collapses to `(init_time - AST)/1000` — FROZEN. Playback
                    // advances past the frozen live edge, then dash.js's
                    // wallclock-tick `updateCurrentTime()` snaps currentTime
                    // back to range.end (captured live as -90s jumps in
                    // [DVR-DIAG/set] traces with `setInterval handler *$2 →
                    // W2 → F2 → setCurrentTime`).
                    //
                    // With `enabled: false`, dash.js leaves
                    // `clientServerTimeShift = 0` and derives `range.end`
                    // directly from `Date.now() - AST`, which advances at
                    // 1×/s monotonically — exactly what a stable live edge
                    // requires. Offline-safe (no external fetch), since the
                    // backend MPD does not advertise any `<UTCTiming>`
                    // element and dash.js won't try the default Akamai
                    // fallback when sync is off.
                    utcSynchronization: { enabled: false },
                    // The backend emits `-ldash 1`, which advertises low-latency DASH
                    // via ServiceDescription and SuggestedPresentationDelay. dash.js
                    // auto-enables its LL catchup path on those manifests and drags
                    // the playhead toward live whenever it decides we're "too far
                    // behind" — which breaks DVR seeks (user seeks to -1:00, drifts
                    // back to live over a few seconds). Opt out of both directives.
                    applyServiceDescription: false,
                    applyProducerReferenceTime: false,
                    delay: { liveDelay: 6.0, useSuggestedPresentationDelay: false },
                    liveCatchup: {
                        mode: 'liveCatchupModeDefault',
                        enabled: false,
                        maxDrift: 0,
                        playbackRate: { min: 0, max: 0 }
                    },
                    // dash.js's GapController auto-seeks FORWARD when it
                    // decides the playhead is in an unbuffered gap. For a
                    // live DVR stream, sitting at the oldest edge (-5:00)
                    // while the MPD slides makes the playhead fall *behind*
                    // the new window start; GapController then jumps the
                    // playhead forward into a region where ffmpeg may have
                    // just deleted the segments (symptom: spontaneous jump
                    // to -3:30 and a hard freeze). liveCatchup.enabled:false
                    // does NOT stop this — `gaps.*` is the setting that
                    // governs discontinuity-based seeks, not rate catchup.
                    gaps: {
                        jumpGaps: false,
                        jumpLargeGaps: false,
                        enableSeekFix: false,
                        enableStallFix: false,
                    },
                    manifestUpdateRetryInterval: 1000,
                    retryIntervals: { MPD: 1000 },
                    retryAttempts: { MPD: 2 },
                    // Force wall-clock derivation of range.start/range.end
                    // regardless of MPD shape. The backend emits
                    // `-use_timeline 1` so the MPD includes SegmentTimeline;
                    // dash.js 5.x defaults to wall-clock mode anyway, but
                    // pinning it explicit prevents a future dash.js update
                    // from silently switching to segment-timestamp-driven
                    // range calculation, which would lag ffmpeg and
                    // reintroduce live-edge jitter.
                    timeShiftBuffer: { calcFromSegmentTimeline: false },
                    abr: { limitBitrateByPortal: true },
                    // Aggressive MSE pruning. The old 20s bufferToKeep with
                    // no explicit bufferPruningInterval let dash.js accumulate
                    // stale segments behind the playhead for minutes, and
                    // on a long DVR session MSE eventually hit its quota —
                    // manifesting as "playable segments become unplayable"
                    // growing from the oldest side toward live, ending with
                    // even live frozen. A tight prune interval (~4s) and a
                    // smaller `bufferToKeep` evicts old buffer as soon as
                    // it's behind the playhead enough to be useless. Also
                    // trimmed forward buffer a bit — 15s is plenty at our
                    // 2s segment size.
                    buffer: {
                        bufferTimeAtTopQuality: 15,
                        bufferTimeAtTopQualityLongForm: 30,
                        bufferToKeep: 10,
                        bufferPruningInterval: 4,
                        fastSwitchEnabled: true,
                    }
                }
            });

            player.initialize(videoRef.current, manifestUrl, true);
            playerRef.current = player;
            onPlayerReadyRef.current?.(player);

            player.on(dashjs.MediaPlayer.events.ERROR, (e: any) => {
                if (e.error === 'capability' || e.error === 'mediasource' || e.error === 'key_session') {
                    toast.error(`Playback Error: ${e.event ? e.event.message : 'Unknown error'}`);
                } else {
                    console.error('Dash.js Error:', e);
                }
                if (e.error === 'download') {
                    if (onError) onError('Stream stopped');
                }
            });

            // No PLAYBACK_STALLED / BUFFER_EMPTY handler: those events
            // fire every time dash.js hits a brief unbuffered moment,
            // which includes the normal seek → fetch → decode round-trip.
            // Seeking the playhead to live on those events turned every
            // DVR click into "bounced back to live" and hid the
            // user-chosen position. With GapController disabled (see
            // `gaps.*: false` above) genuine stalls are rare, and the
            // honest recovery is a page refresh.

            // Watchdog: dash.js 5.1.1 has a race in StreamController._composePeriods where
            // the initial `_initializeForFirstStream` call throws because the stream's
            // adapter isn't loaded yet (`Promise.all` resolves before `stream.initialize()`
            // finishes). The uncaught rejection prevents STREAMS_COMPOSED from firing, so
            // playback never starts. If the <video> doesn't reach HAVE_FUTURE_DATA within
            // a few seconds, reset and retry — by the next attempt, dash.js internal state
            // has typically settled enough for init to succeed.
            watchdog = setTimeout(() => {
                if (disposed) return;
                const video = videoRef.current;
                // readyState ≥ 1 = HAVE_METADATA: dash.js successfully parsed
                // the manifest and handed it to the media element. If we got
                // that far, the STREAMS_COMPOSED race didn't bite us — just
                // let the buffer fill naturally instead of throwing away
                // progress with a player.reset().
                if (!video || video.readyState >= 1) return;
                if (retriesLeft <= 0) return;
                retriesLeft--;
                try { player.reset(); } catch { /* ignore */ }
                playerRef.current = null;
                createAndInit();
            }, READY_TIMEOUT_MS);
        };

        createAndInit();

        const video = videoRef.current;

        // --- DVR drift detector (leave in until you've verified the fix) --
        // Intercepts `video.currentTime` writes, logs any that weren't
        // triggered by a user seek. With the UTC-sync fix above, no more
        // entries should appear during steady-state playback. If one
        // does, the stack trace identifies the dash.js function
        // responsible and we'll need to dig further.
        try {
            const proto = HTMLMediaElement.prototype;
            const desc = Object.getOwnPropertyDescriptor(proto, 'currentTime');
            const origGet = desc?.get;
            const origSet = desc?.set;
            if (origGet && origSet) {
                Object.defineProperty(video, 'currentTime', {
                    configurable: true,
                    get() { return origGet.call(this); },
                    set(val: number) {
                        const current = origGet.call(this) as number;
                        const delta = (val as number) - current;
                        const userSeekingUntil = (video as HTMLVideoElement & { __userSeekingUntil?: number }).__userSeekingUntil ?? 0;
                        const isUserSeek = performance.now() < userSeekingUntil;
                        if (!isUserSeek && Math.abs(delta) > 0.5) {
                            console.warn(
                                `[DVR-DRIFT] AUTO seek delta=${delta.toFixed(3)}s`,
                                { from: +current.toFixed(3), to: +(val as number).toFixed(3) },
                                new Error('stack').stack,
                            );
                        }
                        origSet.call(this, val);
                    },
                });
            }
        } catch (e) {
            console.warn('[DVR-DRIFT] interceptor install failed', e);
        }
        // -------------------------------------------------------------

        video.addEventListener('loadedmetadata', handleResize);
        video.addEventListener('resize', handleResize);
        video.addEventListener('canplay', handleCanPlay);

        // Safety net: if anything (dash.js LL catchup, browser quirk, user
        // extension) nudges playbackRate away from 1.0 we force it back. The
        // listener is idempotent — setting the same value triggers one more
        // ratechange that passes the guard, so there's no loop.
        const handleRateChange = () => {
            const v = videoRef.current;
            if (v && v.playbackRate !== 1) v.playbackRate = 1;
        };
        video.addEventListener('ratechange', handleRateChange);

        return () => {
            disposed = true;
            clearWatchdog();
            if (videoRef.current) {
                videoRef.current.removeEventListener('loadedmetadata', handleResize);
                videoRef.current.removeEventListener('resize', handleResize);
                videoRef.current.removeEventListener('canplay', handleCanPlay);
                videoRef.current.removeEventListener('ratechange', handleRateChange);
            }
            if (playerRef.current) {
                try { playerRef.current.reset(); } catch (e) { console.warn('Error resetting player:', e); }
                playerRef.current = null;
            }
        };
    }, [manifestUrl]);

    return (
        <video
            ref={videoRef}
            disablePictureInPicture
            className="w-full h-full bg-black"
            style={{ objectFit: 'contain', maxWidth: '100%', maxHeight: '100%' }}
        />
    );
});

VideoPlayer.displayName = 'VideoPlayer';
