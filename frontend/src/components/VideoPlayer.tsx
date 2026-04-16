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

        const player = dashjs.MediaPlayer().create();

        player.updateSettings({
            streaming: {
                // UTC sync is required so dash.js exposes the full DVR window as seekable;
                // without it, video.seekable stays pinned to the buffered region (~6s at live),
                // which silently clamps any past-seek back to the live edge.
                utcSynchronization: { enabled: true },
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

        const handleResize = () => {
            if (videoRef.current) {
                onResolutionChange(videoRef.current.videoWidth, videoRef.current.videoHeight);
            }
        };

        videoRef.current.addEventListener('loadedmetadata', handleResize);
        videoRef.current.addEventListener('resize', handleResize);

        return () => {
            if (videoRef.current) {
                videoRef.current.removeEventListener('loadedmetadata', handleResize);
                videoRef.current.removeEventListener('resize', handleResize);
            }

            if (playerRef.current) {
                try {
                    playerRef.current.reset();
                } catch (e) {
                    console.warn('Error resetting player:', e);
                }
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
