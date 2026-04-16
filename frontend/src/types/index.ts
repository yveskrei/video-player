export type StreamStatus = 'stopped' | 'initializing' | 'streaming' | 'terminating';

export interface VideoInfo {
    id: number;
    name: string;
    file_path: string;
    created_at: string;
    width: number;
    height: number;
    fps: number;
    stream_status: StreamStatus;
    stream_start_time_ms: number | null;
    dash_manifest_url: string | null;
    prog_url: string | null;
    prog_init_url: string | null;
}

export interface BBox {
    top_left_corner: number;
    bottom_right_corner: number;
    class_name: string;
    confidence: number;
}

export interface BBoxMessage {
    type: 'bbox_update';
    video_id: number;
    pts: number;
    bboxes: BBox[];
    stream_start_time_ms?: number;
    timestamp?: number;
}

export interface VideoUpdateMessage {
    type: 'video_update';
    reason: 'created' | 'deleted' | 'stream_initializing' | 'stream_started' | 'stream_stopped' | 'stream_error';
    video?: VideoInfo & { id: number };
}
