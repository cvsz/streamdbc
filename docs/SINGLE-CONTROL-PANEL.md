# StreamDBC Windows Single Control Panel

**Version:** 1.4.0  
**Updated:** 2026-10-08

The Windows Single Control Panel combines StreamDBC server/runtime operations,
the bundled FFmpeg runtime, Samsung gateway management, LAN/DNS operations and
Samsung UA40F5500 fleet control in one Electron application.

## Scope

The Samsung TV view contains:

- StreamDBC server start / restart / stop
- server executable/config/runtime source status
- bundled FFmpeg version/path/capability status
- Samsung media-gateway start / restart / stop
- Windows Doctor
- repository rebuild and USB staging tasks
- LAN IPv4 detection
- Cloudflare LAN-DNS update
- Samsung TV fleet discovery and control

## Samsung fleet architecture

```text
Windows LAN interface
        ↓
SSDP M-SEARCH 239.255.255.250:1900
        ↓
Samsung SSDP responses
        ↓
LOCATION device descriptions
        ↓
merge descriptions by TV/IP
        ↓
AVTransport + RenderingControl + MainTVAgent2 + other capabilities
        ↓
Control Panel
```

The implementation is discovery-driven. It never assumes that a particular
`/smp_*` number is universal.

A single television may publish separate descriptions for MediaRenderer,
MainTVServer2, DIAL and RemoteControlReceiver. The controller merges these
before rendering one fleet row.

## Available controls

Per TV:

- Play URL
- Stop
- set volume
- mute/unmute
- refresh transport/volume/mute state

Fleet-wide:

- Play URL on All
- Stop All
- Mute All
- Unmute All

The primary media-control path is DLNA/UPnP AVTransport. RenderingControl is
used for volume/mute. Samsung MainTVAgent2 is discovered but treated as
optional because supported actions may still return UPnP 501 at runtime.

## Media URL

The media URL must be reachable by the TV itself.

Typical local URL:

```text
http://<streamdbc-lan-ip>:8081/tv/live/index.m3u8
```

For first physical playback validation, use a known-good HTTP MP4 before
testing MPEG-TS/HLS live delivery.

## Security boundary

The renderer does not send arbitrary SOAP endpoints.

The Electron main process:

1. discovers TVs through SSDP;
2. keeps the discovered fleet in memory;
3. accepts control actions only for a TV already in that fleet;
4. validates service URLs as private IPv4 HTTP endpoints;
5. checks the service URL host matches the SSDP responder;
6. limits known legacy UPnP discovery/control ports to 80 and 7676.

This prevents the fleet feature from becoming a general-purpose network
request proxy.

## Build

```powershell
cd client
npm ci
npm run build:win
```

The Windows build produces NSIS and portable artifacts. The Desktop workflow
checks:

- npm audit
- vendored HLS.js
- JavaScript syntax, including `samsung-fleet.js`
- packaged StreamDBC server runtime
- bundled FFmpeg / ffprobe
- required FFmpeg libx264, AAC, HLS and RTMP capabilities

## Operator flow

1. Launch StreamDBC Control Panel.
2. Open **Samsung TV**.
3. Verify **Server** and **FFmpeg Runtime**.
4. Start the Samsung gateway if required.
5. Click **Discover TVs**.
6. Confirm expected TVs and AVTransport capability.
7. Enter a reachable media URL.
8. Use per-TV **Play URL** or **Play URL on All**.
9. Refresh state and verify `PLAYING`.
10. Use Stop/Volume/Mute controls as needed.

## Current production boundary

CI/build success confirms the application packages and static checks pass. It
does not by itself prove physical TV playback.

Before production sign-off, record evidence for:

- every intended UA40F5500 discovered;
- `SetAVTransportURI` succeeds;
- `Play` succeeds;
- `GetTransportInfo` reports `PLAYING`;
- visible video/audio;
- all-TVs fan-out;
- TV reboot and rediscovery;
- source loss/recovery;
- Wi-Fi interruption/recovery;
- latency and multi-hour soak.

See also:

- `SAMSUNG-F5500.md`
- `USER-MANUAL.md`
- `API.md`

## Branding

The Windows application icon is generated reproducibly from the Zeazdev logo source embedded in `client/scripts/generate-windows-icon.js`. The build writes `client/assets/apps.ico`, and electron-builder applies it to the application executable, NSIS installer, uninstaller, portable build, main window and tray icon.
