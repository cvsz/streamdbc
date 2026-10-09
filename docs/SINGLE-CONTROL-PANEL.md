# StreamDBC Windows Single Control Panel

**Workspace package target:** 1.4.1 (unreleased; current changes are not built)

**Updated:** 2026-10-09

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
- Switch to connected HDMI input
- Stop
- set volume
- mute/unmute
- refresh transport/input/volume/mute state

Fleet-wide:

- Play URL on All
- Switch All to HDMI
- Start Samsung Mode (MP4 baseline, then open the live browser page per TV)
- Stop All
- Mute All
- Unmute All

The primary media-control path is DLNA/UPnP AVTransport. RenderingControl is
used for volume/mute. Samsung MainTVAgent2 is discovered but treated as
optional because supported actions may still return UPnP 501 at runtime.

HDMI switching uses `GetSourceList`, `SetMainTVSource` and
`GetCurrentExternalSource` only when the TV advertises all three actions. The
controller chooses the first HDMI input reported as connected, uses that TV's
runtime source IDs, and reports success only when read-back confirms the same
input. It does not send blind remote-key sequences. The latest operation
confirmed all five TVs by read-back: TV-81/82/89/91 on HDMI1 and TV-90 on
HDMI2. The operator previously confirmed an HDMI picture on all five.

## Current workspace status

The MP4 baseline was accepted by all five TVs, and the operator confirmed
picture and audio on all five. The latest `RunBrowser` command was acknowledged
by all five, but the operator reported that the Live Browser page showed
`Offline`. PC-side HLS readiness and a SOAP acknowledgement do not prove TV
playback. Track the exact per-TV outcome in
[`SAMSUNG-CURRENT-STATUS.md`](SAMSUNG-CURRENT-STATUS.md).

An earlier attempt to send the HLS playlist through AVTransport failed on all
five TVs with `Illegal MIME-type`. Keep that result separate from MP4 playback
and browser playback.

The source also contains a shutdown guard for the reported `Tray is destroyed`
exception. It has not been rebuilt into the installed Windows app or verified
at runtime yet.

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
8. Use **Start Samsung Mode** to run the MP4 baseline, then open `/tv/` in the
   TV browser; verify the actual screen and sound.
9. Use **Switch All to HDMI** when the connected HDMI input is needed, then
   refresh input state.
10. Use **Play URL** or **Play URL on All** only for media accepted by the TV.
11. Refresh state and verify AVTransport state where applicable; browser
    playback still requires physical observation.
12. Use Stop/Volume/Mute controls as needed.

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

Current status: five-TV HDMI source read-back and MP4 picture/audio are
confirmed; Live Browser playback is unresolved. The complete evidence table and
next checklist are in [`SAMSUNG-CURRENT-STATUS.md`](SAMSUNG-CURRENT-STATUS.md).

See also:

- `SAMSUNG-F5500.md`
- `USER-MANUAL.md`
- `API.md`

## Branding

The Windows application icon is generated reproducibly from the Zeazdev logo source embedded in `client/scripts/generate-windows-icon.js`. The build writes `client/assets/apps.ico`, and electron-builder applies it to the application executable, NSIS installer, uninstaller, portable build, main window and tray icon.
