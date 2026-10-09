# STREAMDBC — Samsung F5500 Wi-Fi TV Output
## End-to-End Codex Master Implementation Prompt

You are the primary production engineer for:

Repository:
`https://github.com/cvsz/streamdbc`

Owner:
`cvsz`

Target branch:
`feat/samsung-f5500-wifi-hls`

Base branch:
`main`

Primary target TV:
`Samsung UA40F5500`
Samsung F-series, approximately 2013, legacy Samsung Smart TV platform.

Primary source:
`vMix running on Windows`

Primary user goal:

> Display the live vMix Program output on the Samsung UA40F5500 over Wi-Fi, with no Android TV box, no HDMI cable from the PC, and no requirement to install an Android APK on the Samsung TV.

Do not attempt to install Android APKs on the Samsung TV.

Do not spend time building a Samsung Legacy Smart TV application unless every browser/HLS approach has been proven impossible.

The shortest reliable architecture is the priority.

## Current execution checkpoint — 2026-10-09

Read [`docs/SAMSUNG-CURRENT-STATUS.md`](docs/SAMSUNG-CURRENT-STATUS.md) before
resuming. It supersedes older branch, port, build and hardware-status
assumptions in this historical implementation prompt.

- The current checkout is on `fix/client-close-exit-status` with pre-existing
  uncommitted work. Preserve it; do not reset or switch branches.
- The Samsung profile serves `/tv/` and HLS on HTTP port 8081. This checkout's
  Samsung source is DirectShow `vMix Video` + `vMix Audio`; RTMP media ingest
  on port 1935 is not implemented here.
- The server reported a live, advancing HLS playlist and HTTP 200 for a current
  segment. Five TVs accepted the MP4 URI/Play command; the operator confirmed
  MP4 picture and sound on all five.
- Five `RunBrowser` commands were acknowledged, but the operator reported the
  Live Browser page as `Offline`. Live browser HLS video/audio remain
  unresolved.
- All five TVs returned HDMI source read-back (TV-81/82/89/91 HDMI1; TV-90
  HDMI2). The operator previously confirmed an HDMI picture on all five.
- The reported tray shutdown exception has a source fix in the workspace. The
  Windows app has not been rebuilt or runtime-verified with that fix.

Continue with the ordered actions in the status file: rebuild and verify the
close fix on Windows, diagnose the browser's `Offline` result on one TV, prove
live video/audio, then repeat across the fleet and complete soak/recovery work.

---

# 0. FINAL TARGET ARCHITECTURE

Implement and validate this path:

```text
vMix Program Output
        |
        | vMix External Output
        | video device: "vMix Video"
        | audio device: "vMix Audio"
        v
StreamDBC Samsung Gateway
        |
        | FFmpeg
        | H.264 AVC
        | AAC-LC
        | MPEG-TS HLS
        v
HTTP Server on Windows PC
        |
        | Wi-Fi / same LAN
        v
Samsung UA40F5500 browser/player
        |
        v
Fullscreen live video
```

Preferred playback URL:

```text
http://<WINDOWS-PC-LAN-IP>:8081/tv
```

Direct HLS fallback:

```text
http://<WINDOWS-PC-LAN-IP>:8081/tv/live/index.m3u8
```

Example:

```text
http://192.168.1.50:8081/tv
```

This implementation should not depend on NDI support inside the television.

---

# 1. OPERATING RULES

Work autonomously.

Do not ask for confirmation for ordinary implementation decisions.

Do not stop after writing documentation.

Implement actual source code, scripts, tests, CI, and documentation.

Do not force-push.

Do not force-merge.

Do not bypass failing required checks.

Do not claim something works unless there is evidence.

Use branches and pull requests.

Preserve existing repository architecture where practical.

Maintain backwards compatibility for:

- management API
- Android TV client
- existing HLS library
- existing player/dashboard
- existing authentication
- existing Docker/runtime configuration

Technical implementation/code/config must be in English.

Final operational report may be in Thai.

---

# 2. FIRST: RECONCILE CURRENT REPOSITORY STATE

Before editing anything:

1. Fetch latest `main`.
2. Inspect all open pull requests.
3. Inspect latest CI/CodeQL/Desktop/Android workflow results.
4. Detect whether branch:

```text
feat/samsung-f5500-wifi-hls
```

already exists.

5. If it exists, continue from it safely.
6. If not, create it from latest `main`.
7. Never overwrite newer work.

Audit these areas:

```text
cmd/stremdbc/
internal/api/
internal/config/
internal/output/hls/
internal/transcoder/
internal/recorder/
web/
client/
.github/workflows/
configs/
deployments/
scripts/
docs/
Makefile
Dockerfile
docker-compose.yml
```

Also inspect:

```text
web/dashboard/index.html
web/player/index.html
internal/api/server.go
internal/output/hls/manager.go
internal/output/hls/manager_test.go
cmd/stremdbc/main.go
configs/config.yaml
configs/config.dev.yaml
```

Produce a short internal implementation plan, then proceed immediately.

---

# 3. IMPORTANT EXISTING PROJECT FACTS

Do not regress existing production hardening.

Current repository is expected to already include some or all of:

- Go CI
- CodeQL
- `govulncheck`
- `staticcheck`
- `gosec`
- `go vet`
- race tests
- Trivy
- CycloneDX SBOM
- desktop CI
- npm lockfile
- Electron `safeStorage`
- WebRTC CORS allowlist
- trusted proxy support
- API rate limiting
- Android TV RTSP support
- Android NDI lifecycle hardening
- Dependabot

Verify rather than assume.

Do not remove these.

---

# 4. DO NOT USE NDI AS THE TV-SIDE PROTOCOL

The Samsung UA40F5500 is too old for our Android receiver and does not provide a practical NDI runtime.

The TV-facing protocol should be legacy-compatible HLS:

```text
H.264 video
AAC-LC audio
MPEG-TS segments
HLS playlist version 3
```

Prefer broad 2013-era compatibility over low latency.

Initial target:

```text
1280x720
30 fps
H.264 Baseline profile
level 3.1
AAC-LC stereo
48 kHz
2-second MPEG-TS segments
6-segment playlist
```

Provide an optional 1080p profile only after 720p works.

---

# 5. VMIX SOURCE STRATEGY

The implementation must support vMix using Windows External Output.

Primary expected devices:

```text
video:
vMix Video

audio:
vMix Audio
```

Do not hardcode these without discovery/fallback.

Add device enumeration commands/scripts using FFmpeg DirectShow:

```powershell
ffmpeg -hide_banner -list_devices true -f dshow -i dummy
```

Provide helper scripts that detect likely:

```text
vMix Video
vMix Audio
```

If not found, print detected devices clearly.

Do not silently select random capture devices.

---

# 6. CREATE SAMSUNG GATEWAY COMPONENT

Add a dedicated implementation, preferably:

```text
internal/gateway/samsung/
```

or another architecture-consistent location.

Responsibilities:

- start FFmpeg process
- capture vMix Video + vMix Audio
- transcode into Samsung-compatible HLS
- write HLS files into an isolated directory
- track process state
- restart FFmpeg after unexpected exit
- bounded exponential backoff
- gracefully stop on server shutdown
- expose health/state
- redact device/source details from sensitive logs where appropriate
- safely handle paths and arguments
- never invoke FFmpeg through a shell string
- use `exec.CommandContext`

State model:

```text
STOPPED
STARTING
LIVE
RESTARTING
FAILED
```

Expose useful stats:

```text
state
started_at
restart_count
last_exit
last_error
profile
playlist_path
```

Do not expose secrets.

---

# 7. FFMPEG COMMAND — SAMSUNG COMPATIBILITY PROFILE

Build the FFmpeg command programmatically.

For Windows DirectShow baseline, generate equivalent behavior to:

```powershell
ffmpeg `
  -hide_banner -loglevel warning `
  -rtbufsize 64M `
  -f dshow `
  -video_size 1280x720 `
  -i video="vMix Video":audio="vMix Audio" `
  -map 0:v:0 -map 0:a:0 `
  -c:v libx264 -preset veryfast -profile:v baseline -level:v 3.1 `
  -pix_fmt yuv420p -r 30 -g 60 -keyint_min 60 -sc_threshold 0 `
  -force_key_frames "expr:gte(t,n_forced*2)" `
  -b:v 3500000 -maxrate 4000000 -bufsize 7000000 `
  -c:a aac -profile:a aac_low -b:a 128000 -ar 48000 -ac 2 `
  -f hls -hls_time 2 -hls_list_size 6 -hls_delete_threshold 2 `
  -hls_flags delete_segments+temp_file `
  -hls_segment_type mpegts `
  -hls_segment_filename ".../segment_%06d.ts" `
  ".../index.m3u8"
```

Do not force a DirectShow input `-framerate`: the observed vMix device must
negotiate its native input rate. `-r 30` is an output encoder setting. Do not
add `independent_segments`; it raises the playlist version beyond the legacy
F5500 target.

Verify exact options against installed FFmpeg.

If an option causes compatibility problems with Samsung F5500, prefer the simpler/more compatible output.

Do not use fMP4 HLS for the baseline.

Do not require HEVC.

Do not require AV1.

Do not require browser JavaScript HLS playback.

The Samsung browser/player should receive native HLS/MPEG-TS.

---

# 8. ADD A 720P SAFE PROFILE

Create configuration for:

```yaml
samsung_tv:
  enable: false
  ffmpeg_path: "ffmpeg"

  video_device: "vMix Video"
  audio_device: "vMix Audio"

  output_path: "/tmp/samsung-tv"

  profile: "f5500_720p"

  width: 1280
  height: 720
  frame_rate: 30

  video_bitrate: 3500000
  max_video_bitrate: 4000000
  video_buffer: 7000000

  audio_bitrate: 128000
  audio_sample_rate: 48000

  segment_duration: 2s
  playlist_size: 6

  auto_restart: true
```

Adapt paths appropriately for Windows.

Add strict config validation.

Validate:

- dimensions
- bitrate limits
- FPS
- playlist size
- segment duration
- device string length
- output path
- ffmpeg path

Do not accept arbitrary shell fragments in device configuration.

---

# 9. ADD 1080P OPTIONAL PROFILE

After 720p support is stable, add optional:

```text
f5500_1080p
1920x1080
30 fps
H.264 Main/High only if TV validation proves it works
5–8 Mbps
AAC 128–192 kbps
```

Do not make 1080p the default.

Samsung 2013 compatibility/stability is more important than resolution.

---

# 10. CREATE `/tv` ROUTE

Add a TV-specific static page:

```text
web/tv/index.html
```

Expose:

```text
GET /tv
GET /tv/
```

The page must be designed for the Samsung F5500 legacy browser.

Avoid modern JS features.

Do not use:

- modules
- async/await
- fetch if legacy compatibility is uncertain
- template literals
- arrow functions
- Web Components
- React
- Vue
- modern CSS dependencies
- external CDN scripts
- HLS.js

Prefer:

```text
HTML5 <video>
plain ES5 JavaScript
XMLHttpRequest only if needed
simple CSS
```

Primary markup should be close to:

```html
<video
  id="player"
  controls
  autoplay
  preload="auto">
  <source src="/tv/live/index.m3u8" type="application/vnd.apple.mpegurl">
</video>
```

Add:

- black fullscreen background
- giant simple status message
- playback retry
- manual PLAY button
- reload button
- stream offline message
- current profile
- minimal diagnostics

The page must still function if JavaScript support is weak.

---

# 11. ADD DIRECT HLS STATIC ROUTE

Expose Samsung gateway output under:

```text
/tv/live/
```

Example:

```text
/tv/live/index.m3u8
/tv/live/segment_000001.ts
```

Use the repository's safe static serving helpers.

Requirements:

- reject traversal
- reject symlink escape
- correct content types:
  - `.m3u8` => `application/vnd.apple.mpegurl`
  - `.ts` => `video/mp2t`
- disable inappropriate long-term cache
- playlist => `Cache-Control: no-cache`
- segments => short bounded cache
- GET and HEAD only
- no directory listing

---

# 12. ADD SAMSUNG TV STATUS API

Add bounded read-only endpoint:

```text
GET /api/v1/tv/status
```

Example response:

```json
{
  "enabled": true,
  "state": "live",
  "profile": "f5500_720p",
  "restart_count": 0,
  "playlist_ready": true
}
```

Do not expose local filesystem path.

Do not expose DirectShow device internals unless necessary.

If management API authentication policy requires this endpoint to be protected, follow existing policy.

---

# 13. ADD START / STOP API ONLY IF SAFE

Optional management operations:

```text
POST /api/v1/tv/start
POST /api/v1/tv/stop
POST /api/v1/tv/restart
```

Only implement them if they can cleanly use the existing management API-key authorization.

Never make mutation endpoints anonymous.

Body size must be bounded.

Unknown JSON fields must be rejected.

---

# 14. WINDOWS ONE-CLICK SCRIPTS

Create:

```text
scripts/windows/samsung-tv-doctor.ps1
scripts/windows/samsung-tv-start.ps1
scripts/windows/samsung-tv-stop.ps1
scripts/windows/samsung-tv-test.ps1
```

## `samsung-tv-doctor.ps1`

Check:

```text
Windows version
LAN IPv4
Wi-Fi interface
FFmpeg installed
vMix running
DirectShow device list
vMix Video found
vMix Audio found
port 8081 availability
firewall accessibility
HLS output directory writable
```

Print actionable PASS/FAIL.

## `samsung-tv-start.ps1`

Should:

1. discover current LAN IP
2. verify FFmpeg
3. verify vMix capture devices
4. launch StreamDBC Samsung gateway
5. verify `/health`
6. wait for HLS playlist
7. print:

```text
Open this on Samsung TV:

http://192.168.x.x:8081/tv
```

Also print fallback:

```text
http://192.168.x.x:8081/tv/live/index.m3u8
```

## `samsung-tv-stop.ps1`

Gracefully stop managed gateway.

## `samsung-tv-test.ps1`

Verify:

```text
health
tv status
playlist availability
segment availability
content type
playlist updates
```

---

# 15. WINDOWS FIREWALL HELPER

Do not broadly disable Windows Firewall.

Provide scoped helper/instruction to allow only:

```text
TCP 8081
Private network profile
```

Prefer rule name:

```text
StreamDBC Samsung TV
```

If automatically creating the rule, require elevated PowerShell and make it idempotent.

Provide removal command.

---

# 16. WIFI NETWORK REQUIREMENTS

Document:

```text
vMix PC and Samsung TV must be on the same LAN/subnet
AP/client isolation must be disabled
TV must be able to reach PC LAN IP
Windows network profile should be Private
TCP 8081 must be reachable
```

Add Windows test:

```powershell
Get-NetIPAddress
Test-NetConnection
```

If possible expose a simple:

```text
/tv/ping
```

or use `/health`.

---

# 17. HANDLE OLD SAMSUNG BROWSER LIMITATIONS

The target TV is approximately 2013.

Avoid assumptions about modern browser support.

The TV page must:

- use ES5-compatible syntax
- not depend on Promise
- not depend on fetch
- not depend on URLSearchParams
- not depend on HLS.js
- not depend on Service Workers
- not depend on WebAssembly
- not depend on WebRTC
- not depend on CSS Grid

Prefer simple block/flex fallback CSS.

Use a native `<video>` element.

Provide a second page if needed:

```text
/tv/basic
```

containing almost nothing except:

```html
<video controls autoplay src="/tv/live/index.m3u8"></video>
```

This is useful for troubleshooting.

---

# 18. HLS PLAYLIST REQUIREMENTS

For Samsung compatibility, playlists should resemble:

```text
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:100

#EXTINF:2.000,
segment_000100.ts
#EXTINF:2.000,
segment_000101.ts
```

Do not use:

```text
EXT-X-MAP
fMP4
LL-HLS parts
CMAF
HEVC
AV1
```

for the baseline Samsung F5500 profile.

---

# 19. CODEC COMPATIBILITY

Baseline:

```text
Video:
H.264/AVC
yuv420p
Baseline profile
Level 3.1
1280x720
30fps

Audio:
AAC-LC
stereo
48 kHz
128 kbps

Container:
MPEG-TS

Protocol:
HLS
```

Ensure keyframe interval aligns with segment boundary.

For 30 fps / 2 sec:

```text
GOP = 60
```

---

# 20. LATENCY TARGET

Do not optimize for ultra-low latency initially.

For this old TV, reliability wins.

Accept target glass-to-glass latency:

```text
6–15 seconds
```

If stable, offer optional experimental profile:

```text
1 second segments
3–4 playlist entries
```

but never make it default until tested on the TV.

---

# 21. ADD TESTS

Add unit tests for:

### Config

- valid Samsung profile
- invalid resolution
- invalid bitrate
- invalid playlist size
- invalid segment duration
- invalid output path
- empty device name
- invalid ffmpeg executable config

### FFmpeg command builder

Verify:

```text
dshow input
H.264 codec
AAC codec
yuv420p
profile/level
MPEG-TS HLS
segment filename
playlist filename
GOP
resolution
FPS
```

Do not test by shell string equality if argument-array assertions are clearer.

### Gateway lifecycle

Mock process runner.

Test:

```text
start
duplicate start rejected
unexpected exit
restart/backoff
stop
context cancellation
max restart behavior
status reporting
```

### API

Test:

```text
/tv page
/tv/basic
/tv/live traversal rejection
status endpoint
content types
missing playlist
GET/HEAD behavior
mutation authorization if implemented
```

---

# 22. ADD INTEGRATION TEST MODE

Add a synthetic FFmpeg test profile not requiring vMix:

```text
testsrc2
sine
```

Equivalent to:

```bash
ffmpeg \
  -f lavfi -i testsrc2=size=1280x720:rate=30 \
  -f lavfi -i sine=frequency=1000:sample_rate=48000 \
  ...
```

This should generate the exact Samsung HLS output.

Use this in CI or integration testing.

Then CI can verify:

```text
FFmpeg starts
playlist generated
segments generated
ffprobe identifies:
H.264
AAC
MPEG-TS
720p
yuv420p
```

This is extremely important.

Do not require vMix in CI.

---

# 23. CI

Add/extend workflow:

```text
Samsung TV Gateway
```

Checks:

```text
Go unit tests
race tests where relevant
go vet
staticcheck
gosec
govulncheck
FFmpeg installed
synthetic HLS generation
ffprobe compatibility assertions
HTTP /tv check
playlist check
segment MIME/content check
```

Pin actions by immutable SHA.

Do not remove existing CI.

---

# 24. MAKEFILE

Add commands:

```text
make samsung-tv-test
make samsung-tv-run
make samsung-tv-doctor
```

If Windows-specific implementation makes direct Make support awkward, document it and keep PowerShell scripts primary.

---

# 25. CONFIGURATION PROFILES

Add:

```text
configs/samsung-f5500.yaml
```

It should enable only what is required.

Example intent:

```yaml
server:
  host: "0.0.0.0"
  http_port: 8081

api:
  enable: true

samsung_tv:
  enable: true
  profile: "f5500_720p"
  ffmpeg_path: "ffmpeg"
  video_device: "vMix Video"
  audio_device: "vMix Audio"
```

Do not unnecessarily enable RTMP, SRT, RTSP, WebRTC, Redis, PostgreSQL, etc.

---

# 26. TV QUICK-START PAGE

Add documentation:

```text
docs/SAMSUNG-F5500.md
```

It must be extremely practical.

Sections:

```text
1. Requirements
2. Enable vMix External Output
3. Start StreamDBC
4. Find Windows LAN IP
5. Open Samsung browser
6. Enter /tv URL
7. Fullscreen
8. Troubleshooting
```

Include exact vMix steps where possible:

```text
vMix
Settings
External Output / NDI
External Output 1
Enable
```

Verify current vMix UI terminology rather than blindly assuming labels.

Explain that the path uses:

```text
vMix External Output
```

and does not require the Samsung TV to understand NDI.

---

# 27. VMIX NDI OPTION — OPTIONAL ONLY

After the External Output path works, optionally support:

```text
NDI -> gateway -> HLS
```

only if an NDI runtime already exists on the PC.

This is secondary.

Do not block Samsung delivery on NDI SDK integration.

If implemented, keep:

```text
source=vmix_external
source=ndi
source=test
```

as selectable capture source modes.

---

# 28. FAIL-SAFE BEHAVIOR

If vMix stops:

```text
LIVE
→ source unavailable
→ RESTARTING
→ retry
```

Do not crash StreamDBC.

If FFmpeg exits repeatedly:

```text
bounded exponential backoff
1s
2s
4s
8s
max 30s
```

Expose state clearly.

When vMix returns, automatically recover.

---

# 29. CLEANUP

Prevent HLS directory from growing forever.

Maintain bounded playlist window.

Delete old `.ts` files.

On restart:

- remove stale playlist/segments safely
- only inside configured Samsung output root
- protect against symlink/path traversal
- never recursively delete arbitrary user paths

---

# 30. PROCESS SECURITY

Never build FFmpeg command via:

```text
cmd.exe /c <user-controlled-string>
powershell -Command <user-controlled-string>
sh -c
```

Use argument arrays.

Do not log:

```text
passwords
API keys
JWT
credential-bearing URLs
```

Device names may be logged only after sanitization and only when operationally useful.

---

# 31. DOCUMENT LIMITATIONS ACCURATELY

README must not claim:

```text
Samsung NDI receiver
```

unless the TV actually receives NDI.

Correct wording:

> Samsung F5500 Wi-Fi playback gateway receives the vMix Program output on the Windows host and transcodes it to legacy-compatible H.264/AAC HLS for playback by the television over the LAN.

Also state expected latency.

---

# 32. README UPDATE

Add section:

```text
Samsung F5500 Wi-Fi Output
```

Example:

```text
vMix PC
  ↓ External Output
StreamDBC Samsung Gateway
  ↓ H.264/AAC HLS over Wi-Fi
Samsung UA40F5500
```

Include quick commands.

---

# 33. ACCEPTANCE TEST — WINDOWS PC

Before calling implementation complete:

1. Start vMix.
2. Enable Program External Output.
3. Run:

```powershell
.\scripts\windows\samsung-tv-doctor.ps1
```

Expected:

```text
PASS FFmpeg
PASS vMix Video
PASS vMix Audio
PASS LAN IP
PASS HLS output
```

4. Start:

```powershell
.\scripts\windows\samsung-tv-start.ps1
```

5. Verify:

```text
/health => 200
/tv => 200
/tv/basic => 200
/tv/live/index.m3u8 => 200
```

6. Verify with `ffprobe`:

```text
video codec = h264
pixel format = yuv420p
width = 1280
height = 720
audio codec = aac
container = mpegts
```

---

# 34. ACCEPTANCE TEST — SAMSUNG UA40F5500

Final manual hardware gate:

TV and PC on same Wi-Fi.

On TV browser open:

```text
http://<PC-LAN-IP>:8081/tv
```

Success requires:

```text
[ ] TV page loads
[ ] HLS playlist reachable
[ ] live vMix image appears
[ ] audio plays
[ ] fullscreen playback works
[ ] stream recovers after stopping/restarting vMix
[ ] stream recovers after Wi-Fi interruption
[ ] no TV browser crash
[ ] 30+ minute initial soak passes
```

Then perform:

```text
2 hour soak
4 hour soak
```

Record:

```text
CPU
RAM
FFmpeg restart count
segment generation
Wi-Fi disconnect recovery
```

---

# 35. TROUBLESHOOTING FALLBACKS

If `/tv` page loads but video does not:

Try direct:

```text
http://<PC-IP>:8081/tv/live/index.m3u8
```

If still no playback:

reduce to:

```text
720p
25/30fps
H.264 Baseline
AAC-LC
2 Mbps
```

If audio causes failure:

temporarily test video-only, then restore AAC.

If Samsung browser cannot play HLS but Samsung media player can:

provide a minimal redirect/open-media workflow.

Document evidence.

Do not guess.

---

# 36. GITHUB WORKFLOW

When implementation is ready:

1. Ensure branch is based on latest `main`.
2. Commit logically.
3. Open one PR.
4. PR title:

```text
Add Samsung F5500 Wi-Fi HLS gateway for vMix
```

5. PR body must include:
   - architecture
   - Samsung target
   - codec profile
   - security considerations
   - tests
   - limitations
   - manual hardware gate

6. Wait for:
   - CI
   - CodeQL
   - Desktop Client if applicable
   - Android TV if touched
   - Samsung Gateway CI

7. Fix every failure.

8. Do not merge while any required check is red.

9. Merge normally to `main`.

10. Verify workflows again on merge commit.

---

# 37. FINAL REPORT

At completion return a Thai operational report containing:

```text
STATUS
MAIN SHA
PR
CHECKS
FILES ADDED
FILES MODIFIED

WINDOWS COMMAND
TV URL
DIRECT HLS URL

VMIX SETTINGS
EXPECTED LATENCY

WHAT IS VERIFIED
WHAT STILL REQUIRES PHYSICAL TV TEST
```

Do not claim physical UA40F5500 playback until manually observed.

---

# 38. DEFINITION OF DONE

Repository-level Done:

```text
[x] Samsung gateway source implemented
[x] Windows vMix External Output capture implemented
[x] H.264/AAC MPEG-TS HLS produced
[x] /tv route exists
[x] /tv/basic route exists
[x] /tv/live/index.m3u8 served
[x] automatic FFmpeg restart
[x] bounded cleanup
[x] status endpoint
[x] Windows doctor script
[x] Windows start/stop/test scripts
[x] synthetic FFmpeg integration tests
[x] ffprobe compatibility tests
[x] CI green
[x] CodeQL green
[x] documentation complete
[x] PR merged to main
```

Physical-device Done:

```text
[ ] Samsung UA40F5500 opens /tv
[ ] vMix Program video visible
[ ] audio works
[ ] stable fullscreen playback
[ ] restart recovery works
[ ] Wi-Fi reconnect works
[ ] ≥4 hour soak passes
```

Only after those physical-device checks may the project state:

```text
Samsung UA40F5500 Wi-Fi playback verified
```

---

# 39. PRIORITY

Do not divert into:

```text
Samsung Tizen development
Samsung Legacy app packaging
Android APK deployment
Android TV box support
full NDI Android receiver
WHIP/WHEP media-plane work
general streaming platform expansion
```

until the Samsung F5500 Wi-Fi vMix playback path described above is operational.

The sole milestone is:

> Open one URL on the Samsung UA40F5500 browser and see/hear the live vMix Program output over Wi-Fi reliably.

Execute from repository inspection through implementation, testing, PR, merge, and post-merge verification.
