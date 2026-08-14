#!/usr/bin/env bash
#
# Phase 1 (ONLINE): download the native source dependencies that the offline
# build phases compile from source. Run this once on a machine with network
# access; afterwards build_dependencies.sh needs only a compiler toolchain.
#
# Decoder-only, LGPL-clean build: only FFmpeg source is fetched (no x264 — there
# is no encode path). Rust crates are NOT fetched here — cargo resolves those
# from the private artifactory at build_library.sh time.
#
# Produces:
#   dependencies_src/<name>          — unpacked source tree per dependency
#   dependencies_src.tar.gz          — portable archive of all of the above, so
#                                      the sources can be shipped to an offline
#                                      machine and extracted by
#                                      build_dependencies.sh.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$PROJECT_ROOT/dependencies_src"
ARCHIVE="$PROJECT_ROOT/dependencies_src.tar.gz"

# ---------------------------------------------------------------------------
# Source dependencies to fetch, as "name|repo|ref" rows. A pinned ref keeps the
# build reproducible and version-locks the FFmpeg tag to the ffmpeg-sys-next
# bindings the crate links against.
#
#   FFmpeg n7.1.5 — most-stabilized 7.x; decode/demux APIs match the
#                   ffmpeg-sys-next 7.x bindings the crate links against.
# ---------------------------------------------------------------------------
DEPENDENCIES=(
  "ffmpeg|https://github.com/FFmpeg/FFmpeg.git|n7.1.5"
)

# Skip the (slow, network-bound) clones entirely if the source archive already
# exists — build_dependencies.sh can extract it offline.
if [ -f "$ARCHIVE" ]; then
  echo "✅ $(basename "$ARCHIVE") already exists — skipping download."
  exit 0
fi

if [ -d "$SRC_DIR" ]; then
  echo "Removing existing sources..."
  rm -rf "$SRC_DIR"
fi
mkdir -p "$SRC_DIR"

for row in "${DEPENDENCIES[@]}"; do
  IFS='|' read -r name repo ref <<<"$row"
  dest="$SRC_DIR/$name"
  echo "Downloading $name @ $ref ..."
  # Shallow clone at the pinned ref. --branch accepts both tags and branch
  # names; for a bare commit SHA we fall back to a fetch-by-SHA below.
  if ! git clone --depth 1 --branch "$ref" "$repo" "$dest" 2>/dev/null; then
    echo "  ($name: '$ref' is not a tag/branch — fetching commit directly)"
    git init -q "$dest"
    git -C "$dest" remote add origin "$repo"
    git -C "$dest" fetch --depth 1 origin "$ref"
    git -C "$dest" checkout -q FETCH_HEAD
  fi
  # Drop the .git dir — we only need the snapshot, and it roughly halves the
  # archive size.
  rm -rf "$dest/.git"
done

echo "Packaging sources into $(basename "$ARCHIVE")..."
rm -f "$ARCHIVE"
tar -czf "$ARCHIVE" -C "$PROJECT_ROOT" "dependencies_src"

echo "✅ Sources downloaded under $SRC_DIR"
echo "✅ Portable archive written to $ARCHIVE"
echo "   Next (offline): ./build_dependencies.sh"
