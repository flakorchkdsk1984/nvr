#!/bin/bash
# ==============================================================================
# C2L NVR Suite - Docker Entrypoint Script
# ==============================================================================
set -e

# Default environment configuration
export CAMERA_HOST="${CAMERA_HOST:-192.168.1.40}"
export CAMERA_PORT="${CAMERA_PORT:-80}"
export CAMERA_USER="${CAMERA_USER:-admin}"
export CAMERA_PASS="${CAMERA_PASS:-}"
export GO2RTC_URL="${GO2RTC_URL:-http://127.0.0.1:1984}"
export GO2RTC_RTSP="${GO2RTC_RTSP:-rtsp://127.0.0.1:8554}"
export RECORDINGS_DIR="${RECORDINGS_DIR:-/app/recordings}"
export DATA_DIR="${DATA_DIR:-/app/data}"
export CACHE_DIR="${CACHE_DIR:-/app/cache}"
export THUMBS_DIR="${THUMBS_DIR:-/app/cache/thumbs}"
export SEGMENT_SECONDS="${SEGMENT_SECONDS:-900}"
export RETENTION_DAYS="${RETENTION_DAYS:-7}"
export MAX_DISK_USAGE_PERCENT="${MAX_DISK_USAGE_PERCENT:-90}"
export PORT="${PORT:-8000}"
export AUTH_USER="${AUTH_USER:-admin}"
export AUTH_PASS_HASH="${AUTH_PASS_HASH:-\$2a\$10\$r2JgGUv9lK7rxZ24sP2cKeQJi1s18b8oLB/UD8D08SNSihPFADscu}"
export JWT_SECRET="${JWT_SECRET:-super_secret_jwt_c2l_nvr_key_2026_xyz987}"
export FFMPEG_PATH="${FFMPEG_PATH:-/usr/bin/ffmpeg}"
export FFPROBE_PATH="${FFPROBE_PATH:-/usr/bin/ffprobe}"

# Ensure runtime directories exist
mkdir -p "$RECORDINGS_DIR" "$DATA_DIR/run" "$DATA_DIR/events" "$DATA_DIR/preroll" "$THUMBS_DIR"

# Dynamically generate go2rtc.yaml based on configured camera IP & credentials
cat <<EOF > /app/go2rtc.yaml
streams:
  c2l_hd:
    - eseecloud://${CAMERA_USER}:${CAMERA_PASS}@${CAMERA_HOST}:${CAMERA_PORT}/livestream/11
    - ffmpeg:c2l_hd#video=copy#audio=opus
  c2l_sd:
    - eseecloud://${CAMERA_USER}:${CAMERA_PASS}@${CAMERA_HOST}:${CAMERA_PORT}/livestream/12
    - ffmpeg:c2l_sd#video=copy#audio=opus

api:
  listen: ":1984"
  origin: "*"

webrtc:
  listen: ":8555"

rtsp:
  listen: ":8554"

log:
  level: info
EOF

echo "=================================================================="
echo " 🚀 C2L NVR Suite Starting in Docker"
echo " 📡 Camera Target:       ${CAMERA_HOST}:${CAMERA_PORT}"
echo " 💾 Recordings Volume:   ${RECORDINGS_DIR}"
echo " ⏱️  Retention:           ${RETENTION_DAYS} días (${SEGMENT_SECONDS}s por segmento)"
echo " 🌐 Web Interface:       http://0.0.0.0:${PORT}"
echo "=================================================================="

# Graceful termination handler
cleanup() {
  echo "Terminating C2L NVR services..."
  pkill -f 'recorder.sh' || true
  pkill -TERM -f 'ffmpeg' || true
  pkill -TERM -f 'go2rtc' || true
  pkill -TERM -f 'node' || true
  exit 0
}
trap cleanup SIGTERM SIGINT

# 1. Start go2rtc streaming bridge
echo "[1/3] Starting go2rtc bridge..."
/usr/local/bin/go2rtc -c /app/go2rtc.yaml &
GO2RTC_PID=$!

# Wait for go2rtc API to be ready
until curl -s http://127.0.0.1:1984/api > /dev/null 2>&1; do
  sleep 0.5
done
echo "      go2rtc ready on port 1984 (API) and 8554 (RTSP)"

# 2. Start Node.js Web Backend, Motion Detection & Recorder Manager
echo "[2/2] Starting NVR Web Server, Motion Engine & Recorder Manager on port ${PORT}..."
node /app/web/backend/dist/server.js &
NODE_PID=$!

# Keep container running as long as the Web Server is alive
# The recorder can be stopped/started dynamically without terminating the container
wait $NODE_PID
