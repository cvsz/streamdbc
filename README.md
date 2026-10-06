# STREMDBC

STREMDBC is a Go streaming management control plane with bounded protocol
adapters, reusable FFmpeg components, and a dedicated Samsung F5500 HLS
capture gateway for vMix External Output on Windows.

## Verified scope

The executable in this checkout is production-hardened as a management and
control service. General RTMP/RTP/libsrt ingest-to-output forwarding is not
included. The Samsung gateway is a separate, concrete capture path from Windows
DirectShow devices to H.264/AAC MPEG-TS HLS.

| Component | Current contract |
|---|---|
| HTTP API, stream registry, auth, metrics | Available and lifecycle-tested |
| HLS and LL-HLS writers | Available as library components; no executable media graph feeds them |
| RTMP ingest | Bounded handshake/control parser; audio/video is rejected explicitly |
| RTSP ingest | Bounded control/session adapter; media description/forwarding is unavailable |
| SRT ingest/output | Metadata guard only; no libsrt transport or media forwarding |
| WHIP/WHEP | SDP peer negotiation and publisher-track detection; RTP forwarding is unavailable |
| RTMP/RTSP outputs | Bounded consumer/control endpoints; no outbound media writer |
| Recorder, DVR, transcoder | Reusable managers; no executable API/media-source wiring |
| Samsung F5500 gateway | vMix DirectShow capture, H.264/AAC HLS, legacy `/tv` pages; requires Windows device and physical TV validation |
| Redis cluster | Redis node registration, heartbeat, discovery, and selection primitives |
| PostgreSQL | Configuration is rejected until schema integration is implemented |

The default configuration keeps all media adapters disabled. Enable an adapter
only after supplying the corresponding production media engine and integration.
The Samsung gateway can be enabled independently with
`configs/samsung-f5500.yaml`.

## Android TV RTSP client

`client/tv` is a native Android TV / Google TV client for direct RTSP playback.
It is intentionally separate from the server media-plane claims above: the TV
app connects directly to an operator-supplied RTSP endpoint.

Current TV baseline:

- Android TV launcher and D-pad-first navigation
- Media3 ExoPlayer RTSP playback using RTP-over-TCP
- multi-channel local list with previous/next channel switching
- exponential reconnect on playback failure
- RTSP URL validation and credential redaction
- encrypted channel storage using Android Keystore AES-GCM
- no plaintext credential logging
- screen-awake playback behavior
- JVM unit tests plus dedicated Android build/lint CI\n- NDI Surface lifecycle synchronization; optional native NDI video receiver remains gated by the licensed SDK

RTSP is not encrypted in transit. For cameras outside a trusted LAN, place RTSP
behind a private VPN such as WireGuard/Tailscale rather than exposing port 554
or 8554 publicly.

Build with JDK 17, Android SDK 36, Gradle 9.6.0 and AGP 9.4.1:

```bash
cd client/tv
gradle --no-daemon :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

The debug APK is produced under `client/tv/app/build/outputs/apk/debug/`.

## Local quick start

Requires Go 1.27 or newer. FFmpeg is required for recorder/transcoder managers
and the Samsung F5500 gateway.

```bash
go test ./...
make verify
go run ./cmd/stremdbc -config configs/config.dev.yaml
```

The development config binds the API to `127.0.0.1` and leaves authentication
off. Do not expose it beyond the local machine.

## Samsung F5500 Wi-Fi Output

The Samsung F5500 Wi-Fi playback gateway receives the vMix Program output on
the Windows host and transcodes it to legacy-compatible H.264/AAC HLS for
playback by the television over the LAN. The television receives HLS; it does
not receive NDI. The default profile is 1280x720 at 30 fps with two-second
MPEG-TS segments and a six-segment playlist. Expected glass-to-glass latency is
about 6–15 seconds.

```text
vMix PC
  ↓ External Output 1 (Program) / vMix Video + vMix Audio
StreamDBC Samsung Gateway / FFmpeg
  ↓ H.264 + AAC MPEG-TS HLS over Wi-Fi
Samsung UA40F5500 browser
```

On the vMix PC, open PowerShell in the repository and set credentials for the
protected gateway start/stop operations:

```powershell
$env:STREMDBC_JWT_SECRET = ((New-Guid).Guid + (New-Guid).Guid)
$env:STREMDBC_API_KEY = ((New-Guid).Guid + (New-Guid).Guid)
go build -o stremdbc.exe ./cmd/stremdbc
.\scripts\windows\samsung-tv-doctor.ps1
.\scripts\windows\samsung-tv-start.ps1
```

The doctor checks FFmpeg, vMix DirectShow devices, LAN/Wi-Fi, firewall scope,
port 8080, credentials, and output-directory access. To add the narrowly scoped
Private-profile TCP 8080 rule, run
`scripts\windows\samsung-tv-firewall.ps1` from elevated PowerShell. Remove it
with `scripts\windows\samsung-tv-firewall.ps1 -Remove`.

Open the printed `http://<PC-LAN-IP>:8080/tv` URL in the television browser.
The direct HLS fallback is
`http://<PC-LAN-IP>:8080/tv/live/index.m3u8`; `/tv/basic` is available when the
browser struggles with the status page. Use
`scripts\windows\samsung-tv-test.ps1` for HTTP, MIME type, and playlist-refresh
checks, and `scripts\windows\samsung-tv-stop.ps1` to stop the gateway. Keep the
PC and TV on the same subnet and disable Wi-Fi client isolation. Physical
UA40F5500 playback and long soak gates are still required before claiming TV
compatibility.

See [`docs/SAMSUNG-F5500.md`](docs/SAMSUNG-F5500.md) for the complete Windows and
TV setup.

## Docker Compose

The production-oriented sample requires injected secrets and exposes host
ports only on loopback by default:

```bash
cp .env.example .env
# Replace every SET_ME/replace-* value with generated secret material.
docker compose up -d --build
```

Open `http://localhost:8080/health` and the authenticated management dashboard
at `http://localhost:8080/dashboard/`. The default `configs/config.yaml`
enables API authentication and expands `STREMDBC_JWT_SECRET` and
`STREMDBC_API_KEY` from the environment. A missing or weak secret prevents
startup.

Optional infrastructure profiles are available, but the application does not
consume PostgreSQL metadata yet:

```bash
docker compose --profile monitoring up -d
docker compose --profile cluster up -d
```

## Management API

```text
GET    /health
GET    /ready
GET    /metrics
GET    /api/v1/info
GET    /api/v1/stats
GET    /api/v1/tv/status
POST   /api/v1/tv/start
POST   /api/v1/tv/stop
POST   /api/v1/tv/restart
GET    /api/v1/streams
POST   /api/v1/streams
GET    /api/v1/streams/:id
DELETE /api/v1/streams/:id
POST   /api/v1/auth/token
```

The base path and metrics path are configurable. Existing management mutations
require `X-API-Key` whenever authentication is enabled. Samsung TV start, stop,
and restart always require a configured management API key.
Playback and WHIP/WHEP requests require stream-scoped JWTs unless anonymous
playback was explicitly enabled.

See [`docs/API.md`](docs/API.md) for request and response details.

## Ports

These are potential listener ports; the shipped configs disable the media
adapters.

| Port | Transport | Purpose |
|---:|---|---|
| 8080 | TCP | API, dashboard, player, and Samsung TV HLS delivery |
| 1935 | TCP | RTMP control adapter |
| 8554 | TCP | RTSP control adapter |
| 9000 | UDP | SRT metadata adapter |
| 8443 | TCP | WHIP/WHEP signaling adapter |
| 1936 | TCP | RTMP output control adapter |
| 8555 | TCP | RTSP output control adapter |
| 9001 | UDP | SRT output metadata adapter |

## Security baseline

- Explicit config files use strict YAML fields, environment expansion, path and listener validation, and fail closed on missing files or unsupported settings.
- The container runs as a non-root user, drops Linux capabilities, and enables `no-new-privileges`.
- JWTs are restricted to HS256, issuer, expiry, stream, action, and optional client-IP binding; API-key comparisons are bounded and constant-time per configured key.
- Static delivery rejects traversal and symlink escapes, and media/control parsers enforce size limits and deadlines.
- RTMP/RTSP ingest is rejected by configuration when authentication is enabled until publish-token enforcement is integrated into those protocols.
- Compose binds host ports to loopback until an operator deliberately changes the exposure policy.
- Android TV channel configuration is encrypted at rest with a non-exportable Android Keystore key; RTSP transport itself remains plaintext unless protected by the network layer.\n- Desktop management API credentials are stored with Electron safeStorage rather than plaintext settings.\n- WebRTC browser access uses an explicit configured CORS allowlist.\n- Management API requests are rate-limited per client and forwarded client-IP headers are accepted only from configured trusted proxies.

## Project structure

```text
cmd/stremdbc/            executable and lifecycle orchestration
configs/                 runtime examples
internal/api/            management HTTP API
internal/gateway/samsung/ vMix External Output to legacy HLS gateway
internal/auth/           JWT and API-key controls
internal/cluster/        Redis coordination primitives
internal/core/           stream registry and safe identifiers
internal/dvr/            file-backed DVR manager
internal/ingest/         bounded protocol adapters
internal/output/         HLS/LL-HLS and output adapters
internal/recorder/       FFmpeg recording manager
internal/transcoder/     FFmpeg ABR worker pool
internal/metrics/        Prometheus telemetry
web/                     zero-build dashboard and player
client/                  desktop client
client/tv/               native Android TV RTSP client
deployments/             deployment assets
.github/workflows/       CI and CodeQL definitions
```

## Release gates

Local checks are reproducible with `make verify` and include formatting,
module verification/tidiness, race tests, `staticcheck`, `gosec`, `go vet`,
and a trimmed build.
Hosted CI/CodeQL execution, Android CI, container registry publication,
third-party protocol interoperability, real ingest-to-HLS/WebRTC forwarding,
soak/load testing, TURN/TLS public-network validation, device-level Android TV
playback validation, and secret-manager integration remain external release
gates. This checkout does not claim those gates are complete.

## Repository

Canonical repository: https://github.com/cvsz/streamdbc

## License

MIT License
