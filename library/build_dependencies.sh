#!/usr/bin/env bash
#
# Phase 2 (OFFLINE): compile a static, decoder-only FFmpeg for the client_video
# crate. Strictly offline — it expects the source tree under dependencies_src/
# (or the dependencies_src.tar.gz archive from download_dependencies.sh, which it
# extracts).
#
# LGPL-clean: decode + demux only (h264/hevc decoders, the mov demuxer, swscale).
# No encoder, no muxer, no network/protocols — the library owns HTTP itself and
# feeds bytes to libavformat over a custom AVIO. No x264, so no --enable-gpl.
#
# Everything is static PIC with no external transitive deps beyond
# libc/libstdc++/libm/libz/libpthread/libdl from the host.
#
# Toolchain assumed pre-installed (NOT fetched here): gcc/clang, make, nasm
# (FFmpeg x86 asm), pkg-config, perl.
#
# Output: dependencies.tar.gz (the only artifact — the extracted source and
# build trees are removed at the end).

set -euo pipefail

NPROC=$(nproc)
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$PROJECT_ROOT/dependencies_src"
SRC_ARCHIVE="$PROJECT_ROOT/dependencies_src.tar.gz"

FFMPEG_SRC="$SRC_DIR/ffmpeg"

DEPS_DIR="$PROJECT_ROOT/dependencies"
FFMPEG_DIR="$DEPS_DIR/ffmpeg"

# --- nasm sanity check: FFmpeg x86 asm won't build without it ------------------
if ! command -v nasm >/dev/null 2>&1; then
  echo "❌ nasm not found — required to build FFmpeg x86 assembly." >&2
  echo "   Install it (e.g. dnf install -y nasm) and re-run." >&2
  exit 1
fi

# --- Extract the source archive into dependencies_src/ if the tree isn't present
if [ ! -d "$FFMPEG_SRC" ]; then
  if [ -f "$SRC_ARCHIVE" ]; then
    echo "Extracting $(basename "$SRC_ARCHIVE")..."
    tar -xzf "$SRC_ARCHIVE" -C "$PROJECT_ROOT"
  else
    echo "❌ Sources not found at $SRC_DIR and no $(basename "$SRC_ARCHIVE")." >&2
    echo "   Run ./download_dependencies.sh first (needs network)." >&2
    exit 1
  fi
fi

# The compiled install tree goes into a separate dependencies/ folder; wipe any
# previous build so the output is reproducible.
rm -rf "$DEPS_DIR"
mkdir -p "$FFMPEG_DIR"

# -----------------------------------------------------------------------------
# FFmpeg — static, decode + demux only (LGPL).
# -----------------------------------------------------------------------------
echo "Configuring FFmpeg (static, decode-only, LGPL)..."
cd "$FFMPEG_SRC"
make distclean >/dev/null 2>&1 || true

./configure \
  --prefix="$FFMPEG_DIR" \
  --pkg-config-flags="--static" \
  --extra-cflags="-fPIC -O3" \
  --extra-cxxflags="-fPIC -O3" \
  --extra-libs="-lpthread -lm" \
  --disable-shared \
  --enable-static \
  --enable-pic \
  --disable-doc \
  --disable-programs \
  --disable-debug \
  --disable-autodetect \
  --disable-network \
  --disable-everything \
  --enable-decoder=h264 \
  --enable-decoder=hevc \
  --enable-parser=h264 \
  --enable-parser=hevc \
  --enable-demuxer=mov \
  --enable-swscale \
  --enable-swresample \
  --enable-avformat \
  --enable-avcodec \
  --enable-avutil

echo "Building FFmpeg..."
make -j"$NPROC"
make install

# -----------------------------------------------------------------------------
# Package the portable prebuilt install for build_library.sh.
# -----------------------------------------------------------------------------
echo "Compressing dependencies tarball..."
cd "$PROJECT_ROOT"
tar -czf dependencies.tar.gz \
  dependencies/ffmpeg/include dependencies/ffmpeg/lib dependencies/ffmpeg/share

# Only the tarball is kept; drop the extracted source + build trees.
echo "Cleaning up source and build trees..."
rm -rf "$SRC_DIR" "$DEPS_DIR"

echo "✅ Static decoder-only FFmpeg packaged into dependencies.tar.gz"
echo "   Next (offline): B2B_URL=http://127.0.0.1:8702 ./build_library.sh"
