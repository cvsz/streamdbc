# Changelog

All notable StreamDBC changes are recorded here.

## 0.6.1 — 2026-10-18

### Added

- Samsung TV remote power in the Windows Control Panel: per-TV and fleet-wide
  Power Off via the legacy Samsung WebSocket remote (TCP 7676, `KEY_POWER`,
  post-off LAN confirmation) and Power On via Wake-on-LAN (ARP-sourced MAC,
  reachability polling). New `client/samsung-fleet-remote.js` module with
  unit tests covering WebSocket framing, magic packets, ARP parsing and
  private-LAN validation.

### Security

- Control Panel IPC handlers no longer forward the stored management API key
  to a renderer-supplied origin: every management request now resolves against
  the configured server only.
- `X-Forwarded-For` is honoured only from configured trusted proxies and is
  parsed right-to-left, so client-controlled hops can no longer spoof the
  per-client rate limiter or IP-bound token validation.
- Rate limiter memory is hard-capped at 65,536 entries, IPv6 sources are
  grouped by /64, and expired-entry sweeps run at most every 30 seconds.
- Web player: removed the third-party ad script and pinned hls.js 1.5.17 with
  a SHA-384 subresource-integrity hash; the player window now rejects
  top-level navigation.
- Docker runtime: `/app` stays root-owned and read-only for the service user;
  compose adds log rotation, resource limits, a Redis healthcheck and dropped
  container capabilities.
- `/auth/token` accepts an optional explicit `ip` so a token minted on an
  admin machine validates on an encoder on a different LAN address; the
  default IP binding behaviour is unchanged.
- README: fixed stray literal `\n` sequences so the hardening lists render
  correctly.

## 0.6.0 — 2026-10-18

### Added

- Samsung fleet controls in the workspace can open the live TV browser and
  switch known TVs to a connected HDMI input using Samsung source discovery and
  read-back verification.
- Added a current Samsung hardware status and ordered follow-up checklist in
  `docs/SAMSUNG-CURRENT-STATUS.md`.

### Fixed

- Guard Control Panel tray-menu updates during shutdown after the tray has been
  destroyed while the managed server process is exiting.
- Guarantee Samsung Gateway FFmpeg cleanup when the supervisor exits: deferred
  cleanup reaps the child through a graceful stdin stop, interrupt, two-second
  grace, and force kill, guarded by `ProcessState == nil` to avoid a double
  `Wait`; `Stop()` no longer cancels while holding the state read lock (#50).

### Validation and release state

- All five TVs returned HDMI input read-back; the operator previously confirmed
  HDMI picture on all five. MP4 picture and audio were confirmed on all five.
- The live browser still reports `Offline` despite an advancing HLS playlist
  and five acknowledged `RunBrowser` commands.
- Sending the HLS playlist through AVTransport returned `Illegal MIME-type`
  on all five TVs; the MP4 and browser paths are separate.
- These workspace changes have not been packaged or installed. The close fix
  still needs a native Windows rebuild and runtime verification.

## 1.4.0 — 2026-10-08

### Added

- Zeazdev-branded Windows `apps.ico` generation and installer/application icon wiring.
- `scripts/windows/full-build-installer.ps1` one-command Windows build, verification, SHA256 and build-manifest pipeline.

- Windows Single Control Panel Samsung fleet section.
- SSDP discovery bound to the active private LAN interface.
- Dynamic Samsung device/service/SCPD discovery.
- Multi-LOCATION merge for Samsung MediaRenderer/MainTVServer/DIAL services.
- AVTransport Play URL / Play / Pause / Stop support.
- RenderingControl volume and mute support.
- Play All / Stop All / Mute All / Unmute All.
- Transport/volume/mute fleet state refresh.
- `client/samsung-fleet.js` packaged with Electron.
- Desktop CI syntax verification for the fleet controller.
- `docs/SINGLE-CONTROL-PANEL.md` runbook.

### Security

- TV actions are limited to the current SSDP-discovered fleet.
- UPnP service URLs are restricted to private IPv4 HTTP endpoints.
- Service endpoint hosts must match the SSDP responder.
- Renderer code cannot supply arbitrary SOAP control URLs.

### Documentation

- Reconciled README, User Manual, Samsung F5500 guide and API documentation.
- Documented dynamic `/smp_*` discovery requirements.
- Documented distinction between browser/HLS playback and UPnP fleet control.
- Added physical-device production acceptance gates.

### Validation

PR #36 has passed:

- Windows Server Build
- Samsung TV Gateway
- main CI including Go race tests
- CodeQL
- Desktop npm/package checks
- Windows installer and portable build

Physical Samsung playback and soak testing remain external acceptance gates.

## 1.3.0 — 2026-10-07

- Bundled verified Windows FFmpeg runtime.
- Added FFmpeg source/path/version/capability status.
- Added installed Control Panel Doctor support.
- Improved Windows rebuild portability and bundled runtime preparation.
