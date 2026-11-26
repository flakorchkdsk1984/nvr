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

DATA_RUN_DIR="${DATA_DIR:-$PROJECT_ROOT/data}/run"
mkdir -p "$DATA_RUN_DIR"
echo $$ > "$DATA_RUN_DIR/recorder.pid"

cleanup_rec() {
  if [ -f "$DATA_RUN_DIR/ffmpeg.pid" ]; then
    kill -TERM $(cat "$DATA_RUN_DIR/ffmpeg.pid" 2>/dev/null) 2>/dev/null || true
    rm -f "$DATA_RUN_DIR/ffmpeg.pid"
  fi
  rm -f "$DATA_RUN_DIR/recorder.pid"
  exit 0
}
trap cleanup_rec SIGTERM SIGINT

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
echo "PID: $$ (saved to $DATA_RUN_DIR/recorder.pid)"
echo "=========================================="

mkdir -p "$REC_DIR"

while true; do
  TODAY=$(date +%Y-%m-%d)
  TOMORROW=$(date -d "+1 day" +%Y-%m-%d 2>/dev/null || date +%Y-%m-%d)
  mkdir -p "$REC_DIR/$TODAY" "$REC_DIR/$TOMORROW"

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting FFmpeg recording process..."
  
  "$FFMPEG_BIN" -hide_banner -loglevel warning \
    -rtsp_transport tcp \
    -fflags +genpts \
    -i "$RTSP_URL" \
    -c copy \
    -avoid_negative_ts make_zero \
    -f segment \
    -segment_time "$SEGMENT_LEN" \
    -segment_format mp4 \
    -segment_format_options movflags=+faststart \
    -reset_timestamps 1 \
    -strftime 1 \
    "$REC_DIR/%Y-%m-%d/c2l_%Y%m%d_%H%M%S.mp4" &

  FFMPEG_PID=$!
  echo $FFMPEG_PID > "$DATA_RUN_DIR/ffmpeg.pid"
  wait $FFMPEG_PID
  EXIT_CODE=$?
  rm -f "$DATA_RUN_DIR/ffmpeg.pid"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] FFmpeg exited with code $EXIT_CODE. Reconnecting in 5 seconds..."
  sleep 5
done
