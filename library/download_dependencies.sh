#!/usr/bin/env bash
#
# Downloads the source code required by build_dependencies.sh so the build
# itself can run fully offline. Run this once on a machine with network
# access; afterwards build_dependencies.sh only needs a compiler toolchain.
#
# Produces:
#   dependencies/ffmpeg/src          — unpacked FFmpeg source tree
#   dependencies_src.tar.gz          — portable archive of the above, so the
#                                      sources can be shipped to an offline
#                                      machine and extracted with:
#                                        tar -xzf dependencies_src.tar.gz

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
DEPS_DIR="$PROJECT_ROOT/dependencies"
FFMPEG_DIR="$DEPS_DIR/ffmpeg"
FFMPEG_SRC="$FFMPEG_DIR/src"
FFMPEG_VERSION="n6.1"
ARCHIVE="$PROJECT_ROOT/dependencies_src.tar.gz"

if [ -d "$DEPS_DIR" ]; then
  echo "Removing existing dependencies..."
  rm -rf "$DEPS_DIR"
fi
mkdir -p "$FFMPEG_DIR"

echo "Downloading FFmpeg $FFMPEG_VERSION..."
git clone --depth 1 --branch "$FFMPEG_VERSION" https://github.com/FFmpeg/FFmpeg.git "$FFMPEG_SRC"

# Drop the .git dir — we only need the snapshot, and it cuts the archive size
# roughly in half.
rm -rf "$FFMPEG_SRC/.git"

echo "Packaging sources into $(basename "$ARCHIVE")..."
rm -f "$ARCHIVE"
tar -czf "$ARCHIVE" -C "$PROJECT_ROOT" dependencies/ffmpeg/src

echo "✅ Sources downloaded under $DEPS_DIR"
echo "✅ Portable archive written to $ARCHIVE"
