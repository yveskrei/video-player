import { apiClient } from './client';
import type { VideoInfo, BBoxHistoryResponse } from '../types';

export const listVideos = async (): Promise<VideoInfo[]> => {
    const response = await apiClient.get<VideoInfo[]>('/videos/');
    return response.data;
};

export const uploadVideo = async (
    file: File,
    name: string,
    onProgress?: (fraction: number) => void,
): Promise<void> => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('name', name);
    // The explicit `multipart/form-data` overrides the axios instance's
    // default `application/json` — axios detects a FormData body and
    // rewrites it to `multipart/form-data; boundary=...`.
    await apiClient.post('/videos/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (e) => {
            if (!onProgress) return;
            const total = e.total ?? file.size;
            if (total > 0) onProgress(Math.min(1, e.loaded / total));
        },
    });
};

export const deleteVideo = async (videoId: number): Promise<void> => {
    await apiClient.delete(`/videos/${videoId}`);
};

export const startStream = async (videoId: number): Promise<void> => {
    await apiClient.post('/streams/start', { video_id: videoId });
};

export const stopStream = async (videoId: number): Promise<void> => {
    await apiClient.post(`/streams/stop/${videoId}`);
};

export const listBboxes = async (videoId: number): Promise<BBoxHistoryResponse> => {
    const response = await apiClient.get<BBoxHistoryResponse>(`/bboxes/${videoId}`);
    return response.data;
};
