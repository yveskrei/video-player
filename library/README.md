# Video Client Library

Native client library for consuming real-time video streams from the Video Player backend and pushing AI analytics back with low latency.

Built in **Rust** and distributed as a C dynamic library (`libclient_video.so`) for easy integration into third-party desktop / mobile applications. The library connects over HTTP to the backend's **progressive fMP4** endpoint, decodes H.264 / HEVC frames using a statically-linked FFmpeg, and delivers raw RGB frames and stream metadata to the host application via C callbacks. AI results (bounding boxes, etc.) are POSTed back to the backend per source.

## What It Does

- **Multi-source streaming** — Manages any number of concurrent video sources; each source runs on its own async task with automatic reconnect on network failure.
- **C callback surface** — Register callbacks for frame delivery, stream metadata, status transitions, and POST results; initialise or stop multiple sources in a single call; push analytics JSON per source.
- **Non-blocking analytics pipeline** — FFI callers enqueue JSON into a bounded ring buffer that a background task drains and POSTs asynchronously, so slow networks can't block the caller thread. Oldest entries are dropped if the queue overflows.
- **Self-contained decoding** — Decoder-only FFmpeg is built statically into the shared library; no external codec dependencies are required at runtime.

## Building the Library

Install the toolchain required to build FFmpeg from source:

```bash
# Install dependencies on Fedora-based systems
dnf install -y \
  perl-FindBin \
  clang \
  clang-devel \
  llvm-devel \
  gcc \
  gcc-c++ \
  make \
  cmake \
  git \
  autoconf \
  automake \
  libtool \
  pkgconfig \
  perl \
  python3 \
  diffutils \
  gettext \
  wget
```

The build is split into three phases so the last two can run **completely offline**:

```bash
# 1. Download FFmpeg source (requires internet) → produces dependencies_src.tar.gz
./download_dependencies.sh

# 2. Build a minimal decoder-only static FFmpeg from the downloaded source (offline)
#    → produces dependencies.tar.gz
./build_dependencies.sh

# 3. Build the final libclient_video.so against the pre-built FFmpeg (offline)
./build_library.sh
```

Phases 1 and 2 only need to be re-run when the pinned FFmpeg version changes — the resulting `dependencies.tar.gz` is portable and can be copied to other machines to skip straight to phase 3.
