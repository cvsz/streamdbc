# STREMDBC User Manual

**Version:** 0.6.0
**Last Updated:** 2026-09-17

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Quick Start](#quick-start)
4. [Configuration](#configuration)
5. [API Reference](#api-reference)
6. [Web Dashboard](#web-dashboard)
7. [Player](#player)
8. [Streaming Ingest](#streaming-ingest)
9. [HLS Output](#hls-output)
10. [Authentication](#authentication)
11. [Security](#security)
12. [Deployment](#deployment)
13. [Monitoring](#monitoring)
14. [Troubleshooting](#troubleshooting)
15. [Building](#building)
16. [Docker](#docker)

---

## 1. Overview

STREMDBC is a Go-based streaming management control plane. It provides:

- **Stream lifecycle management** — create, query, and delete stream records
- **Authentication** — JWT-based stream-scoped tokens and API key access control
- **Protocol adapters** — bounded RTMP, RTSP, SRT, and WebRTC ingest/control
- **Media output** — HLS and LL-HLS writers
- **Observability** — Prometheus metrics and health endpoints
- **Management UI** — zero-build web dashboard and player

### Current Capability Matrix

| Component | Status |
|---|---|
| HTTP API, stream registry, auth, metrics | Available and lifecycle-tested |
| HLS writer | Available as library component |
| LL-HLS writer | Available as library component |
| RTMP ingest | Bounded handshake/control parser; media rejected |
| RTSP ingest | Bounded control/session adapter; media unavailable |
| SRT ingest/output | Metadata guard only |
| WHIP/WHEP | SDP peer negotiation; RTP forwarding unavailable |
| RTMP/RTSP outputs | Bounded control endpoints |
| Recorder, DVR, transcoder | Reusable managers; no media-source wiring |
| Redis cluster | Node registration, heartbeat, discovery primitives |
| PostgreSQL | Rejected until schema integration |

> **Important:** The default configuration keeps all media adapters disabled. Enable an adapter only after supplying the corresponding production media engine and integration.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    HTTP Listener (:8085)                  │
│  ┌─────────┐  ┌──────────┐  ┌────────┐  ┌────────────┐  │
│  │  API    │  │ Dashboard│  │ Player │  │  /hls/...  │  │
│  │  /api   │  │  /dash/  │  │ /play/ │  │  HLS files │  │
│  └────┬────┘  └──────────┘  └────────┘  └────────────┘  │
│       │                                                  │
│  ┌────▼──────────────────────────────────────────────┐   │
│  │              API Server                            │   │
│  │  Auth Manager │ Stream Registry │ Metrics          │   │
│  └────┬──────────────┬──────────────┬─────────────────┘   │
│       │              │              │                      │
│  ┌────▼────┐  ┌──────▼──────┐  ┌──▼──────────┐           │
│  │ RTMP    │  │ HLS Manager │  │ Stream      │           │
│  │ Ingest  │  │ (writes to  │  │ Registry    │           │
│  │ :1935   │  │  /tmp/hls/) │  │ (in-memory) │           │
│  └─────────┘  └─────────────┘  └─────────────┘           │
└──────────────────────────────────────────────────────────┘
```

### Key Concepts

- **Stream**: A named media entity identified by a Stream ID (URL-safe ASCII: letters, digits, `.`, `_`, `-`)
- **Stream State**: `IDLE` → active when media is pushed → back to `IDLE` when stopped
- **Stream ID**: Unique identifier used in API paths, RTMP URLs, and HLS paths
- **JWT Token**: Stream-scoped, HS256-signed, bound to stream ID + action + client IP
- **API Key**: Long-lived credential for management API access

---

## 3. Quick Start

### Prerequisites

- Go 1.27+ (for building from source)
- FFmpeg (required only when using recorder or transcoder)

### Minimum Viable Setup

```bash
# 1. Build the binary
cd /home/cvsz/streamdbc
make build

# 2. Verify the binary
./stremdbc -version

# 3. Start with production config
./stremdbc -config configs/config.zlive.yaml

# 4. Check health
curl http://localhost:8085/health
```

Expected response:
```json
{"api_base_path":"/api/v1","auth_enabled":true,"metrics_path":"/metrics","status":"healthy","uptime":"3s","version":"0.6.0"}
```

### Create Your First Stream

```bash
# Create a stream record
curl -X POST -H "Content-Type: application/json" \
  -d '{"id":"my-first-stream","name":"My First Stream"}' \
  http://localhost:8085/api/v1/streams

# Verify it exists
curl http://localhost:8085/api/v1/streams/my-first-stream
```

### Push Media via RTMP

From any RTMP encoder (OBS, vMix, ffmpeg):

```
rtmp://localhost:1935/my-first-stream
```

> **Note:** RTMP ingest requires authentication to be disabled. See [Authentication](#authentication) for details.

### Watch via HLS

Once media is flowing, HLS segments are written to `/tmp/hls/my-first-stream/`. Viewers access:

```
http://localhost:8085/hls/my-first-stream/index.m3u8
```

---

## 4. Configuration

### Config File Location

Passed via the `-config` flag:

```bash
./stremdbc -config /path/to/config.yaml
```

### Configuration Structure

All configuration is in YAML. The main sections are:

| Section | Purpose | Default |
|---|---|---|
| `server` | HTTP listener settings | `0.0.0.0:8085` |
| `rtmp` | RTMP ingest server | Disabled |
| `rtsp` | RTSP ingest server | Disabled |
| `srt` | SRT metadata adapter | Disabled |
| `webrtc` | WHIP/WHEP signaling | Disabled |
| `hls` | HLS output writer | Disabled |
| `llhls` | LL-HLS output writer | Disabled |
| `api` | API settings | Enabled, `/api/v1` |
| `auth` | JWT + API key auth | Disabled |
| `metrics` | Prometheus metrics | Enabled, `/metrics` |
| `redis` | Redis for cluster mode | Disabled |
| `postgres` | PostgreSQL metadata | Disabled |
| `cluster` | Cluster coordination | Disabled |
| `recorder` | FFmpeg recording | Disabled |
| `dvr` | File-backed DVR | Disabled |
| `transcoder` | FFmpeg ABR ladder | Disabled |
| `logging` | Log format and level | `info`, `json`, `stdout` |

### Production Config (zlive.zeaz.dev)

The active production configuration is at `configs/config.zlive.yaml`:

- **HTTP port**: 8085
- **RTMP port**: 1935 (enabled)
- **HLS**: enabled, writes to `/tmp/hls`
- **Auth**: disabled (RTMP requires auth off)
- **Secrets**: stored in `.env.production` (mode 0600)

### Config Validation Rules

The configuration is validated at startup. Key rules:

- **Auth + RTMP/RTSP**: Mutually exclusive. RTMP/RTSP ingest cannot be enabled when authentication is active (publish-token handshake not yet implemented).
- **Port conflicts**: Two enabled listeners cannot bind the same address:port.
- **Stream ID format**: URL-safe ASCII letters, digits, `.`, `_`, `-`; max 64 characters.
- **Timeouts**: Must be positive durations.
- **HLS/LL-HLS paths**: Must be non-empty, writable directories.
- **CORS origins**: Must be valid URLs or `*`.
- **API keys**: At least one required when auth is enabled.
- **JWT secret**: Minimum 32 characters when auth is enabled.

### Environment Variable Expansion

The production config supports environment variable substitution:

```yaml
auth:
  jwt_secret: "${STREMDBC_JWT_SECRET}"
  api_keys:
    - "${STREMDBC_API_KEY}"
```

Set variables before starting:

```bash
export STREMDBC_JWT_SECRET="your-64-char-random-secret"
export STREMDBC_API_KEY="your-48-char-random-key"
./stremdbc -config configs/config.zlive.yaml
```

---

## 5. API Reference

All endpoints are served on the configured HTTP port (default `8085`). The default base path is `/api/v1`.

### Health and Observability

#### `GET /health`

Returns process health, version, uptime, and configuration paths.

```bash
curl http://localhost:8085/health
```

Response:
```json
{
  "api_base_path": "/api/v1",
  "auth_enabled": false,
  "metrics_path": "/metrics",
  "status": "healthy",
  "uptime": "3s",
  "version": "0.6.0"
}
```

#### `GET /ready`

Returns HTTP readiness. External dependencies are checked during startup.

#### `GET /metrics`

Prometheus text exposition. Disabled when `metrics.enable` is `false`.

```bash
curl http://localhost:8085/metrics
```

#### `GET /api/v1/info`

Service version, Go runtime, CPU, goroutine, and uptime information.

```bash
curl http://localhost:8085/api/v1/info
```

#### `GET /api/v1/stats`

Registry telemetry and statistics from enabled components.

```bash
curl http://localhost:8085/api/v1/stats
```

Response:
```json
{
  "streams": 2,
  "live_streams": 1,
  "viewers": 15,
  "goroutines": 24,
  "memory_bytes": 12582912,
  "uptime_seconds": 390,
  "components": {}
}
```

### Streams

#### `GET /api/v1/streams`

List all registered streams.

```bash
curl http://localhost:8085/api/v1/streams
```

Response:
```json
{
  "count": 1,
  "streams": [
    {
      "id": "my-stream",
      "name": "My Stream",
      "state": "IDLE",
      "created_at": "2026-09-17T05:38:09Z",
      "viewers": 0,
      "last_activity_at": "2026-09-17T05:38:09Z"
    }
  ]
}
```

#### `POST /api/v1/streams`

Create a new stream record. The request body must be a single JSON object with no unknown fields.

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"id":"camera-01","name":"Camera 01"}' \
  http://localhost:8085/api/v1/streams
```

Response: `201 Created`
```json
{
  "id": "camera-01",
  "name": "Camera 01",
  "state": "IDLE",
  "created_at": "2026-09-17T05:38:09Z",
  "viewers": 0,
  "last_activity_at": "2026-09-17T05:38:09Z"
}
```

#### `GET /api/v1/streams/{id}`

Return a stream snapshot.

```bash
curl http://localhost:8085/api/v1/streams/camera-01
```

#### `DELETE /api/v1/streams/{id}`

Delete an idle stream. Live, recording, or viewed streams return `409 Conflict` and must be stopped before deletion.

```bash
curl -X DELETE http://localhost:8085/api/v1/streams/camera-01
```

### Authentication

#### `POST /api/v1/auth/token`

Create a stream-scoped JWT. Requires `X-API-Key` header when authentication is enabled.

```bash
curl -X POST -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{"stream_id":"camera-01","action":"play"}' \
  http://localhost:8085/api/v1/auth/token
```

Response:
```json
{
  "action": "play",
  "stream_id": "camera-01",
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

The token is an HS256 JWT with claims: `stream_id`, `action` (`publish` or `play`), `ip`, `iss` (`stremdbc`), `sub`, `exp`, `nbf`, `iat`.

### Error Format

All errors use a single `error` field:

```json
{"error": "unauthorized"}
```

| Status Code | Meaning |
|---|---|
| 400 | Malformed input |
| 401 | Authorization failure |
| 404 | Missing resource |
| 405 | Unsupported HTTP method |
| 409 | State conflict (e.g., deleting active stream) |
| 500 | Internal failure |
| 503 | Requested subsystem disabled |

---

## 6. Web Dashboard

The dashboard is a zero-build management UI served at `/dashboard/`.

### Access

```
http://localhost:8085/dashboard/
```

Or via Cloudflare Tunnel:

```
http://zlive.zeaz.dev/dashboard/
```

### Features

- View all registered streams and their states
- Create and delete streams
- Monitor stream activity and viewer counts
- Access the player for each stream

### Static Files

The dashboard is a single HTML file at `web/dashboard/index.html`. It is served as static content with no build step required.

---

## 7. Player

The built-in player is served at `/player/{streamID}`.

### Access

```
http://localhost:8085/player/my-stream
```

Or via Cloudflare Tunnel:

```
http://zlive.zeaz.dev/player/my-stream
```

### Authentication

When authentication is enabled, the player requires a play token. The token can be:

1. Passed as a query parameter: `http://zlive.zeaz.dev/player/my-stream?token=eyJ...`
2. Included in the `Authorization` header: `Bearer eyJ...`

When authentication is disabled (current production config), the player is publicly accessible.

---

## 8. Streaming Ingest

### RTMP Ingest

**Port**: 1935 (TCP)

**Status**: Bounded handshake/control parser. Audio/video media is rejected explicitly.

#### Setup

1. Enable RTMP in config:
   ```yaml
   rtmp:
     enable: true
     host: "0.0.0.0"
     port: 1935
   ```

2. **Disable authentication** (RTMP and auth are mutually exclusive):
   ```yaml
   auth:
     enable: false
   ```

3. Restart the server.

4. Create a stream record via API:
   ```bash
   curl -X POST -H "Content-Type: application/json" \
     -d '{"id":"my-stream","name":"My Stream"}' \
     http://localhost:8085/api/v1/streams
   ```

5. Push from your encoder:
   ```
   rtmp://server:1935/my-stream
   ```

#### vMix Setup

In vMix: **Output → RTMP**

| Setting | Value |
|---|---|
| Destination URL | `rtmp://zlive.zeaz.dev/live-stream-01` |
| Stream Key | `live-stream-01` |
| Video Codec | H.264 |
| Audio Codec | AAC |

#### ffmpeg Push

```bash
ffmpeg -i input.mp4 -c:v libx264 -c:a aac \
  -f flv rtmp://localhost:1935/my-stream
```

### RTSP Ingest

**Port**: 8554 (TCP)

**Status**: Bounded control/session adapter. Media description and forwarding unavailable.

**Constraint**: Cannot be enabled alongside authentication (same as RTMP).

### SRT Ingest

**Port**: 9000 (UDP)

**Status**: Metadata guard only. No libsrt transport or media forwarding.

### WebRTC (WHIP/WHEP)

**Port**: 8443 (TCP)

**Status**: SDP peer negotiation and publisher-track detection. RTP forwarding unavailable.

**Warning**: `GO-2026-4479` in Pion DTLS dependency — no upstream fixed version. Keep WebRTC disabled until resolved.

---

## 9. HLS Output

### How It Works

When an RTMP (or future) ingest pushes media, the HLS writer creates:

```
/tmp/hls/{stream-id}/
  index.m3u8
  segment-00001.ts
  segment-00002.ts
  ...
```

### Viewing HLS

Direct file access:
```
http://localhost:8085/hls/{stream-id}/index.m3u8
```

Via Cloudflare Tunnel:
```
http://zlive.zeaz.dev/hls/{stream-id}/index.m3u8
```

### HLS Configuration

```yaml
hls:
  enable: true
  path: "/tmp/hls"
  segment_duration: 2s      # Duration of each TS segment
  playlist_size: 5          # Number of segments in playlist
```

### HLS Security

Static file delivery includes:
- Path traversal rejection
- Symlink escape prevention
- Path validation on every request

---

## 10. Authentication

### Current State

The production config (`configs/config.zlive.yaml`) has **authentication disabled** to allow RTMP ingest. This is a known constraint.

### When Auth Is Enabled

When `auth.enable: true`:

- **API access**: All mutating requests (POST, DELETE) and token issuance require `X-API-Key` header
- **Playback**: Stream-scoped JWT required for `/player/{id}` and WHIP/WHEP
- **Anonymous playback**: Can be enabled with `auth.allow_anonymous: true` (does not grant management permissions)

### API Key Authentication

```bash
curl -H "X-API-Key: your-api-key" http://localhost:8085/api/v1/streams
```

Invalid or missing API key returns `401 Unauthorized`:
```json
{"error": "unauthorized"}
```

### JWT Token Authentication

For playback and WHIP/WHEP:

```bash
curl -H "Authorization: Bearer eyJ..." http://localhost:8085/player/my-stream
```

### Token Properties

- **Algorithm**: HS256
- **Issuer**: `stremdbc`
- **Subject**: Stream ID
- **Audience**: Stream ID
- **Action**: `publish` or `play`
- **IP Binding**: Client IP is recorded and checked during authorization
- **Expiry**: Configurable (default 24h)

### Security Notes

- JWT secret must be at least 32 characters
- API keys should be long and unique
- `allow_anonymous: false` is recommended for production
- CORS should be restricted to exact trusted origins

---

## 11. Security

### Current Security Posture

| Feature | Status |
|---|---|
| Config validation | Strict YAML, fail closed |
| Path traversal protection | Active on static delivery |
| Input bounds | Stream IDs, file paths validated |
| RTMP media rejection | Audio/video explicitly rejected |
| Token IP binding | Active |
| API key constant-time compare | Active |
| Auth + RTMP mutual exclusion | Enforced |

### Security Checklist for Production

- [ ] Enable authentication and set a random JWT secret (32+ chars)
- [ ] Use long, unique API keys
- [ ] Set `auth.allow_anonymous: false`
- [ ] Restrict CORS to exact trusted origins
- [ ] Put TLS and trusted proxy in front of management plane
- [ ] Keep RTMP/RTSP disabled until publish-token handshake is implemented
- [ ] Keep WebRTC disabled until GO-2026-4479 is resolved
- [ ] Validate third-party interoperability, soak/load behavior, backups, secret rotation
- [ ] Run behind a reverse proxy with rate limiting
- [ ] Rotate JWT secrets and API keys periodically

### Recommended Production Architecture

```
Internet → Cloudflare (TLS, WAF, Access) → Caddy (auth proxy) → streamdbc :8085
                                    ↓
                              Cloudflare Tunnel → streamdbc :1935 (RTMP)
```

---

## 12. Deployment

### Linux (Current Server)

The server is running on the current host:

- **Binary**: `/home/cvsz/streamdbc/stremdbc`
- **Config**: `/home/cvsz/streamdbc/configs/config.zlive.yaml`
- **Secrets**: `/home/cvsz/streamdbc/.env.production` (mode 0600)
- **Ports**: 8085 (HTTP), 1935 (RTMP)
- **Process**: Managed as persistent background process

### Starting the Server

```bash
cd /home/cvsz/streamdbc
export $(cat .env.production | xargs)
./stremdbc -config configs/config.zlive.yaml
```

### Stopping the Server

```bash
kill $(pgrep stremdbc)
```

### Restarting the Server

```bash
kill $(pgrep stremdbc); sleep 1
cd /home/cvsz/streamdbc
export $(cat .env.production | xargs)
./stremdbc -config configs/config.zlive.yaml
```

### Updating Configuration

1. Edit the config file
2. Stop the server
3. Verify config: `./stremdbc -config configs/config.zlive.yaml -validate` (if supported)
4. Restart the server

### Cloudflare + Terraform

DNS for `zlive.zeaz.dev` is managed via Terraform in `/mnt/workspace/zworkforce/infrastructure/terraform/cloudflare/`:

```bash
cd /mnt/workspace/zworkforce/infrastructure/terraform/cloudflare
terraform plan    # Review changes
terraform apply   # Apply DNS record + tunnel route
```

---

## 13. Monitoring

### Health Check

```bash
curl http://localhost:8085/health
```

### Prometheus Metrics

```bash
curl http://localhost:8085/metrics
```

### Stream Statistics

```bash
curl http://localhost:8085/api/v1/stats
```

### Key Metrics to Monitor

- `stremdbc_health_status` — Health status (1 = healthy, 0 = degraded)
- `stremdbc_streams_total` — Total registered streams
- `stremdbc_streams_live` — Currently active streams
- `stremdbc_viewers` — Current viewer count
- `stremdbc_http_requests_total` — API request volume
- `stremdbc_http_request_duration_seconds` — API latency

### Logging

Logs are output to stdout in JSON format (configurable):

```yaml
logging:
  level: "info"       # debug, warn, error, info
  format: "json"      # json or console
  output_path: "stdout" # stdout or file path
```

---

## 14. Troubleshooting

### Server Won't Start

```bash
# Check config file exists and is valid
cat configs/config.zlive.yaml

# Check port availability
ss -tlnp | grep 8085
ss -tlnp | grep 1935

# Check logs
tail -f /tmp/stremdbc.log

# Check if already running
ps aux | grep stremdbc
```

### RTMP Push Fails

- Verify RTMP is enabled in config (`rtmp.enable: true`)
- Verify auth is disabled (`auth.enable: false`) — they are mutually exclusive
- Check port 1935 is listening: `ss -tlnp | grep 1935`
- Check firewall rules allow inbound on port 1935
- Verify stream exists: `curl http://localhost:8085/api/v1/streams`

### HLS Not Generating

- Verify HLS is enabled in config (`hls.enable: true`)
- Check `/tmp/hls/` directory exists and is writable
- Verify media is actually being pushed via RTMP
- Check stream state is not `IDLE`

### Dashboard Returns 404

- Verify dashboard file exists: `ls web/dashboard/index.html`
- Restart the server (static routes are registered at startup)

### API Returns 401

- If auth is enabled, include `X-API-Key` header
- Verify the API key is correct
- Check for typos in the header name (`X-API-Key`, not `X-Api-Key`)

### Port Conflicts

If port 8085 is occupied:

```bash
# Find what's using the port
ss -tlnp | grep 8085

# Use a different port in config
server:
  http_port: 8086
```

---

## 15. Building

### Build Binary

```bash
cd /home/cvsz/streamdbc
make build
```

Output: `stremdbc` (Linux), `stremdbc-windows.exe` (Windows)

### Build for Windows

```bash
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build \
  -trimpath -ldflags="-s -w" \
  -o stremdbc-windows.exe ./cmd/stremdbc
```

### Run Tests

```bash
make test           # Unit tests
make test-race      # Race-enabled tests
make verify         # Full verification gate
```

### Verify Installation

```bash
./stremdbc -version
# Output: STREMDBC v0.6.0
```

---

## 16. Docker

### Build

```bash
docker build --pull -t stremdbc:local .
```

### Run

```bash
docker run --rm -d \
  -p 127.0.0.1:8085:8085 \
  -p 127.0.0.1:1935:1935 \
  --env-file .env \
  --name stremdbc \
  stremdbc:local
```

### Docker Compose

```bash
cp .env.example .env
# Replace all SET_ME values with real secrets
docker compose up -d --build
```

Open `http://localhost:8085/health` and the dashboard at `http://localhost:8085/dashboard/`.

### Docker Volumes

The container expects:
- `/app/configs/` — Configuration files
- `/tmp/hls/` — HLS segments (persisted for viewing)
- `/tmp/recordings/` — Recordings (if recorder enabled)
- `/tmp/dvr/` — DVR segments (if DVR enabled)

---

## Appendix A: File Reference

| Path | Purpose |
|---|---|
| `cmd/stremdbc/main.go` | Entry point and lifecycle orchestration |
| `configs/config.zlive.yaml` | Production configuration |
| `configs/config.dev.yaml` | Development configuration |
| `.env.production` | Secret values (mode 0600) |
| `.env.example` | Docker Compose example |
| `web/dashboard/index.html` | Management dashboard |
| `web/player/index.html` | Stream player |
| `docs/API.md` | Detailed API documentation |
| `Makefile` | Build and verification targets |
| `Dockerfile` | Container build |
| `internal/api/` | HTTP API server |
| `internal/auth/` | JWT and API key management |
| `internal/core/` | Stream registry and ID validation |
| `internal/ingest/` | Protocol adapters (RTMP, RTSP, SRT, WebRTC) |
| `internal/output/` | HLS/LL-HLS writers |
| `internal/recorder/` | FFmpeg recording manager |
| `internal/dvr/` | File-backed DVR manager |
| `internal/transcoder/` | FFmpeg ABR worker pool |
| `internal/metrics/` | Prometheus telemetry |
| `internal/config/` | Configuration loading and validation |

---

## Appendix B: Complete Config Reference

```yaml
# Server settings
server:
  host: "0.0.0.0"           # Listen address
  http_port: 8085            # HTTP port
  read_timeout: 30s          # Request read timeout
  write_timeout: 30s         # Request write timeout
  idle_timeout: 120s         # Connection idle timeout
  stream_ttl: 24h            # Stream record TTL

# RTMP ingest
rtmp:
  enable: false
  host: "0.0.0.0"
  port: 1935
  read_timeout: 30s
  write_timeout: 30s

# RTSP ingest
rtsp:
  enable: false
  host: "0.0.0.0"
  port: 8554
  read_timeout: 30s
  write_timeout: 30s

# SRT metadata
srt:
  enable: false
  host: "0.0.0.0"
  port: 9000
  latency: 200ms
  passphrase: ""

# WebRTC signaling
webrtc:
  enable: false
  host: "0.0.0.0"
  port: 8443
  use_turn: false
  tls_enabled: false
  cert_file: ""
  key_file: ""

# HLS output
hls:
  enable: false
  path: "/tmp/hls"
  segment_duration: 2s
  playlist_size: 5

# LL-HLS output
llhls:
  enable: false
  path: "/tmp/llhls"
  segment_duration: 1s
  part_duration: 200ms
  playlist_size: 10

# API settings
api:
  enable: true
  base_path: "/api/v1"
  cors_origins:
    - "*"

# Authentication
auth:
  enable: true
  jwt_secret: ""
  jwt_expiry: "24h"
  api_keys: []
  allow_anonymous: false

# Metrics
metrics:
  enable: true
  path: "/metrics"

# Logging
logging:
  level: "info"
  format: "json"
  output_path: "stdout"

# Redis (cluster mode)
redis:
  enable: false
  host: "localhost"
  port: 6379
  password: ""
  db: 0
  prefix: "stremdbc:"

# PostgreSQL (not yet implemented)
postgres:
  enable: false
  host: "localhost"
  port: 5432
  user: "stremdbc"
  password: ""
  database: "stremdbc"
  ssl_mode: "disable"

# Cluster
cluster:
  enable: false
  node_id: "stremdbc-node"
  advertise_host: ""
  discovery_addr: ""
  health_check_interval: 5s

# Recording
recorder:
  enable: false
  path: "/tmp/recordings"
  ffmpeg_path: "ffmpeg"

# DVR
dvr:
  enable: false
  path: "/tmp/dvr"
  max_duration: 4h
  format: "mpegts"

# Transcoder
transcoder:
  enable: false
  worker_count: 2
  ffmpeg_path: "ffmpeg"
  gpu_enabled: false
  output_format: "hls"
  abr_ladder:
    - name: "720p"
      width: 1280
      height: 720
      bitrate: 3000000
      frame_rate: 30
      audio_bitrate: 128000
    - name: "480p"
      width: 854
      height: 480
      bitrate: 1500000
      frame_rate: 30
      audio_bitrate: 96000
```

---

## Appendix C: Quick Command Reference

```bash
# Health check
curl http://localhost:8085/health

# Create stream
curl -X POST -H "Content-Type: application/json" \
  -d '{"id":"stream-1","name":"Stream 1"}' \
  http://localhost:8085/api/v1/streams

# List streams
curl http://localhost:8085/api/v1/streams

# Get stream info
curl http://localhost:8085/api/v1/streams/stream-1

# Delete stream
curl -X DELETE http://localhost:8085/api/v1/streams/stream-1

# Get auth token (when auth enabled)
curl -X POST -H "Content-Type: application/json" \
  -H "X-API-Key: your-key" \
  -d '{"stream_id":"stream-1","action":"play"}' \
  http://localhost:8085/api/v1/auth/token

# Push via ffmpeg
ffmpeg -i input.mp4 -c:v libx264 -c:a aac \
  -f flv rtmp://localhost:1935/stream-1

# Watch HLS
open http://localhost:8085/hls/stream-1/index.m3u8

# View metrics
curl http://localhost:8085/metrics

# Check server logs
tail -f /tmp/stremdbc.log
```
