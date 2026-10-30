# AGENTS.md — StreamDBC Repository

This file provides context for AI agents working on the StreamDBC codebase.

## Repository Overview

StreamDBC is a Go streaming management control plane with bounded protocol adapters, reusable FFmpeg components, a dedicated Samsung F5500 media gateway, and a Windows Single Control Panel for server/runtime operations and discovery-driven Samsung TV fleet control.

Module: `github.com/cvsz/stremdbc`
Go version: 1.27+

## Key Directories

| Directory | Purpose |
|-----------|---------|
| `cmd/stremdbc/` | Executable and lifecycle orchestration |
| `configs/` | Runtime example YAML configs |
| `internal/api/` | Management HTTP API (health, streams, auth, Samsung TV) |
| `internal/auth/` | JWT and API-key controls |
| `internal/gateway/samsung/` | vMix External Output to legacy HLS gateway (FFmpeg supervisor) |
| `internal/cluster/` | Redis coordination primitives |
| `internal/core/` | Stream registry and safe identifiers |
| `internal/dvr/` | File-backed DVR manager |
| `internal/ingest/` | Bounded protocol adapters (RTMP, RTSP, SRT, WebRTC) |
| `internal/output/` | HLS/LL-HLS and output adapters |
| `internal/recorder/` | FFmpeg recording manager |
| `internal/transcoder/` | FFmpeg ABR worker pool |
| `internal/metrics/` | Prometheus telemetry |
| `internal/fsutil/` | Safe directory operations |
| `web/` | Zero-build dashboard and player |
| `client/` | Desktop Windows Single Control Panel |
| `client/tv/` | Native Android TV RTSP client |
| `scripts/windows/` | Windows PowerShell installer/builder scripts |
| `deployments/` | Deployment assets |
| `.github/workflows/` | CI, CodeQL, desktop, Windows server build, Samsung TV, Android TV |

## Verification Commands

| Purpose | Command |
|---------|---------|
| Format check | `gofmt -l .` |
| Vet | `go vet ./...` |
| Unit tests (race) | `go test -race -count=1 ./...` |
| Full verify gate | `make verify` |
| Build binary | `go build -trimpath -o /tmp/stremdbc ./cmd/stremdbc` |
| Module verify | `go mod verify` |
| Module tidy | `go mod tidy -diff` |

## CI Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | push/PR to main | Go test, vet, build, govulncheck, staticcheck, gosec |
| `codeql.yml` | push/PR to main | CodeQL security analysis |
| `desktop.yml` | push/PR to main | npm audit, JS syntax checks, Windows installer build |
| `windows-server-build.yml` | push/PR to main | Windows stremdbc.exe build |
| `samsung-tv.yml` | push/PR to main | Samsung gateway Go + FFmpeg integration tests |
| `android-tv.yml` | push/PR to main | Android TV unit tests and lint |

## Security

- GPG signing is configured: `commit.gpgsign = true`
- Signing key: `A9294A891FF0502217B7EDF1CE99AB5D660D619F`
- `.env` must never be committed (see `.gitignore`)
- API authentication: JWT HS256, API-key constant-time comparison
- Path traversal protection on all static file handlers

## Git Workflow

1. Create feature branch from `main`
2. Implement changes
3. Run `make verify` locally
4. Commit (GPG-signed if environment supports pinentry)
5. Push and open Pull Request
6. Independent review by `policedbc`
7. Merge by `cvsz`

## Known Limitations

- Samsung F5500 live browser playback is not physically verified
- PostgreSQL schema integration is not yet implemented
- RTMP/RTSP/SRT media forwarding is not yet implemented
- Real device-level Android TV playback validation is external
