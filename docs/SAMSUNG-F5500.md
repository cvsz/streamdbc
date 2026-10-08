# Samsung UA40F5500 Wi-Fi Playback

This guide covers both Samsung UA40F5500/Y2013 playback and fleet control.
StreamDBC can capture vMix Output 1 (Program) and create H.264/AAC MPEG-TS HLS,
while the Windows Single Control Panel discovers Samsung TVs over SSDP and
controls their advertised UPnP services. The TV does not receive or need NDI
directly.

The supported server profile is 1280x720, 30 fps, H.264 Main level 3.1,
yuv420p, AAC-LC stereo at 48 kHz, two-second MPEG-TS segments, and a six-entry
playlist. Typical glass-to-glass latency is approximately 6–15 seconds. The
optional 1080p profile has not been validated on the UA40F5500.

DirectShow negotiates the frame rate exposed by the vMix device; the gateway
then encodes the selected profile frame rate. This supports vMix outputs that
offer 60 fps even when the Samsung profile is 30 fps.

## 0. Control paths

There are two supported operator paths:

1. **Browser/HLS path** — open `/tv/` or `/tv/basic` manually on the TV.
2. **UPnP fleet path** — use the Windows Single Control Panel to discover the
   TV and invoke AVTransport/RenderingControl.

For the UPnP path, endpoint numbers are deliberately not hard-coded. The same
UA40F5500 family has been observed with different AVTransport control URLs such
as `/smp_46_`, `/smp_24_`, and `/smp_22_`. The controller therefore
discovers:

```text
SSDP → LOCATION → service list → SCPD → controlURL → SOAP
```

A single physical TV may advertise separate SSDP descriptions for
MediaRenderer, MainTVServer2, DIAL, and remote-control services. The Control
Panel merges these descriptions into one fleet entry.

Primary fleet service priority:

1. DLNA/UPnP AVTransport
2. RenderingControl
3. Samsung MainTVAgent2 as optional/fallback
4. DIAL / MultiScreen discovery as optional capabilities

`MainTVAgent2` actions are not assumed to work merely because they appear in
SCPD. Real F5500 firmware may return UPnP `501 Action Failed`.

## 1. Requirements

- Windows PC running vMix and StreamDBC.
- FFmpeg on `PATH`, built with DirectShow input and `libx264` and AAC encoders.
- vMix External Output enabled, exposing `vMix Video` and `vMix Audio`.
- Samsung UA40F5500 and PC on the same LAN/subnet. Disable access-point client
  isolation so the TV can reach the PC.
- Windows network profile set to Private and inbound TCP 8081 permitted on the
  Private profile only.
- Go 1.27+ to build StreamDBC, or a `stremdbc.exe` binary in the repository
  root.

The F5500 profile uses API-key-protected gateway controls and anonymous LAN
playback. Keep port 8081 on a trusted private network. Set credentials in the
PowerShell session that starts StreamDBC:

```powershell
$env:STREMDBC_JWT_SECRET = ((New-Guid).Guid + (New-Guid).Guid)
$env:STREMDBC_API_KEY = ((New-Guid).Guid + (New-Guid).Guid)
```

The JWT secret must be at least 32 characters. The API key is required by the
gateway start/stop/restart endpoints.

## 2. Enable vMix External Output

The vMix guide calls the main control **External**. Click the gear/cog next to
the **External** button and choose **Settings** to open External Output
Settings. Configure Output 1 to use the **vMix Video / Streaming** device, then
click the **External** button next to the gear to start the output. Output 1 is
the vMix Program feed and is the source used by External 1.

Use the vMix master frame rate and an output size at least 1280x720. The
gateway captures the Program video and master audio through the separately
enumerated `vMix Video` and `vMix Audio` devices. The DirectShow device names
are configurable in `configs/samsung-f5500.yaml` if the installed vMix version
shows different labels.

Terminology and controls are documented in the [vMix External Output guide](https://www.vmix.com/help27/ExternalOutput1.html), [vMix External Output settings](https://trail.vmix.com/help27/ExternalOutput.html), and [vMix Outputs / NDI settings guide](https://www.vmix.com/help27/SettingsOutputs.html). The **Outputs / NDI** page is not where the primary External button is started.

Optional starter preset: `docs/streamdbc.vmix` opens vMix with one Blank
program input on Preview/Program and all outputs stopped. It uses only the
officially documented preset vocabulary; External device, frame rate, output
size, and starting External are still configured here, not in the preset.
`scripts/windows/samsung-vmix-setup.ps1` applies everything the vMix API
allows (transition, preview/program input, master audio, External start)
and verifies it; run it after opening the preset.

## 3. Start StreamDBC

From the repository root in PowerShell:

```powershell
go build -o stremdbc.exe ./cmd/stremdbc
.\scripts\windows\samsung-tv-doctor.ps1
.\scripts\windows\samsung-tv-start.ps1
```

The doctor reports actionable PASS/FAIL checks for Windows, an active LAN and
Wi-Fi interface, Private network category, FFmpeg, vMix, both DirectShow
devices, TCP 8081, the scoped firewall rule, credentials, and output-directory
writability.

To add the inbound firewall rule, open PowerShell as Administrator and run:

```powershell
.\scripts\windows\samsung-tv-firewall.ps1
```

This creates an idempotent inbound allow rule for TCP 8081 on the Private
profile only. Remove it with:

```powershell
.\scripts\windows\samsung-tv-firewall.ps1 -Remove
```

The gateway starts with the server because `samsung_tv.enable` is true in the
sample profile. Startup waits for FFmpeg to create a readable playlist and
retries the source with bounded exponential backoff if FFmpeg exits.

## 4. Find the Windows LAN IP

The start script prints the preferred active LAN address. You can also inspect
addresses and test the local listener with PowerShell:

```powershell
Get-NetIPAddress -AddressFamily IPv4
Test-NetConnection -ComputerName 127.0.0.1 -Port 8081
```

The TV and PC must be on the same subnet. The preferred hostname is
`ztv.zeaz.dev`, currently mapped to `192.168.1.100`. If the router or TV blocks
a public DNS name resolving to an RFC1918 address, configure split DNS/local DNS
for `ztv.zeaz.dev -> 192.168.1.100` or use the direct LAN-IP fallback.
Confirm that the active network is
Private and that the router has no client/AP isolation. If needed, run
`Test-NetConnection -ComputerName <PC-LAN-IP> -Port 8081` from another Windows
device on the same Wi-Fi network.

## 5. Open the Samsung browser

On the TV, open its browser and enter the URL printed by the start script:

```text
http://ztv.zeaz.dev:8081/tv/
```

The direct native HLS fallback is:

```text
http://ztv.zeaz.dev:8081/tv/live/index.m3u8
```

For codec troubleshooting, use the static compatibility clip at
`http://<PC-LAN-IP>:8081/tv/test.mp4`. It is a short 720p H.264 Baseline and
AAC-LC test pattern, independent of vMix and the live HLS gateway. The TV must
be able to reach the PC's current LAN IP on port 8081.

The basic page at `/tv/basic` contains only a video element and is useful when
the legacy browser cannot run the status-page JavaScript. The page uses plain
ES5 JavaScript and does not use HLS.js, modules, fetch, promises, CSS Grid, or
external scripts.

## 6. Fullscreen playback

The default /tv page is kiosk-style: video fills the viewport, browser controls
are omitted, and playback starts automatically when firmware policy allows it.
ENTER/PLAY/PAUSE/RED retries playback if autoplay is blocked or the HLS stream
temporarily drops. A Samsung Legacy launcher app can navigate directly to
http://ztv.zeaz.dev:8081/tv/ so no iframe or browser address bar is required.

## 7. Stop, restart, and test

Stop only the FFmpeg gateway while leaving the StreamDBC HTTP server available:

```powershell
.\scripts\windows\samsung-tv-stop.ps1
```

Run the HTTP checks from the PC:

```powershell
.\scripts\windows\samsung-tv-test.ps1
```

The script verifies health, `/tv`, gateway status, playlist and segment
availability, MIME types, and playlist updates. It does not verify TV decode,
audio, fullscreen, recovery through a Wi-Fi outage, browser stability, or a
long-running soak.

## 8. Troubleshooting

- If `vMix Video` or `vMix Audio` is missing, start vMix External Output and
  rerun `samsung-tv-doctor.ps1`. The doctor prints FFmpeg's DirectShow device
  list; it never selects a random device.
- If the page opens but video does not, try `/tv/basic`, then open the direct
  HLS URL. Confirm `/api/v1/tv/status` reports `live` and `playlist_ready`.
- If the TV cannot connect, verify the PC's LAN IP, same subnet, Private
  network profile, TCP 8081 rule, and router client-isolation setting.
  A plain-text `GET /tv/ping` (expect `pong`) checks basic reachability
  before involving HLS at all.
- If decode is unstable, edit the profile to use a lower video bitrate while
  retaining 1280x720, 25/30 fps, H.264 Main/Baseline-compatible output,
  AAC-LC, and two-second MPEG-TS segments. Re-run config validation and the
  synthetic FFmpeg test before another TV attempt.
- If audio triggers playback failure, test video-only as a diagnostic, then
  restore AAC-LC and retest. Do not treat video-only as the delivered profile.
- To inspect the output with a PC player, run
  `ffprobe -show_streams -show_format <segment.ts>` on a generated segment.

## Verification boundary

Repository unit and synthetic FFmpeg integration checks can verify argument
construction, H.264/AAC codecs, 720p yuv420p, MPEG-TS, playlist version 3, HTTP
routes, MIME types, and lifecycle behavior. Only physical testing can establish
whether the UA40F5500 browser decodes the stream and remains stable. Record the
following before claiming device compatibility:

- page and HLS load, live image and audio, fullscreen playback;
- recovery after vMix stop/start and a Wi-Fi interruption;
- no browser crash during a 30-minute initial soak;
- two-hour and four-hour soak results, CPU/RAM, FFmpeg restart count, segment
  generation, and Wi-Fi recovery behavior.

Until those observations are recorded, Samsung UA40F5500 playback is an
unverified physical-device gate.

## Authentication note

The Samsung F5500 browser client cannot send JWT credentials, so StreamDBC
forces `auth.allow_anonymous: true` whenever the Samsung TV gateway is
enabled. That means playback endpoints (HLS/LL-HLS static routes and
play tokens) accept anonymous viewers. Any deployment of the F5500 profile
should therefore be confined to a trusted network segment, and mutations
(`/tv/start`, `/tv/stop`, `/tv/restart`, stream management) remain protected
by the management API key / JWT. Ingest publish and output play endpoints
still require valid tokens because they are separate authenticated surfaces.


## 9. Single Control Panel fleet workflow

Use the Windows Control Panel v1.4.0 Samsung TV view.

1. Start or verify the StreamDBC server and FFmpeg runtime.
2. Click **Discover TVs**.
3. Confirm each expected UA40F5500 appears with AVTransport.
4. Enter the media URL that the TVs can reach from the LAN.
5. Use **Play URL** per TV or **Play URL on All**.
6. Use **Refresh State** to read transport, volume and mute status.
7. Use **Stop**, **Set Vol**, **Mute/Unmute**, or the all-TV equivalents.

A typical live URL is:

```text
http://<streamdbc-lan-ip>:8081/tv/live/index.m3u8
```

Do not assume HLS is accepted by AVTransport until the physical TV confirms it.
For compatibility testing, start with a known-good HTTP MP4, then test MPEG-TS
and HLS.

### Current fleet behavior validated by discovery

The current UA40F5500 fleet exposes MediaRenderer, AVTransport,
RenderingControl, ConnectionManager, MainTVAgent2, and DIAL-family services.
The exact `/smp_*` numbers vary by device.

### Production acceptance

Fleet discovery alone is not sufficient to claim production playback. Record
evidence for:

- `SetAVTransportURI` HTTP success;
- `Play` HTTP success;
- `GetTransportInfo = PLAYING`;
- visible video and audible audio on every TV;
- simultaneous five-TV fan-out;
- TV reboot and endpoint rediscovery;
- source loss/recovery;
- Wi-Fi interruption recovery;
- latency, CPU/RAM and soak duration.
