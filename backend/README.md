# Video Player Backend

This is the backend service for the Video Player application. It handles video streaming and analytics data management.

## Features

- **Video Streaming**: Supports streaming via both DASH (Dynamic Adaptive Streaming over HTTP) and TCP protocols.
- **AI Analytics**: Provides endpoints to receive and process AI analytics data associated with video streams.

## Configuration

This project uses `uv` for dependency management. To install dependencies, run:

```bash
uv sync
```

## Starting the Server

To start the backend server in development mode with hot-reloading, run:

```bash
uv run uvicorn main:app --reload --host 0.0.0.0 --port 8702
```
