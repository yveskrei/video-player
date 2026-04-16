import { apiClient } from './client';
import type { VideoInfo, BBoxHistoryResponse } from '../types';

export const listVideos = async (): Promise<VideoInfo[]> => {
    const response = await apiClient.get<VideoInfo[]>('/videos/');
    return response.data;
};

export const uploadVideo = async (file: File, name: string): Promise<void> => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('name', name);
    await apiClient.post('/videos/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
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
