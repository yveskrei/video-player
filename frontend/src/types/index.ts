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
    // Progressive fMP4 URLs are backend-advertised and shown in the Management
    // stream-info modal for visibility. The frontend player does NOT consume
    // them — DASH is the only playback path. Don't wire these into anything.
    prog_url: string | null;
    prog_init_url: string | null;
    dvr_window_seconds?: number | null;
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

export interface BBoxGroup {
    pts: number;
    bboxes: BBox[];
}

export interface BBoxHistoryResponse {
    video_id: number;
    stream_start_time_ms: number | null;
    groups: BBoxGroup[];
}

export interface ClipSelection {
    startPts: number;
    endPts: number;
}
