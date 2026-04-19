#!/usr/bin/env bash
#
# Builds a minimal, decoder-only FFmpeg statically for the ffi_library crate.
#
# This script is strictly offline — it expects the FFmpeg source tree to
# already be present under dependencies/ffmpeg/src. Run download_dependencies.sh
# first (on a machine with network access) to populate it.
#
# The FFI library only needs to *decode* H.264/HEVC out of fragmented MP4, so
# every encoder (x264/x265/libvpx/libmp3lame/libopus), every audio path,
# libsrt + OpenSSL, and the libxcb/libXau/libXdmcp stack is dropped.
#
# The result is a single FFmpeg install tree at dependencies/ffmpeg/ with
# libavformat/avcodec/avutil/swscale built as static PIC libraries — no
# external transitive deps beyond libc/libstdc++.

set -euo pipefail

NPROC=$(nproc)
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
DEPS_DIR="$PROJECT_ROOT/dependencies"
FFMPEG_DIR="$DEPS_DIR/ffmpeg"
FFMPEG_SRC="$FFMPEG_DIR/src"

if [ ! -d "$FFMPEG_SRC" ]; then
  echo "❌ FFmpeg source not found at $FFMPEG_SRC" >&2
  echo "   Run ./download_dependencies.sh first." >&2
  exit 1
fi

# Clean previous install artifacts but keep the downloaded source tree.
for sub in include lib share bin; do
  rm -rf "$FFMPEG_DIR/$sub"
done

echo "Configuring FFmpeg (decoder-only)..."
cd "$FFMPEG_SRC"

# Reset any stale build state from a previous run; ignore if never configured.
make distclean >/dev/null 2>&1 || true

./configure \
  --prefix="$FFMPEG_DIR" \
  --disable-shared \
  --enable-static \
  --enable-pic \
  --disable-doc \
  --disable-programs \
  --disable-debug \
  --disable-network \
  --disable-everything \
  --disable-autodetect \
  --enable-avformat \
  --enable-avcodec \
  --enable-avutil \
  --enable-swscale \
  --enable-swresample \
  --enable-avfilter \
  --enable-decoder=h264 \
  --enable-decoder=hevc \
  --enable-parser=h264 \
  --enable-parser=hevc \
  --enable-demuxer=mov \
  --enable-demuxer=matroska \
  --enable-demuxer=m4v \
  --enable-protocol=file \
  --enable-protocol=pipe \
  --enable-bsf=h264_mp4toannexb \
  --enable-bsf=hevc_mp4toannexb \
  --extra-cflags="-fPIC -O3" \
  --extra-cxxflags="-fPIC -O3" \
  --extra-ldflags=""

echo "Building FFmpeg..."
make -j"$NPROC"
make install

echo "Compressing dependencies tarball..."
cd "$PROJECT_ROOT"
tar -czf dependencies.tar.gz dependencies/ffmpeg/include dependencies/ffmpeg/lib dependencies/ffmpeg/share

echo "✅ Decoder-only FFmpeg built at $FFMPEG_DIR"
