# ==============================================================================
# Multi-stage Dockerfile for C2L NVR Suite
# Camera: EseeCloud PTZ C2L-Y-A (192.168.1.40)
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 0: Build Patched go2rtc with EseeCloud AAC Support
# ------------------------------------------------------------------------------
FROM golang:alpine AS go2rtc-builder
RUN apk add --no-cache git
WORKDIR /src
RUN git clone --depth 1 --branch v1.9.15 https://github.com/AlexxIT/go2rtc.git .
COPY patches/eseecloud_aac.patch /tmp/
RUN git apply /tmp/eseecloud_aac.patch
RUN CGO_ENABLED=0 go build -ldflags "-s -w" -o /go2rtc

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

# Install patched go2rtc streaming binary with EseeCloud AAC support
COPY --from=go2rtc-builder /go2rtc /usr/local/bin/go2rtc
RUN chmod +x /usr/local/bin/go2rtc

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
