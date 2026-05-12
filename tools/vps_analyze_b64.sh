#!/bin/bash
# Wrapper: decode video-{ts}.*.b64 and run MediaPipe analysis.
# Usage: vps_analyze_b64.sh <path-to-video-*.b64>
#    or: vps_analyze_b64.sh --all    (batch all unanalyzed .b64 in test dir)

set -e

DIR=/var/www/aegisrd/face-id-test
PY=/opt/mp-venv/bin/python
SCRIPT=/opt/mp-venv/analyze_video.py

analyze_one() {
  local b64="$1"
  local base=$(basename "$b64")             # video-1776xxx.webm.b64
  local decoded="${b64%.b64}"                # video-1776xxx.webm
  local ts=$(echo "$base" | sed -E 's/video-([0-9]+)\..*/\1/')
  local out="$DIR/analysis-${ts}.json"
  if [ -f "$out" ]; then
    echo "[skip] $out exists"
    return 0
  fi
  echo "[decode] $b64 -> $decoded"
  base64 -d "$b64" > "$decoded"
  echo "[analyze] $decoded"
  "$PY" "$SCRIPT" "$decoded" "$out"
  echo "[cleanup] $decoded"
  rm -f "$decoded"
}

if [ "$1" = "--all" ]; then
  for f in "$DIR"/video-*.b64; do
    [ -e "$f" ] || continue
    analyze_one "$f" || echo "[error] $f"
  done
elif [ -n "$1" ]; then
  analyze_one "$1"
else
  echo "usage: $0 <path-to-video-*.b64> | --all"
  exit 1
fi
