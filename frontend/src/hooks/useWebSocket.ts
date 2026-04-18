import { useEffect, useRef, useState, useCallback } from 'react';
import { getBackendUrl } from '../api/client';
import type { BBoxMessage, VideoUpdateMessage } from '../types';

interface UseWebSocketOptions {
    onVideoUpdate?: (msg: VideoUpdateMessage) => void;
}

export const useWebSocket = (options: UseWebSocketOptions = {}) => {
    const [isConnected, setIsConnected] = useState(false);
    const wsRef = useRef<WebSocket | null>(null);
    const bboxBufferRef = useRef<BBoxMessage[]>([]);
    const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mountedRef = useRef(true);
    const onVideoUpdateRef = useRef(options.onVideoUpdate);
    // Desired subscriptions — kept independent of socket readiness so a
    // subscribe() call made before the WS is open (or during a reconnect)
    // isn't silently lost. Re-sent on every (re)open.
    const subscribedIdsRef = useRef<Set<number>>(new Set());

    useEffect(() => {
        onVideoUpdateRef.current = options.onVideoUpdate;
    }, [options.onVideoUpdate]);

    const connect = useCallback(() => {
        if (!mountedRef.current) return;

        const backendUrl = getBackendUrl();
        const wsUrl = backendUrl.replace(/^http/, 'ws').replace(/^https/, 'wss') + '/ws';

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
            if (!mountedRef.current) return;
            setIsConnected(true);
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
                reconnectTimeoutRef.current = null;
            }
            // Replay any subscriptions requested while the socket was
            // still connecting or after a reconnect.
            for (const id of subscribedIdsRef.current) {
                ws.send(JSON.stringify({ type: 'subscribe_video', video_id: id }));
            }
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                if (data.type === 'bbox_update') {
                    bboxBufferRef.current.push(data as BBoxMessage);
                    if (bboxBufferRef.current.length > 500) {
                        bboxBufferRef.current.shift();
                    }
                } else if (data.type === 'video_update') {
                    onVideoUpdateRef.current?.(data as VideoUpdateMessage);
                }
                // pong handled implicitly
            } catch (e) {
                console.error('Failed to parse WebSocket message', e);
            }
        };

        ws.onerror = () => {
            setIsConnected(false);
        };

        ws.onclose = () => {
            if (!mountedRef.current) return;
            setIsConnected(false);
            reconnectTimeoutRef.current = setTimeout(() => {
                if (mountedRef.current) connect();
            }, 2000);
        };
    }, []);

    const subscribe = useCallback((videoId: number) => {
        subscribedIdsRef.current.add(videoId);
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'subscribe_video', video_id: videoId }));
        }
    }, []);

    const unsubscribe = useCallback((videoId: number) => {
        subscribedIdsRef.current.delete(videoId);
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'unsubscribe_video', video_id: videoId }));
        }
        bboxBufferRef.current = [];
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        connect();
        return () => {
            mountedRef.current = false;
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
            }
            if (wsRef.current) {
                wsRef.current.onclose = null;
                wsRef.current.close();
                wsRef.current = null;
            }
        };
    }, [connect]);

    return {
        isConnected,
        bboxBuffer: bboxBufferRef,
        subscribe,
        unsubscribe,
    };
};
