from enum import Enum


class StreamStatus(str, Enum):
    STOPPED = "stopped"
    INITIALIZING = "initializing"
    STREAMING = "streaming"
    TERMINATING = "terminating"


class WebSocketEventType(str, Enum):
    # Server → Client (all connections)
    VIDEO_UPDATE = "video_update"
    # Server → Client (video subscribers only)
    BBOX_UPDATE = "bbox_update"
    # Client → Server
    SUBSCRIBE_VIDEO = "subscribe_video"
    UNSUBSCRIBE_VIDEO = "unsubscribe_video"
    PING = "ping"
    PONG = "pong"


class VideoUpdateReason(str, Enum):
    CREATED = "created"
    DELETED = "deleted"
    STREAM_INITIALIZING = "stream_initializing"
    STREAM_STARTED = "stream_started"
    STREAM_STOPPED = "stream_stopped"
    STREAM_ERROR = "stream_error"
