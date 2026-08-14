#!/usr/bin/env bash
#
# Phase 3: build the client_video cdylib against the static decoder-only FFmpeg
# produced by build_dependencies.sh. Output: target/release/libclient_video.so.
#
# The backend URL is COOKED IN at build time (the crate reads it via env!), so it
# must be set in the environment before running this:
#
#   B2B_URL=http://127.0.0.1:8702 ./build_library.sh
#
#   B2B_URL    backend base URL — the BARE ORIGIN, with NO path prefix.
#              This backend serves /videos/, /progressive/, /bboxes/ at the root;
#              adding any prefix makes every call hit its catch-all 404.
#              There is no authentication, so no token is needed.
#
# Offline w.r.t. native deps (FFmpeg is pre-built and local). Rust crates resolve
# from the private artifactory configured on the host.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
DEPS_DIR="$PROJECT_ROOT/dependencies"
FFMPEG_DIR="$DEPS_DIR/ffmpeg"
ARCHIVE_FILE="$PROJECT_ROOT/dependencies.tar.gz"

# --- The cooked-in backend config must be present in the environment ----------
if [ -z "${B2B_URL:-}" ]; then
  echo "❌ B2B_URL must be set in the environment." >&2
  echo "   e.g. B2B_URL=http://127.0.0.1:8702 ./build_library.sh" >&2
  echo "   (bare origin — NO path prefix; this backend serves its routes at the root)" >&2
  exit 1
fi

# Auto-extract the prebuilt tarball if the install tree isn't already present.
if [ -f "$ARCHIVE_FILE" ] && [ ! -d "$FFMPEG_DIR" ]; then
  echo "Extracting dependencies archive..."
  mkdir -p "$DEPS_DIR"
  tar -xzf "$ARCHIVE_FILE" -C "$PROJECT_ROOT"
fi

if [ ! -d "$FFMPEG_DIR" ]; then
  echo "❌ Prebuilt deps not found — run ./build_dependencies.sh first." >&2
  exit 1
fi

cd "$PROJECT_ROOT"

echo "Building client_video with static FFmpeg..."

# ffmpeg-sys-next locates the static FFmpeg via FFMPEG_DIR + pkg-config.
export FFMPEG_DIR="$FFMPEG_DIR"
export DEPS_DIR="$DEPS_DIR"
export PROJECT_ROOT="$PROJECT_ROOT"
export PKG_CONFIG_PATH="$FFMPEG_DIR/lib/pkgconfig"
export PKG_CONFIG_STATIC=1
export FFMPEG_INCLUDE_DIR="$FFMPEG_DIR/include"
export FFMPEG_LIB_DIR="$FFMPEG_DIR/lib"
export BINDGEN_EXTRA_CLANG_ARGS="-I$FFMPEG_DIR/include"

# ffmpeg-sys-next 7.1 pins bindgen 0.70, which generates broken bindings against libclang >= 20:
# fully-defined structs come out as 1-byte forward declarations while keeping their real size
# assertions, so the build dies on E0080 const-eval overflows. Pin a contemporaneous libclang.
LIBCLANG_PATH="${LIBCLANG_PATH:-/usr/lib64/llvm19/lib}"
if [ ! -e "$LIBCLANG_PATH/libclang.so.19.1" ]; then
  echo "❌ libclang 19 not found at $LIBCLANG_PATH — install it" >&2
  echo "   (bindgen 0.70, pinned by ffmpeg-sys-next 7.1, cannot use a newer system libclang)" >&2
  exit 1
fi
export LIBCLANG_PATH

# Cooked-in backend config (read by the crate via env! at compile time); ensure it reaches cargo.
export B2B_URL

# Static link line: FFmpeg's own libraries, then the host's dynamic
# libc/libstdc++/libm/libz/libpthread/libdl. build.rs supplies the -L search
# paths and the symbol-hiding link args.
export RUSTFLAGS="-C link-arg=-L$FFMPEG_DIR/lib \
-C link-arg=-Wl,-Bstatic \
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

cd client && cargo build --release

# Drop the extracted install tree; the tarball remains the portable artifact.
echo "Cleaning up extracted dependencies..."
rm -rf "$DEPS_DIR"

echo "Successfully built library!"
