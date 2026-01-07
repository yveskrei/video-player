# Video Player Frontend

Modern React-based video streaming application with real-time bounding box overlay.

## Tech Stack

- **React** with TypeScript
- **Vite** for fast development and building
- **Tailwind CSS** for styling
- **dash.js** for DASH video playback
- **WebSocket** for real-time bbox updates

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` and set your backend URL:

```env
VITE_BACKEND_URL=http://localhost:8702
```

### 3. Run Development Server

```bash
npm run dev
```

The app will be available at `http://localhost:5173`

### 4. Build for Production

```bash
npm run build
```

The built files will be in the `dist/` directory.

## Configuration

### Environment Variables

- `VITE_BACKEND_URL`: Backend API URL (default: `http://localhost:8702`)

## Features

- **Live DASH Streaming**: Adaptive bitrate video streaming
- **Real-time BBox Overlay**: WebSocket-based bounding box display synchronized with video PTS
- **Frame-based Retention**: Configurable bbox persistence
- **Stream Management**: Start, stop, and monitor video streams