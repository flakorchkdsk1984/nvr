# ==============================================================================
# Multi-stage Dockerfile for C2L NVR Suite
# Camera: EseeCloud PTZ C2L-Y-A (192.168.1.40)
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Build Angular Frontend
# ------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS frontend-builder
WORKDIR /build/frontend

COPY web/frontend/package*.json ./
RUN npm ci

COPY web/frontend/ ./
RUN npm run build

# ------------------------------------------------------------------------------
# Stage 2: Build Node.js / TypeScript Backend
# ------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS backend-builder
WORKDIR /build/backend

COPY web/backend/package*.json ./
RUN npm ci

COPY web/backend/ ./
RUN npm run build

# ------------------------------------------------------------------------------
# Stage 3: Final Production Runtime Container
# ------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# Install system dependencies: FFmpeg, procps (pkill/ps), curl, bash
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    procps \
    curl \
    ca-certificates \
    bash \
    && rm -rf /var/lib/apt/lists/*

# Install go2rtc streaming binary (supports amd64 and arm64)
ARG TARGETARCH=amd64
RUN GO2RTC_ARCH="${TARGETARCH}" && \
    if [ "$TARGETARCH" = "x86_64" ]; then GO2RTC_ARCH="amd64"; fi && \
    if [ "$TARGETARCH" = "aarch64" ]; then GO2RTC_ARCH="arm64"; fi && \
    curl -fsSL -o /usr/local/bin/go2rtc "https://github.com/AlexxIT/go2rtc/releases/download/v1.9.15/go2rtc_linux_${GO2RTC_ARCH}" && \
    chmod +x /usr/local/bin/go2rtc

WORKDIR /app

# Install production backend dependencies
COPY web/backend/package*.json /app/web/backend/
WORKDIR /app/web/backend
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled backend and frontend assets
WORKDIR /app
COPY --from=backend-builder /build/backend/dist /app/web/backend/dist
COPY --from=frontend-builder /build/frontend/dist /app/web/frontend/dist

# Copy recorder script and entrypoint (sanitizing CRLF line endings)
COPY scripts/recorder.sh /app/scripts/recorder.sh
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN sed -i 's/\r$//' /app/scripts/recorder.sh /app/docker-entrypoint.sh && \
    chmod +x /app/scripts/recorder.sh /app/docker-entrypoint.sh

# Default storage directories
RUN mkdir -p /app/recordings /app/data/run /app/data/events /app/data/preroll /app/cache/thumbs

# Volumes for persistent recordings and app database/logs
VOLUME ["/app/recordings", "/app/data", "/app/cache"]

# Ports:
# 8000: Web NVR Dashboard + API + MSE/HLS proxy
# 8554: RTSP Server (go2rtc)
# 1984: go2rtc Web / API
# 8555: WebRTC (TCP/UDP)
EXPOSE 8000 8554 1984 8555/tcp 8555/udp

ENTRYPOINT ["/app/docker-entrypoint.sh"]
