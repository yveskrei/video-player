"""The single global /ws endpoint: connection registry, per-video subscriptions, fan-out."""
from fastapi import WebSocket
from typing import Dict, Set
import json
import asyncio

# Custom modules
from utils.enums import WebSocketEventType, VideoUpdateReason

# Variables
# Captured at startup so sync threads (the ffmpeg monitors) can reach the loop.
_event_loop: asyncio.AbstractEventLoop = None

def set_event_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _event_loop
    _event_loop = loop

def broadcast_sync(coro) -> None:
    """Schedule a coroutine from a synchronous thread. Fire-and-forget."""
    if _event_loop and not _event_loop.is_closed():
        asyncio.run_coroutine_threadsafe(coro, _event_loop)

class ConnectionManager:
    """Video updates go to every connection; bbox updates only to that video's subscribers."""

    def __init__(self):
        self.connections: Set[WebSocket] = set()
        self.video_subscriptions: Dict[int, Set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self.connections.add(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self.connections.discard(websocket)
            for video_id in list(self.video_subscriptions.keys()):
                self.video_subscriptions[video_id].discard(websocket)
                if not self.video_subscriptions[video_id]:
                    del self.video_subscriptions[video_id]

    async def subscribe(self, websocket: WebSocket, video_id: int) -> None:
        async with self._lock:
            if video_id not in self.video_subscriptions:
                self.video_subscriptions[video_id] = set()
            self.video_subscriptions[video_id].add(websocket)

    async def unsubscribe(self, websocket: WebSocket, video_id: int) -> None:
        async with self._lock:
            if video_id in self.video_subscriptions:
                self.video_subscriptions[video_id].discard(websocket)
                if not self.video_subscriptions[video_id]:
                    del self.video_subscriptions[video_id]

    async def _send_to_connections(self, connections: Set[WebSocket], message: dict) -> None:
        """Serialize once, send sequentially, then purge whatever failed."""
        if not connections:
            return
        message_json = json.dumps(message)
        dead: Set[WebSocket] = set()
        for ws in connections:
            try:
                await ws.send_text(message_json)
            except Exception:
                dead.add(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self.connections.discard(ws)
                    for subs in self.video_subscriptions.values():
                        subs.discard(ws)
                empty = [vid for vid, subs in self.video_subscriptions.items() if not subs]
                for vid in empty:
                    del self.video_subscriptions[vid]

    async def broadcast_video_update(
        self,
        video_id: int,
        reason: VideoUpdateReason,
        video_data: dict,
    ) -> None:
        message = {
            "type": WebSocketEventType.VIDEO_UPDATE,
            "reason": reason,
            "video": video_data,
        }
        async with self._lock:
            connections = self.connections.copy()
        await self._send_to_connections(connections, message)

    async def broadcast_bbox(self, video_id: int, data: dict) -> None:
        async with self._lock:
            subscribers = self.video_subscriptions.get(video_id, set()).copy()
        await self._send_to_connections(subscribers, data)

manager = ConnectionManager()
