import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { listVideos, uploadVideo, deleteVideo, startStream, stopStream } from '../api/streams';
import type { VideoInfo, StreamStatus, VideoUpdateMessage } from '../types';
import { Play, Square, Trash2, Info, Upload, RefreshCw, Film, Activity, Tv } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { Modal } from '../components/Modal';
import { useWebSocket } from '../hooks/useWebSocket';
import { getBackendUrl } from '../api/client';

const StatusBadge: React.FC<{ status: StreamStatus }> = ({ status }) => {
    if (status === 'streaming') {
        return (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border bg-green-500/10 text-green-400 border-green-500/20">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 mr-1.5 animate-pulse" />
                Streaming
            </span>
        );
    }
    if (status === 'initializing') {
        return (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border bg-orange-500/10 text-orange-400 border-orange-500/20">
                <span className="w-1.5 h-1.5 rounded-full bg-orange-400 mr-1.5" />
                Initializing
            </span>
        );
    }
    if (status === 'terminating') {
        return (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border bg-orange-500/10 text-orange-400 border-orange-500/20">
                <span className="w-1.5 h-1.5 rounded-full bg-orange-400 mr-1.5" />
                Terminating
            </span>
        );
    }
    return (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border bg-zinc-800 text-zinc-400 border-zinc-700">
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 mr-1.5" />
            Stopped
        </span>
    );
};

export const Management: React.FC = () => {
    const [videos, setVideos] = useState<VideoInfo[]>([]);
    const [loading, setLoading] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);

    const [uploadModalOpen, setUploadModalOpen] = useState(false);
    const [deleteModalOpen, setDeleteModalOpen] = useState(false);
    const [infoModalOpen, setInfoModalOpen] = useState(false);

    const [selectedVideo, setSelectedVideo] = useState<VideoInfo | null>(null);
    const [uploadFile, setUploadFile] = useState<File | null>(null);
    const [uploadName, setUploadName] = useState('');

    const navigate = useNavigate();

    const handleVideoUpdate = useCallback((msg: VideoUpdateMessage) => {
        const videoId = msg.video?.id;
        if (videoId === undefined) return;

        if (msg.reason === 'deleted') {
            setVideos(prev => prev.filter(v => v.id !== videoId));
            setSelectedVideo(prev => (prev?.id === videoId ? null : prev));
        } else if (msg.video) {
            setVideos(prev => {
                const exists = prev.some(v => v.id === videoId);
                if (exists) {
                    return prev.map(v => v.id === videoId ? msg.video! : v);
                }
                return [...prev, msg.video!];
            });
            setSelectedVideo(prev => (prev?.id === videoId ? msg.video! : prev));
        }
    }, []);

    useWebSocket({ onVideoUpdate: handleVideoUpdate });

    const fetchVideos = useCallback(async () => {
        try {
            setLoading(true);
            const data = await listVideos();
            setVideos(Array.isArray(data) ? data : []);
        } catch (error) {
            console.error('Failed to fetch videos', error);
            toast.error('Failed to fetch videos');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchVideos();
    }, [fetchVideos]);

    // --- Upload Handlers ---
    const openUploadModal = () => {
        setUploadFile(null);
        setUploadName('');
        setUploadModalOpen(true);
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            const file = e.target.files[0];
            setUploadFile(file);
            if (!uploadName) {
                setUploadName(file.name.split('.')[0]);
            }
        }
    };

    const handleUploadSubmit = async () => {
        if (!uploadFile) return;
        try {
            setUploading(true);
            setUploadProgress(0);
            await uploadVideo(uploadFile, uploadName || uploadFile.name, setUploadProgress);
            toast.success('Video uploaded successfully');
            setUploadModalOpen(false);
        } catch (error) {
            console.error('Upload failed', error);
            toast.error('Failed to upload video');
        } finally {
            setUploading(false);
            setUploadProgress(0);
        }
    };

    // --- Delete Handlers ---
    const confirmDelete = (video: VideoInfo) => {
        setSelectedVideo(video);
        setDeleteModalOpen(true);
    };

    const handleDeleteSubmit = async () => {
        if (!selectedVideo) return;
        try {
            await deleteVideo(selectedVideo.id);
            toast.success(`Deleted video: ${selectedVideo.name}`);
            setDeleteModalOpen(false);
        } catch (error) {
            console.error('Delete failed', error);
            toast.error('Failed to delete video');
        }
    };

    // --- Stream Handlers ---
    const handleStartStream = async (id: number) => {
        try {
            await startStream(id);
        } catch (error) {
            console.error('Start stream failed', error);
            toast.error('Failed to start stream');
        }
    };

    const handleStopStream = async (id: number) => {
        try {
            await stopStream(id);
        } catch (error) {
            console.error('Stop stream failed', error);
            toast.error('Failed to stop stream');
        }
    };

    const handleInfo = (video: VideoInfo) => {
        setSelectedVideo(video);
        setInfoModalOpen(true);
    };

    const activeCount = videos.filter(v => v.stream_status === 'streaming').length;
    const baseUrl = getBackendUrl();

    return (
        <div className="space-y-8">
            {/* Header Section */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div>
                    <h2 className="text-2xl font-bold text-white">Video Management</h2>
                    <p className="text-zinc-400 mt-1">Manage your video library and active streams.</p>
                </div>
                <div className="flex space-x-3">
                    <button onClick={openUploadModal} className="btn btn-primary">
                        <Upload className="w-4 h-4 mr-2" />
                        Upload Video
                    </button>
                    <button onClick={fetchVideos} className="btn btn-secondary">
                        <RefreshCw className={clsx("w-4 h-4 mr-2", loading && "animate-spin")} />
                        Refresh
                    </button>
                </div>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="card p-4 flex items-center space-x-4">
                    <div className="p-3 bg-blue-500/10 rounded-lg">
                        <Film className="w-6 h-6 text-blue-500" />
                    </div>
                    <div>
                        <p className="text-sm text-zinc-400">Total Videos</p>
                        <p className="text-2xl font-bold text-white">{videos.length}</p>
                    </div>
                </div>
                <div className="card p-4 flex items-center space-x-4">
                    <div className="p-3 bg-green-500/10 rounded-lg">
                        <Activity className="w-6 h-6 text-green-500" />
                    </div>
                    <div>
                        <p className="text-sm text-zinc-400">Active Streams</p>
                        <p className="text-2xl font-bold text-white">{activeCount}</p>
                    </div>
                </div>
            </div>

            {/* Video Table */}
            <div className="card overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead className="bg-zinc-900/50 border-b border-border">
                            <tr>
                                <th className="px-6 py-4 text-xs font-semibold text-zinc-400 uppercase tracking-wider">ID</th>
                                <th className="px-6 py-4 text-xs font-semibold text-zinc-400 uppercase tracking-wider">Name</th>
                                <th className="px-6 py-4 text-xs font-semibold text-zinc-400 uppercase tracking-wider">Status</th>
                                <th className="px-6 py-4 text-xs font-semibold text-zinc-400 uppercase tracking-wider text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {videos.length === 0 ? (
                                <tr>
                                    <td colSpan={4} className="px-6 py-12 text-center text-zinc-500">
                                        <div className="flex flex-col items-center justify-center">
                                            <Film className="w-12 h-12 mb-4 opacity-20" />
                                            <p>No videos found. Upload one to get started.</p>
                                        </div>
                                    </td>
                                </tr>
                            ) : (
                                videos.map((video) => {
                                    const isStopped = video.stream_status === 'stopped';
                                    const isStreaming = video.stream_status === 'streaming';
                                    const isTransitioning = video.stream_status === 'initializing' || video.stream_status === 'terminating';

                                    return (
                                        <tr key={video.id} className="group hover:bg-zinc-800/30 transition-colors">
                                            <td className="px-6 py-4 font-mono text-sm text-zinc-500">#{video.id}</td>
                                            <td className="px-6 py-4">
                                                <span className="font-medium text-zinc-200">{video.name}</span>
                                            </td>
                                            <td className="px-6 py-4">
                                                <StatusBadge status={video.stream_status} />
                                            </td>
                                            <td className="px-6 py-4 text-right">
                                                <div className="flex justify-end items-center space-x-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    {isStreaming && (
                                                        <button
                                                            onClick={() => navigate(`/viewer?stream_id=${video.id}`)}
                                                            className="p-2 text-violet-400 hover:bg-violet-400/10 rounded-lg transition-colors"
                                                            title="Watch Stream"
                                                        >
                                                            <Tv className="w-4 h-4" />
                                                        </button>
                                                    )}

                                                    {isStopped ? (
                                                        <button
                                                            onClick={() => handleStartStream(video.id)}
                                                            className="p-2 text-green-400 hover:bg-green-400/10 rounded-lg transition-colors"
                                                            title="Start Stream"
                                                        >
                                                            <Play className="w-4 h-4" />
                                                        </button>
                                                    ) : (
                                                        <button
                                                            onClick={() => handleStopStream(video.id)}
                                                            disabled={isTransitioning}
                                                            className="p-2 text-orange-400 hover:bg-orange-400/10 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                                            title="Stop Stream"
                                                        >
                                                            <Square className="w-4 h-4" />
                                                        </button>
                                                    )}

                                                    <button
                                                        onClick={() => handleInfo(video)}
                                                        disabled={!isStreaming}
                                                        className="p-2 text-blue-400 hover:bg-blue-400/10 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                                        title="Stream Info"
                                                    >
                                                        <Info className="w-4 h-4" />
                                                    </button>

                                                    <button
                                                        onClick={() => confirmDelete(video)}
                                                        disabled={!isStopped}
                                                        className="p-2 text-red-400 hover:bg-red-400/10 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                                        title="Delete"
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* --- Modals --- */}

            {/* Upload Modal */}
            <Modal
                isOpen={uploadModalOpen}
                onClose={() => setUploadModalOpen(false)}
                title="Upload Video"
                footer={
                    <>
                        <button onClick={() => setUploadModalOpen(false)} className="btn btn-ghost">Cancel</button>
                        <button
                            onClick={handleUploadSubmit}
                            disabled={!uploadFile || uploading}
                            className="btn btn-primary"
                        >
                            {uploading
                                ? uploadProgress >= 1
                                    ? 'Processing…'
                                    : `Uploading ${Math.round(uploadProgress * 100)}%`
                                : 'Upload'}
                        </button>
                    </>
                }
            >
                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-zinc-400 mb-1">Video File</label>
                        <input
                            type="file"
                            accept="video/*"
                            onChange={handleFileSelect}
                            className="block w-full text-sm text-zinc-400
                file:mr-4 file:py-2 file:px-4
                file:rounded-lg file:border-0
                file:text-sm file:font-semibold
                file:bg-primary/10 file:text-primary
                hover:file:bg-primary/20
                cursor-pointer"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-zinc-400 mb-1">Name</label>
                        <input
                            type="text"
                            value={uploadName}
                            onChange={(e) => setUploadName(e.target.value)}
                            placeholder="Enter video name"
                            className="input w-full"
                        />
                    </div>
                    {uploading && (
                        <div>
                            <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                                <div
                                    className="h-full bg-primary transition-[width] duration-100"
                                    style={{ width: `${Math.round(uploadProgress * 100)}%` }}
                                />
                            </div>
                            <p className="mt-2 text-xs text-zinc-500">
                                {uploadProgress >= 1
                                    ? 'Upload complete — analyzing video on server…'
                                    : `${Math.round(uploadProgress * 100)}% uploaded`}
                            </p>
                        </div>
                    )}
                </div>
            </Modal>

            {/* Delete Modal */}
            <Modal
                isOpen={deleteModalOpen}
                onClose={() => setDeleteModalOpen(false)}
                title="Delete Video"
                footer={
                    <>
                        <button onClick={() => setDeleteModalOpen(false)} className="btn btn-ghost">Cancel</button>
                        <button onClick={handleDeleteSubmit} className="btn btn-danger">Delete</button>
                    </>
                }
            >
                <p className="text-zinc-300">
                    Are you sure you want to delete <span className="font-bold text-white">{selectedVideo?.name}</span>?
                    This action cannot be undone.
                </p>
            </Modal>

            {/* Info Modal */}
            <Modal
                isOpen={infoModalOpen}
                onClose={() => setInfoModalOpen(false)}
                title="Stream Information"
                footer={
                    <button onClick={() => setInfoModalOpen(false)} className="btn btn-secondary">Close</button>
                }
            >
                {selectedVideo && (
                    <div className="space-y-4 text-sm">
                        <div className="grid grid-cols-3 gap-y-3 gap-x-2">
                            <span className="text-zinc-500">Video ID:</span>
                            <span className="col-span-2 font-mono text-white">#{selectedVideo.id}</span>

                            <span className="text-zinc-500">Name:</span>
                            <span className="col-span-2 text-white">{selectedVideo.name}</span>

                            <span className="text-zinc-500">Resolution:</span>
                            <span className="col-span-2 font-mono text-white">{selectedVideo.width}×{selectedVideo.height} @ {selectedVideo.fps.toFixed(2)} fps</span>

                            <span className="text-zinc-500">Status:</span>
                            <span className="col-span-2"><StatusBadge status={selectedVideo.stream_status} /></span>

                            {selectedVideo.stream_start_time_ms && (
                                <>
                                    <span className="text-zinc-500">Started:</span>
                                    <span className="col-span-2 text-white">
                                        {new Date(selectedVideo.stream_start_time_ms).toLocaleString()}
                                    </span>
                                </>
                            )}
                        </div>

                        <div className="bg-zinc-950 p-4 rounded-lg border border-border space-y-3">
                            <div>
                                <p className="text-xs uppercase tracking-wider text-zinc-500 font-semibold mb-1">DASH Manifest</p>
                                <p className="font-mono text-xs text-blue-400 break-all select-all bg-zinc-900/50 p-2 rounded">
                                    {selectedVideo.dash_manifest_url
                                        ? `${baseUrl}${selectedVideo.dash_manifest_url}`
                                        : 'N/A'}
                                </p>
                            </div>
                            <div>
                                <p className="text-xs uppercase tracking-wider text-zinc-500 font-semibold mb-1">Progressive Init</p>
                                <p className="font-mono text-xs text-blue-400 break-all select-all bg-zinc-900/50 p-2 rounded">
                                    {selectedVideo.prog_init_url
                                        ? `${baseUrl}${selectedVideo.prog_init_url}`
                                        : 'N/A'}
                                </p>
                            </div>
                            <div>
                                <p className="text-xs uppercase tracking-wider text-zinc-500 font-semibold mb-1">Progressive Stream</p>
                                <p className="font-mono text-xs text-blue-400 break-all select-all bg-zinc-900/50 p-2 rounded">
                                    {selectedVideo.prog_url
                                        ? `${baseUrl}${selectedVideo.prog_url}`
                                        : 'N/A'}
                                </p>
                            </div>
                        </div>
                    </div>
                )}
            </Modal>
        </div>
    );
};
