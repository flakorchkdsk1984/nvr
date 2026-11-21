#!/bin/bash
# ==========================================
# C2L NVR 24/7 FFmpeg Continuous Recorder
# ==========================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_ROOT/.env"

if [ -f "$ENV_FILE" ]; then
  # Export variables from .env if present
  set -a
  source "$ENV_FILE"
  set +a
fi

# Detect ffmpeg binary
if [ -n "$FFMPEG_PATH" ] && [ -x "$FFMPEG_PATH" ]; then
  FFMPEG_BIN="$FFMPEG_PATH"
elif command -v ffmpeg >/dev/null 2>&1; then
  FFMPEG_BIN="$(command -v ffmpeg)"
elif [ -x "/home/chkdsk/bin/ffmpeg" ]; then
  FFMPEG_BIN="/home/chkdsk/bin/ffmpeg"
else
  FFMPEG_BIN="ffmpeg"
fi
RTSP_URL="${GO2RTC_RTSP:-rtsp://127.0.0.1:8554}/c2l_hd"
REC_DIR="${RECORDINGS_DIR:-$PROJECT_ROOT/recordings}"
SEGMENT_LEN="${SEGMENT_SECONDS:-900}"

echo "=========================================="
echo "Starting C2L NVR 24/7 Recorder"
echo "Source: $RTSP_URL"
echo "Destination: $REC_DIR"
echo "Segment Length: ${SEGMENT_LEN}s (15 min)"
echo "=========================================="

mkdir -p "$REC_DIR"

while true; do
  TODAY=$(date +%Y-%m-%d)
  mkdir -p "$REC_DIR/$TODAY"

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting FFmpeg recording process..."
  
  "$FFMPEG_BIN" -hide_banner -loglevel warning \
    -rtsp_transport tcp \
    -i "$RTSP_URL" \
    -c copy \
    -movflags +faststart \
    -f segment \
    -segment_time "$SEGMENT_LEN" \
    -reset_timestamps 1 \
    -strftime 1 \
    "$REC_DIR/%Y-%m-%d/c2l_%Y%m%d_%H%M%S.mp4"

  EXIT_CODE=$?
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] FFmpeg exited with code $EXIT_CODE. Reconnecting in 5 seconds..."
  sleep 5
done
