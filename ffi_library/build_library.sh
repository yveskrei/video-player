#!/usr/bin/env bash
#
# Builds the ffi_library crate against the minimal static FFmpeg produced by
# build_dependencies.sh. Output lands at target/release/libffi_client_video.so.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
DEPS_DIR="$PROJECT_ROOT/dependencies"
FFMPEG_DIR="$DEPS_DIR/ffmpeg"
ARCHIVE_FILE="$PROJECT_ROOT/dependencies.tar.gz"

# Auto-extract the tarball if a pre-built FFmpeg tree isn't already present.
if [ -f "$ARCHIVE_FILE" ] && [ ! -d "$FFMPEG_DIR" ]; then
  echo "Extracting dependencies archive..."
  mkdir -p "$DEPS_DIR"
  tar -xzf "$ARCHIVE_FILE" -C "$PROJECT_ROOT"
fi

if [ ! -d "$FFMPEG_DIR" ]; then
  echo "❌ FFmpeg not found — run ./build_dependencies.sh first" >&2
  exit 1
fi

cd "$PROJECT_ROOT"

echo "Building ffi_library with static FFmpeg..."

export PKG_CONFIG_PATH="$FFMPEG_DIR/lib/pkgconfig"
export PKG_CONFIG_STATIC=1
export FFMPEG_DIR="$FFMPEG_DIR"
export DEPS_DIR="$DEPS_DIR"
export PROJECT_ROOT="$PROJECT_ROOT"
export FFMPEG_INCLUDE_DIR="$FFMPEG_DIR/include"
export FFMPEG_LIB_DIR="$FFMPEG_DIR/lib"
export BINDGEN_EXTRA_CLANG_ARGS="-I$FFMPEG_DIR/include"

# With the decoder-only FFmpeg there are no external static libraries to link
# (no x264/x265/libvpx/openssl/libsrt/libxcb). We just pull in FFmpeg's own
# libraries statically and rely on libc/libstdc++/libm/libz/libpthread/libdl
# from the host as dynamic dependencies.
export RUSTFLAGS="-C link-arg=-L$FFMPEG_DIR/lib \
-C link-arg=-Wl,-Bstatic \
-C link-arg=-lavfilter \
-C link-arg=-lavformat \
-C link-arg=-lavcodec \
-C link-arg=-lswscale \
-C link-arg=-lswresample \
-C link-arg=-lavutil \
-C link-arg=-Wl,-Bdynamic \
-C link-arg=-lstdc++ \
-C link-arg=-lm \
-C link-arg=-lz \
-C link-arg=-lpthread \
-C link-arg=-ldl \
-C link-arg=-lc"

# `cargo clean` isn't strictly necessary on subsequent builds, but makes the
# output reproducible and avoids stale link-line state.
cargo build --release

echo "✅ Built $(ls -1 target/release/libffi_client_video.so 2>/dev/null || echo 'target/release/libffi_client_video.so not found')"
