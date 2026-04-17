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
        const READY_TIMEOUT_MS = 4000;

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
                    // UTC sync is required so dash.js exposes the full DVR window as seekable;
                    // without it, video.seekable stays pinned to the buffered region (~6s at live),
                    // which silently clamps any past-seek back to the live edge.
                    // `direct:2014` uses the client's own wall clock so the timing source
                    // resolves synchronously — no third-party fetch to time.akamai.com.
                    utcSynchronization: {
                        enabled: true,
                        defaultTimingSource: {
                            scheme: 'urn:mpeg:dash:utc:direct:2014',
                            value: new Date().toISOString(),
                        },
                    },
                    delay: { liveDelay: 6.0 },
                    liveCatchup: {
                        mode: 'liveCatchupModeDefault',
                        enabled: false,
                        maxDrift: 0,
                        playbackRate: { min: 0, max: 0 }
                    },
                    manifestUpdateRetryInterval: 1000,
                    retryIntervals: { MPD: 1000 },
                    retryAttempts: { MPD: 2 },
                    abr: { limitBitrateByPortal: true },
                    buffer: {
                        bufferTimeAtTopQuality: 30,
                        bufferTimeAtTopQualityLongForm: 60,
                        bufferToKeep: 20,
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
                if (!video || video.readyState >= 3) return;
                if (retriesLeft <= 0) return;
                retriesLeft--;
                try { player.reset(); } catch { /* ignore */ }
                playerRef.current = null;
                createAndInit();
            }, READY_TIMEOUT_MS);
        };

        createAndInit();

        const video = videoRef.current;
        video.addEventListener('loadedmetadata', handleResize);
        video.addEventListener('resize', handleResize);
        video.addEventListener('canplay', handleCanPlay);

        return () => {
            disposed = true;
            clearWatchdog();
            if (videoRef.current) {
                videoRef.current.removeEventListener('loadedmetadata', handleResize);
                videoRef.current.removeEventListener('resize', handleResize);
                videoRef.current.removeEventListener('canplay', handleCanPlay);
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
