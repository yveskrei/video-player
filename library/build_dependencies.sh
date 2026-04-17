#!/usr/bin/env bash
#
# Builds a minimal, decoder-only FFmpeg statically for the ffi_library crate.
#
# Unlike the old `library/build_dependencies.sh` this script drops every
# encoder (x264/x265/libvpx/libmp3lame/libopus), every audio path, libsrt +
# OpenSSL, and the libxcb/libXau/libXdmcp stack — the FFI library only needs
# to *decode* H.264 out of fragmented MP4, so the rest is dead weight that
# used to add 30-60 minutes to the build for no runtime benefit.
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
FFMPEG_VERSION="n6.1"

if [ -d "$DEPS_DIR" ]; then
  echo "Removing existing dependencies..."
  rm -rf "$DEPS_DIR"
fi
mkdir -p "$DEPS_DIR"

# Download FFmpeg (shallow clone — we don't need history).
echo "Downloading FFmpeg $FFMPEG_VERSION..."
git clone --depth 1 --branch "$FFMPEG_VERSION" https://github.com/FFmpeg/FFmpeg.git "$FFMPEG_SRC"

echo "Configuring FFmpeg (decoder-only)..."
cd "$FFMPEG_SRC"

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
