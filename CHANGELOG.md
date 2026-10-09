# Changelog

All notable StreamDBC changes are recorded here.

## Unreleased — 2026-10-09

### Added

- Samsung fleet controls in the workspace can open the live TV browser and
  switch known TVs to a connected HDMI input using Samsung source discovery and
  read-back verification.
- Added a current Samsung hardware status and ordered follow-up checklist in
  `docs/SAMSUNG-CURRENT-STATUS.md`.

### Fixed

- Guard Control Panel tray-menu updates during shutdown after the tray has been
  destroyed while the managed server process is exiting.

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
