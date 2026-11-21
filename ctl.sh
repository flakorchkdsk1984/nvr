#!/usr/bin/env bash
# ==========================================================
# C2L NVR Service Controller (systemd or standalone)
# ==========================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_DIR="$SCRIPT_DIR/data/run"
mkdir -p "$PID_DIR"

install_systemd() {
  echo "Installing systemd user services to ~/.config/systemd/user/..."
  mkdir -p ~/.config/systemd/user
  cp "$SCRIPT_DIR/systemd/"*.service ~/.config/systemd/user/
  systemctl --user daemon-reload
  echo "Enabling services..."
  systemctl --user enable c2l-go2rtc.service c2l-recorder.service c2l-web.service
  echo "Services installed. Start with: systemctl --user start c2l-go2rtc c2l-recorder c2l-web"
}

start_standalone() {
  echo "Starting C2L NVR Suite..."
  
  # 1. Start go2rtc
  if ! pgrep -f "go2rtc.*go2rtc.yaml" > /dev/null; then
    nohup /home/chkdsk/bin/go2rtc -c /home/chkdsk/go2rtc.yaml > "$SCRIPT_DIR/data/go2rtc.log" 2>&1 &
    echo $! > "$PID_DIR/go2rtc.pid"
    echo "  [+] go2rtc started (PID: $(cat "$PID_DIR/go2rtc.pid"))"
  else
    echo "  [=] go2rtc is already running"
  fi

  sleep 1

  # 2. Start Recorder
  if ! pgrep -f "recorder.sh" > /dev/null; then
    nohup "$SCRIPT_DIR/scripts/recorder.sh" > "$SCRIPT_DIR/data/recorder.log" 2>&1 < /dev/null &
    REC_PID=$!
    echo $REC_PID > "$PID_DIR/recorder.pid"
    disown $REC_PID 2>/dev/null || true
    echo "  [+] FFmpeg 24/7 Recorder started (PID: $REC_PID)"
  else
    echo "  [=] FFmpeg recorder is already running"
  fi

  # 3. Start Web Server
  if ! pgrep -f "node.*dist/server.js" > /dev/null; then
    nohup node "$SCRIPT_DIR/web/backend/dist/server.js" > "$SCRIPT_DIR/data/web.log" 2>&1 < /dev/null &
    WEB_PID=$!
    echo $WEB_PID > "$PID_DIR/web.pid"
    disown $WEB_PID 2>/dev/null || true
    echo "  [+] Web Server started on http://0.0.0.0:8080 (PID: $WEB_PID)"
  else
    echo "  [=] Web Server is already running"
  fi

  echo "=========================================================="
  echo "  NVR Web UI: http://localhost:8080"
  echo "  go2rtc Web: http://localhost:1984"
  echo "  RTSP Feed : rtsp://localhost:8554/c2l_hd"
  echo "=========================================================="
}

stop_standalone() {
  echo "Stopping C2L NVR Suite..."
  pkill -f "recorder.sh"
  pkill -f "ffmpeg.*c2l_hd"
  pkill -f "node.*dist/server.js"
  echo "  [-] Recorder and Web server stopped."
  echo "  (go2rtc was left running. Run 'pkill -f go2rtc' if you want to stop it as well)."
}

status_nvr() {
  echo "=========================================================="
  echo "C2L NVR Status Check"
  echo "=========================================================="
  
  if pgrep -f "go2rtc.*go2rtc.yaml" > /dev/null; then
    echo "  go2rtc Bridge : [RUNNING] (PID: $(pgrep -f "go2rtc.*go2rtc.yaml" | head -1))"
  else
    echo "  go2rtc Bridge : [STOPPED]"
  fi

  if pgrep -f "ffmpeg.*c2l_hd" > /dev/null; then
    echo "  FFmpeg 24/7 REC: [RECORDING] (PID: $(pgrep -f "ffmpeg.*c2l_hd" | head -1))"
  else
    echo "  FFmpeg 24/7 REC: [STOPPED]"
  fi

  if pgrep -f "node.*dist/server.js" > /dev/null; then
    echo "  Web UI Server : [RUNNING] (http://0.0.0.0:8080) (PID: $(pgrep -f "node.*dist/server.js" | head -1))"
  else
    echo "  Web UI Server : [STOPPED]"
  fi

  echo ""
  curl -s http://127.0.0.1:8080/api/health | jq . 2>/dev/null || curl -s http://127.0.0.1:8080/api/health
  echo ""
}

case "$1" in
  start)
    start_standalone
    ;;
  stop)
    stop_standalone
    ;;
  status)
    status_nvr
    ;;
  install-systemd)
    install_systemd
    ;;
  *)
    echo "Usage: $0 {start|stop|status|install-systemd}"
    exit 1
    ;;
esac
