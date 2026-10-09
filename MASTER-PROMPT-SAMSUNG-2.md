# STREAMDBC — SAMSUNG F5500 TV WALL
## FULL PRODUCTION CODEX MASTER PROMPT
## PLAYBACK-FIRST + SAFE PAIRING + FLEET CONTROL

You are the primary production engineer for:

```text
Repository: https://github.com/cvsz/streamdbc
Owner: cvsz
Default branch: main
Platform: Windows 11
Primary workspace: D:\data\streamdbc

Application:
StreamDBC Windows Control Panel

Primary target:
Samsung UA40F5500
Samsung F-Series Legacy Smart TV
Samsung Orsay / VDLinux generation
```

The immediate objective is NOT general dashboard development.

The immediate objective is:

> Reliably deliver live video/audio from vMix through StreamDBC to the physical Samsung UA40F5500 televisions, with safe authorization/pairing behavior, per-TV verification, and no abusive retry behavior that could cause the TV to deny, block, blacklist, or permanently reject the controller.

After playback is proven on real hardware, continue through fleet management and advanced controls.

## Current execution checkpoint — 2026-10-09

Read [`docs/SAMSUNG-CURRENT-STATUS.md`](docs/SAMSUNG-CURRENT-STATUS.md) before
resuming. This checkpoint supersedes older branch, status, and phase-order
assumptions below.

- Current branch: `fix/client-close-exit-status`. The working tree has existing
  user changes; preserve them and inspect `git status` before any mutation.
- The PC-side Samsung gateway reported `LIVE`; the playlist advanced and a
  current segment returned HTTP 200.
- TV-81/82/89/90/91 accepted the MP4 URI/Play command. The operator confirmed
  MP4 picture and sound on all five.
- An earlier HLS URI sent through AVTransport failed on all five with
  `Illegal MIME-type`; keep it distinct from browser playback.
- `RunBrowser` was acknowledged on all five, but Live Browser was later
  reported as `Offline`. Live HLS picture/audio have not been confirmed.
- The latest HDMI command returned source read-back on all five: HDMI1 on
  TV-81/82/89/91 and HDMI2 on TV-90. The operator previously confirmed an HDMI
  picture on all five.
- A `Tray is destroyed` close error was reported from the installed app. A
  source guard exists, but that app has not been rebuilt or runtime-tested.
- The repository profile uses DirectShow `vmix_external`; do not assume that
  the user-provided RTMP destination is a supported media-ingest path. Check
  the exact executable/configuration first.

Resume in this order: verify the rebuilt close fix on Windows; diagnose Live
Browser `Offline` on one TV; prove live video and audio; repeat across the five
TVs; then run recovery, soak, CI and release checks. Do not re-run already
confirmed MP4 or HDMI actions without a diagnostic reason.

---

# 1. KNOWN PHYSICAL FLEET

Known TVs:

```text
TV-81
IP: 192.168.1.81
MAC: BC:8C:CD:32:B7:56

TV-82
IP: 192.168.1.82
MAC: BC:8C:CD:33:ED:61

TV-89
IP: 192.168.1.89
MAC: BC:8C:CD:2C:CD:05

TV-90
IP: 192.168.1.90
MAC: BC:8C:CD:33:ED:36

TV-91
IP: 192.168.1.91
MAC: BC:8C:CD:3D:FF:38
```

Observed Samsung TV ports across the fleet:

```text
80
443
4443
6000
7676
52345
55000
55001
```

The development PC has previously appeared around:

```text
192.168.1.85
```

but NEVER hardcode this address.

Dynamically detect the actual physical LAN interface used to reach the TVs.

---

# 2. ABSOLUTE PRIORITY ORDER

Follow this order strictly.

```text
P0
GET REAL VIDEO ON ONE PHYSICAL TV

P0.1
GET REAL VIDEO ON ALL AVAILABLE SUPPORTED TVs

P0.2
MAKE START TV WALL RELIABLE

P1
FLEET DISCOVERY / HEALTH / DASHBOARD

P2
VOLUME / MUTE / PLAYBACK CONTROLS

P3
PAIRING-DEPENDENT REMOTE CONTROL

P4
WOL / POWER / INPUT

P5
RELEASE / INSTALLER / DOCUMENTATION / POLISH
```

Do not implement secondary features while P0 playback remains broken unless the secondary change is directly required to diagnose or fix P0.

---

# 3. PRIMARY MEDIA PIPELINE

The target is a two-path validation sequence, not one AVTransport assumption:

```text
vMix
  ↓
vMix Video + vMix Audio
  ↓
FFmpeg
  ↓
StreamDBC Samsung Gateway
  ↓
H.264/AAC media
  ↓
HTTP from Windows LAN IP
  ├─ MP4 baseline: AVTransport → SetAVTransportURI → Play → GetTransportInfo
  │                 → physical video/audio
  └─ Live HLS: RunBrowser → /tv/ page → HLS fetch/decode → physical video/audio
```

The HLS URI was rejected by AVTransport with `Illegal MIME-type` on all five
TVs. The current live-browser run was acknowledged but displayed `Offline`.
The P0 is to diagnose that browser result; do not report command acceptance as
successful HLS playback.

Expected HLS URL:

```text
http://<PC-LAN-IP>:8081/tv/live/index.m3u8
```

Do not send:

```text
127.0.0.1
localhost
WSL address
Docker address
VMware NAT address
Hyper-V virtual address
Tailscale address
```

to a physical TV.

---

# 4. RECONCILE CURRENT REPOSITORY FIRST

Do not assume earlier conversation state is still current.

Run:

```powershell
cd D:\data\streamdbc

git status
git remote -v
git fetch --all --prune
git branch -vv
git log --oneline --decorate -25
```

Inspect live GitHub state:

```text
main HEAD
all open PRs
PR #41
current PR head
workflow status
branch protection
CodeQL alerts
review comments
mergeability
local uncommitted changes
```

Earlier work around PR #41 used this development branch:

```text
fix/tray-close-and-samsung-ports
```

That branch name is historical. The current working copy is
`fix/client-close-exit-status`; always inspect the live branch and preserve its
uncommitted files before continuing.

Known work from that development line includes:

```text
Windows tray crash fix
Samsung service-port support
HTTP/HTTPS service handling
multi-interface SSDP
explicit multicast-interface selection
multiple M-SEARCH attempts
dashboard auth fixes
TV POST {} API fix
HLS segment race fix
Start Samsung Mode
AVTransport PLAYING verification
```

Do not duplicate already-working implementation.

If PR #41 remains active:

```text
continue PR #41
```

If merged:

```text
checkout main
pull --ff-only
create next focused branch
```

If closed without merge:

```text
inspect commits
recover only valid work
avoid duplicate implementation
```

Never destroy local user work.

---

# 5. GITHUB RULES

```text
NO force push
NO force merge
NO red-check bypass
NO fake approvals
NO hiding test failures
NO disabling security checks just to merge
```

Required workflow:

```text
implement
test
commit logically
push
inspect CI
fetch failed job logs
fix root cause
repeat
merge normally only after required checks pass
verify main after merge
```

If an independent reviewer is required and authorized:

```text
use policedbc only for legitimate review/approval
```

Do not use the second account to bypass real failures.

---

# 6. PRESERVE EXISTING WINDOWS FIXES

Never reintroduce:

```javascript
tray.setHighlightMode(...)
```

unconditionally on Windows.

Only use it where supported.

Electron must not crash when:

```text
window closes
window hides
window minimizes
system tray is created
system tray is destroyed
```

---

# 7. API CONTRACT

Samsung gateway operations:

```text
POST /api/v1/tv/start
POST /api/v1/tv/stop
POST /api/v1/tv/restart
```

must use:

```http
Content-Type: application/json
X-API-Key: <configured key>

{}
```

Do not send an absent/zero-length body when backend requires an empty JSON object.

Management mutations remain authenticated.

---

# 8. DASHBOARD SECURITY

The dashboard UI shell may be accessible:

```text
/dashboard/
```

but management operations must remain protected.

Never put API credentials in:

```text
URL
query string
HTML source
logs
telemetry
Git
```

Browser dashboard API credentials should be:

```text
session-scoped
```

when possible.

Do not persist sensitive API keys to ordinary localStorage.

---

# 9. SERVER VALIDATION BEFORE TV DEBUGGING

Before debugging TV control:

```powershell
curl.exe http://127.0.0.1:8081/health
curl.exe http://127.0.0.1:8081/api/v1/tv/status
curl.exe http://127.0.0.1:8081/tv/live/index.m3u8
```

Run:

```powershell
.\scripts\windows\samsung-tv-test.ps1
```

Expected:

```text
PASS health
PASS TV page
PASS basic TV page
PASS TV status
PASS HLS playlist
PASS HLS segment
PASS playlist updates
```

If this does not pass:

```text
STOP TV-control debugging
FIX MEDIA SERVER FIRST
```

---

# 10. HLS SLIDING WINDOW SAFETY

FFmpeg uses a live HLS sliding window.

The smoke test must:

```text
fetch index.m3u8
parse all current segment URIs
select newest/current segment
GET that segment
if 404:
    refresh playlist
    select newest segment again
    retry bounded number of times
```

Never assume the oldest listed HLS segment remains available.

---

# 11. SYNTHETIC TEST SOURCE

Maintain a deterministic diagnostic source:

```text
source=test
```

Synthetic media must be available without vMix.

Recommended:

```text
1280x720
30 fps
H.264
AAC-LC
48kHz
stereo
yuv420p
2-second GOP
2-second HLS segments
```

Purpose:

```text
separate vMix/device problems
from TV/network/media problems
```

Operator should be able to choose:

```text
TEST SOURCE
VMIX SOURCE
```

Do not silently change production source.

---

# 12. VMIX PRODUCTION SOURCE

Expected devices:

```text
vMix Video
vMix Audio
```

Show:

```text
vMix: RUNNING / NOT RUNNING
vMix Video: FOUND / MISSING
vMix Audio: FOUND / MISSING
FFmpeg: READY / FAILED
Gateway: LIVE / FAILED
HLS: READY / FAILED
```

Do not claim HLS READY merely because FFmpeg process exists.

Require actual media evidence.

---

# 13. HLS READY DEFINITION

HLS READY requires:

```text
playlist HTTP 200
correct Content-Type
valid playlist syntax
at least one segment URI
latest segment HTTP 200
segment non-empty
playlist advances over time
```

Optional ffprobe validation:

```text
video codec: h264
audio codec: aac
pixel format: yuv420p
resolution: 1280x720
fps: ~30
```

---

# 14. KNOWN FLEET IS MANDATORY

The five TVs must remain visible even if SSDP returns zero responses.

Architecture:

```text
KNOWN FLEET
+
SSDP DISCOVERY
+
DIRECT SAFE PROBES
+
UPNP DESCRIPTION
=
CANONICAL FLEET
```

SSDP failure must NOT produce an empty application state when known fleet is configured.

---

# 15. NO GENERIC NETWORK SCANNER

Only probe:

```text
known configured TVs
or validated SSDP-discovered TVs
```

Only probe allowed ports:

```text
80
443
4443
6000
7676
52345
55000
55001
```

No unrestricted subnet scan.

No arbitrary user-supplied target.

---

# 16. ONLINE DETECTION

Do not rely on ICMP.

A TV may be ONLINE if any validated signal succeeds:

```text
SSDP
UPnP description
TCP connect to expected Samsung port
SOAP response
```

Track:

```text
online
lastSeen
latencyMs
reachablePorts
discoverySource
```

---

# 17. NETWORK LIMITS

Use bounded operations.

Suggested limits:

```text
TV refresh concurrency: 5
port probes per TV: 3
TCP timeout: 500–1000 ms
HTTP/SOAP timeout: 3–5 sec
SSDP discovery window: bounded
PLAYING verification: 10–15 sec
```

Never create infinite retry loops.

---

# 18. SSDP DISCOVERY

Use:

```text
239.255.255.250:1900
```

Search relevant types including:

```text
ssdp:all
MediaRenderer
Samsung MainTV services
```

For every eligible physical private-LAN NIC:

```text
bind UDP socket
setMulticastInterface(localIP)
set multicast TTL
send M-SEARCH
send again after a short delay
collect bounded responses
```

Deduplicate SSDP responses.

Merge physical devices by IP, with:

```text
UDN
MAC
LOCATION
```

as identity signals.

---

# 19. SSDP DIAGNOSTICS

Return diagnostics such as:

```text
Interface: Ethernet
LocalIP: 192.168.1.85
M-SEARCH: sent
Responses: 5

Interface: vEthernet (WSL)
Ignored: virtual interface
```

If zero TVs are discovered, display:

```text
SSDP responses: 0
Known TVs: 5
Direct probes starting...
```

Do not just display:

```text
0 TVs
```

---

# 20. DYNAMIC SERVICE DISCOVERY

Never hardcode:

```text
/smp_4/
/smp_16/
/smp_18/
/smp_22/
/smp_24/
/smp_32/
/smp_40/
/smp_46/
```

Endpoint numbering differs across TVs.

Use:

```text
SSDP LOCATION
→ device description XML
→ serviceList
→ SCPDURL
→ controlURL
→ actual supported actions
```

---

# 21. SAFE SAMSUNG SERVICE URL VALIDATION

Samsung-advertised service URLs may use:

```text
http
https
```

Allow only:

```text
private IPv4 target
exact TV responder IP
approved Samsung ports
validated URL syntax
```

Never permit advertised URLs to escape to arbitrary hosts.

Prevent SSRF.

---

# 22. PRIMARY PLAYBACK CONTROL

Primary production control path:

```text
AVTransport
```

Required actions:

```text
SetAVTransportURI
Play
GetTransportInfo
```

Flow:

```text
SetAVTransportURI(mediaURL)
→ if success
Play()
→ poll GetTransportInfo()
→ require PLAYING
```

---

# 23. PLAYBACK STATE MODEL

Do not call a SOAP HTTP 200 result full success.

Use states:

```text
URI_NOT_SENT
URI_SENT
URI_ACCEPTED
PLAY_SENT
PLAY_ACCEPTED
TRANSITIONING
PLAYING
STOPPED
FAILED
UNSUPPORTED
OFFLINE
```

Then physical state separately:

```text
PHYSICAL_UNKNOWN
VIDEO_CONFIRMED
AUDIO_CONFIRMED
```

For the browser path, record `RunBrowser` command status, page status, playlist
fetch, segment fetch and physical playback independently. The page can show
`Offline` while the PC playlist is advancing; neither a SOAP acknowledgement
nor an HTTP 200 proves video decode.

---

# 24. PHYSICAL SUCCESS RULE

Software success:

```text
AVTransport baseline: SetAVTransportURI + Play accepted and state recorded
Browser path: RunBrowser accepted; page/playlist/segment results recorded
```

Hardware success:

```text
operator confirms visible moving video
operator confirms audio
```

Never manufacture physical confirmation.

---

# 25. PAIRING MUST BE PROTOCOL-SPECIFIC

Do NOT assume every Samsung protocol requires pairing.

Examples:

```text
AVTransport:
may not require proprietary remote pairing

RenderingControl:
may not require proprietary pairing

Legacy remote / proprietary remote control:
may require one-time TV authorization/pairing
```

The application must distinguish these cases.

Do not block AVTransport playback merely because legacy remote pairing has not occurred.

---

# 26. PAIRING STATE MACHINE

Implement pairing state per TV and per control protocol.

Required states:

```text
UNKNOWN
NOT_REQUIRED
REQUIRED
REQUEST_PENDING
WAITING_TV_APPROVAL
AUTHORIZED
DENIED
COOLDOWN
EXPIRED
IDENTITY_CHANGED
UNSUPPORTED
ERROR
```

Persist only what is genuinely necessary.

---

# 27. PAIRING SAFETY — BLACKLIST PROTECTION

THIS IS IMPORTANT.

The controller must NEVER spam Samsung pairing/auth requests.

If a control path requires pairing:

```text
send ONE pairing request
wait for TV response/operator action
do not repeatedly reconnect
do not repeatedly resend pairing
```

If state becomes:

```text
WAITING_TV_APPROVAL
```

do not issue another pair request automatically.

Display clearly:

```text
Check the television and press Allow / Permit / OK.
```

---

# 28. PAIRING DENIAL BEHAVIOR

If the TV/operator denies pairing:

```text
DENIED
```

Immediately:

```text
stop pairing attempts
stop proprietary remote commands
cancel retries
enter COOLDOWN
```

Do not brute-force authorization.

Do not automatically retry every few seconds.

---

# 29. PAIRING COOLDOWN

Implement cooldown protection.

Suggested conservative behavior:

```text
first timeout:
    wait at least 30 seconds before manual retry

explicit denial:
    require manual user action before retry

multiple failures:
    exponential backoff

3 consecutive pairing failures:
    lock automatic pairing for that TV/session
```

Example backoff:

```text
30 sec
60 sec
120 sec
300 sec
```

Do not exceed sensible operational limits.

---

# 30. PAIRING COMMAND RATE LIMIT

Per-TV proprietary command rate must be limited.

Example:

```text
normal remote commands:
max a few commands/sec

pairing:
one active transaction only

failed connection:
backoff
```

Do not open many simultaneous sessions to port 55000/55001/7676.

---

# 31. PAIRING IDENTITY

Pair/trust state must be associated with stable identity:

```text
IP
MAC
UDN where available
model/friendly identity
```

IP alone is insufficient.

If:

```text
same IP
different MAC/UDN
```

mark:

```text
IDENTITY_CHANGED
```

Do not reuse authorization blindly.

---

# 32. PAIRING PERSISTENCE

If the protocol itself provides:

```text
token
device ID
client registration
authorization state
```

persist only what is necessary using secure Electron/main-process storage.

Never store:

```text
pairing secret
API token
credential
```

in renderer localStorage or logs.

If protocol does not provide a persistent credential, store only:

```text
last known authorization state
timestamp
identity
```

and revalidate before control.

---

# 33. PAIRING UI

Each TV should display:

```text
Pairing:
UNKNOWN
NOT REQUIRED
PAIR REQUIRED
WAITING FOR TV
AUTHORIZED
DENIED
COOLDOWN
```

Actions:

```text
Pair
Retry Pairing
Forget Local Pairing State
```

Do NOT offer automatic repeated pairing.

---

# 34. MANUAL PAIRING ACTION

The operator must explicitly start pairing for protocols requiring it.

Flow:

```text
1. Select TV
2. Click Pair
3. Verify TV identity/IP
4. Send one authorization request
5. Enter WAITING_TV_APPROVAL
6. Tell operator to approve popup on TV
7. Detect success or timeout
8. Mark AUTHORIZED or FAILED
```

---

# 35. PAIR BEFORE LEGACY REMOTE ONLY WHEN REQUIRED

Before sending legacy Samsung remote keys:

```text
if pairing required and state != AUTHORIZED:
    do not send key
```

Return:

```text
PAIRING_REQUIRED
```

Do not repeatedly trigger pairing implicitly with every remote command.

---

# 36. P0 PLAYBACK SHOULD PREFER NON-PAIRING PATH

For getting video on TV:

```text
FIRST:
AVTransport

ONLY IF evidence shows authorization is needed:
perform required authorization
```

Do not unnecessarily invoke legacy remote control before trying AVTransport.

This reduces:

```text
TV popups
connection spam
denials
blacklist risk
```

---

# 37. START TV WALL

Implement one primary operation:

```text
START TV WALL
```

Sequence:

```text
1. Detect physical LAN IP.

2. Verify StreamDBC server.
   Start if required.

3. Verify API /health.

4. Verify FFmpeg.

5. Verify selected source:
   test or vMix.

6. Start/restart Samsung gateway if required.

7. Wait:
   state=live

8. Wait:
   playlist_ready=true

9. Run HLS test.

10. Abort if HLS is not healthy.

11. Load persistent known fleet.

12. Run SSDP.

13. Merge known + discovered TVs.

14. Probe known TVs missed by SSDP.

15. Hydrate UPnP services.

16. Determine available AVTransport services.

17. Generate LAN media URL.

18. FOR EACH ONLINE TV:
      if AVTransport available:
          use AVTransport directly

      if protocol explicitly reports authorization requirement:
          mark PAIRING_REQUIRED
          do NOT spam retries

19. SetAVTransportURI.

20. Play.

21. Poll GetTransportInfo.

22. Require PLAYING.

23. Return per-TV result.

24. Ask for physical video confirmation.
```

---

# 38. START TV WALL MUST NOT AUTO-PAIR EVERYTHING

Do NOT automatically send proprietary pairing requests to all five TVs when START TV WALL is clicked.

If AVTransport works:

```text
no pairing needed
```

If a TV requires a paired control protocol for a fallback path:

```text
display Pair Required
```

and let operator approve that TV individually.

---

# 39. FIRST HARDWARE TEST ORDER

Do not blast all five TVs while still debugging fundamental compatibility.

Use:

```text
TARGET 1:
192.168.1.81

then:

192.168.1.82

then:

192.168.1.89
192.168.1.90
192.168.1.91
```

Once individual playback works:

```text
START TV WALL
→ fleet fanout
```

---

# 40. STATIC TEST VIDEO

Provide a known-good compatibility file.

Example endpoint:

```text
/tv/test.mp4
```

Use conservative encoding:

```text
H.264
AAC-LC
yuv420p
720p
30fps
conservative level/profile
```

This is essential for diagnosis.

---

# 41. MEDIA COMPATIBILITY DIAGNOSTIC ORDER

If live HLS does not play:

```text
1. Test static MP4.

2. If MP4 also fails:
   diagnose AVTransport/network/authorization.

3. If MP4 works but HLS fails:
   diagnose HLS compatibility.

4. If necessary test MPEG-TS over HTTP.

5. Only add a new production output path when physical evidence justifies it.
```

Avoid speculative protocol complexity.

---

# 42. GETPROTOCOLINFO

Where ConnectionManager exposes:

```text
GetProtocolInfo
```

query it.

Use returned sink capabilities to improve media decisions.

Do not assume support from model name alone.

---

# 43. LEGACY BROWSER

`/tv/` is the current unresolved P0 path. In the latest reported run,
`RunBrowser` was acknowledged by all five TVs, but the operator reported that
the Live Browser page showed `Offline`. See
[`docs/SAMSUNG-CURRENT-STATUS.md`](docs/SAMSUNG-CURRENT-STATUS.md) for the
ordered one-TV diagnosis steps.

Possible flow:

```text
RunBrowser
→ http://<LAN-IP>:8081/tv/
```

but this is secondary.

Previous Samsung behavior may return:

```text
501
```

for unsupported MainTVAgent2 actions.

Treat SOAP command acceptance and browser playback as separate outcomes. A
successful `RunBrowser` response is not proof that the page or HLS stream
loaded. Do not dismiss the browser path as optional while the current P0 is
unresolved.

---

# 44. TV WEB AUTOPLAY

Legacy browser autoplay may be restricted.

TV page may use:

```text
autoplay
muted
playsinline
retry
delayed unmute
```

but do not consider browser autoplay equivalent to AVTransport reliability.

---

# 45. STOP TV WALL

Implement:

```text
STOP TV WALL
```

Sequence:

```text
send AVTransport Stop to supported TVs
record individual result
stop HLS gateway
```

Do NOT:

```text
power off TVs automatically
```

---

# 46. PER-TV PLAYBACK RESULT

Example:

```text
TV-81
Online: YES
AVTransport: YES
Pairing: NOT_REQUIRED
Set URI: SUCCESS
Play: SUCCESS
Transport: PLAYING
Physical video: WAITING_CONFIRMATION

TV-82
Online: YES
AVTransport: NO
Pairing: REQUIRED
State: WAITING_TV_APPROVAL

TV-89
Online: NO
Result: OFFLINE
```

---

# 47. FAILURE CLASSIFICATION

Use explicit codes:

```text
SERVER_DOWN
FFMPEG_MISSING
VMIX_NOT_RUNNING
VMIX_VIDEO_MISSING
VMIX_AUDIO_MISSING
GATEWAY_FAILED
HLS_NOT_READY
HLS_STALE
TV_OFFLINE
NO_UPNP
NO_AVTRANSPORT
PAIRING_REQUIRED
PAIRING_WAITING
PAIRING_DENIED
PAIRING_COOLDOWN
IDENTITY_CHANGED
SET_URI_FAILED
PLAY_FAILED
TRANSPORT_STOPPED
TRANSPORT_TRANSITIONING
TRANSPORT_PLAYING
PHYSICAL_CONFIRMATION_REQUIRED
```

---

# 48. FLEET ACTION FAILURE ISOLATION

One broken TV must not abort fleet execution.

Use bounded equivalent of:

```javascript
Promise.allSettled(...)
```

but honor concurrency limits.

Example:

```text
81 PLAYING
82 PAIR REQUIRED
89 OFFLINE
90 PLAYING
91 PLAY FAILED
```

---

# 49. PLAYBACK RETRY POLICY

For non-pairing AVTransport:

```text
SetAVTransportURI:
1 attempt
1 safe retry after service refresh

Play:
1 attempt
max 1–2 safe retries

GetTransportInfo:
poll every ~750 ms
timeout 10–15 sec
```

No infinite loops.

Pairing retry policy is much more conservative.

---

# 50. DEVICE STATE CACHE

Maintain canonical state in Electron main process:

```javascript
Map<ip, SamsungTV>
```

Track:

```text
IP
MAC
UDN
name
model
online
lastSeen
latency
ports
services
actions
transport
volume
mute
pairing states
last action
last error
```

Renderer receives sanitized snapshots only.

---

# 51. IPC SECURITY

Renderer must NOT get:

```text
raw socket API
generic HTTP API
generic TCP API
exec API
shell API
filesystem primitive
arbitrary Samsung key API
```

Expose semantic APIs:

```text
samsungFleetDiscover
samsungFleetRefresh
samsungFleetStatus
samsungFleetAction
samsungFleetActionAll
samsungHlsTest
samsungPair
samsungPairStatus
startTVWall
stopTVWall
```

Validate all payloads in main process.

---

# 52. URL SECURITY

For playback URLs:

```text
http/https only
```

Reject:

```text
file:
javascript:
data:
ftp:
localhost
127.0.0.1 when target is TV
public SSRF targets unless explicitly supported by trusted workflow
```

Default media URL should be generated by StreamDBC, not free-form user data.

---

# 53. PAIRING MODULE

If proprietary Samsung pairing is required, isolate it.

Suggested:

```text
client/samsung-pairing.js
```

Responsibilities:

```text
pairing protocol
state machine
rate limiting
timeout
cooldown
authorization result
safe cleanup
```

Do not mix pairing implementation deeply into renderer code.

---

# 54. LEGACY REMOTE MODULE

If physical testing establishes legacy port 55000 remote support:

```text
client/samsung-legacy-remote.js
```

Only allow semantic actions.

Allowlist:

```text
VOL_UP
VOL_DOWN
MUTE
SOURCE
UP
DOWN
LEFT
RIGHT
ENTER
RETURN
MENU
HOME
PLAY
PAUSE
STOP
POWER
POWER_OFF
```

Main process converts these into actual Samsung protocol commands.

Never expose arbitrary key strings from renderer.

---

# 55. LEGACY REMOTE SAFETY

Before legacy remote command:

```text
validate private IP
validate TV belongs to known fleet
validate identity
validate pairing state if required
validate action allowlist
validate rate limit
```

On denial:

```text
stop
cooldown
```

---

# 56. P1 DASHBOARD

Only after playback P0 works.

Summary:

```text
vMix
Gateway
HLS
Total TVs
Online TVs
Playing TVs
Pairing Required
Authorized
```

Table:

```text
Select
Name
IP
Model
MAC
Online
Ports
AVTransport
Pairing
Transport
Volume
Mute
HLS
Last Error
Actions
```

---

# 57. SEARCH / FILTER

Support:

```text
IP
name
model
MAC
```

Filters:

```text
All
Online
Offline
Playing
Pair Required
Authorized
HLS Ready
```

---

# 58. AUTO REFRESH

Options:

```text
Off
5 sec
10 sec
30 sec
60 sec
```

Default:

```text
10 sec
```

If previous refresh is active:

```text
skip new refresh
```

No overlapping scans.

---

# 59. PORT DISPLAY

Distinguish:

```text
known/possible ports
currently reachable ports
```

Never show historical ports as currently open.

---

# 60. MODEL DETECTION

Use UPnP XML:

```text
friendlyName
manufacturer
modelName
modelDescription
modelNumber
UDN
```

Do not infer UA40F5500 from Samsung MAC alone.

---

# 61. MAC HANDLING

Known MAC inventory is authoritative until network evidence contradicts it.

If observed identity differs:

```text
IDENTITY WARNING
```

Do not silently overwrite.

---

# 62. VOLUME

After P0/P1.

Use:

```text
RenderingControl.GetVolume
RenderingControl.SetVolume
```

After SetVolume:

```text
GetVolume
```

to confirm.

Debounce slider requests:

```text
150–300 ms
```

---

# 63. MUTE

Use:

```text
GetMute
SetMute
```

After SetMute:

```text
GetMute
```

Do not claim success solely from request response where verification is possible.

---

# 64. PLAY / PAUSE / STOP

Enable only if corresponding SCPD actions exist.

Do not fake capabilities.

---

# 65. POWER ON

Use Wake-on-LAN where MAC exists.

Validate:

```text
MAC
private LAN
broadcast address
```

Example for /24:

```text
192.168.1.255
```

After WOL:

```text
poll status max 30 sec
```

State:

```text
WAKING
ONLINE
TIMEOUT
```

---

# 66. POWER OFF

Never make power off part of STOP TV WALL.

Require explicit action.

Only enable if validated protocol exists.

If not verified:

```text
UNSUPPORTED
```

---

# 67. INPUT CONTROL

The workspace now uses `GetSourceList`, `SetMainTVSource`, and
`GetCurrentExternalSource` to select a reported connected HDMI input. The
latest operation read back the selected source on all five TVs. Keep this
runtime-ID and read-back requirement; do not replace it with blind key timing.

If direct HDMI selection cannot be reliably verified:

```text
Open Source Menu
```

Do not automate fragile blind remote-key timing as production default.

---

# 68. AUDIT HISTORY

Maintain recent in-memory actions.

Suggested max:

```text
50–100 events
```

Fields:

```text
timestamp
TV identity
action
result
duration
```

Never log:

```text
API keys
pairing secrets
tokens
JWT
full credentials
```

---

# 69. STRUCTURED OPERATION LOGGING

Log:

```text
TV discovered
TV online/offline
service hydrated
pair request initiated
pair approved
pair denied
pair cooldown
media URI sent
Play sent
transport state
HLS test
volume update
mute update
```

Sanitize untrusted strings.

---

# 70. CI TESTS — PAIRING

Implement mock tests for pairing module.

Test:

```text
initial UNKNOWN
pair request
WAITING_TV_APPROVAL
AUTHORIZED
DENIED
timeout
cooldown
retry after cooldown
identity change
concurrent pair request rejection
rate limiting
```

No physical TV required.

---

# 71. CI TESTS — UPNP

Mock HTTP/SOAP services.

Test:

```text
device description
SCPD
AVTransport
SetAVTransportURI
Play
Pause
Stop
GetTransportInfo
RenderingControl
GetVolume
SetVolume
GetMute
SetMute
SOAP faults
timeout
unsupported action
```

---

# 72. CI TESTS — DISCOVERY

Test:

```text
multiple NICs
virtual NIC exclusion
zero SSDP responses
known fleet fallback
duplicate SSDP responses
multiple LOCATION entries for one TV
merge by physical device
```

---

# 73. CI TESTS — SECURITY

Verify renderer cannot request:

```text
arbitrary IP
public IP
arbitrary port
arbitrary Samsung key
arbitrary URL protocol
arbitrary executable
arbitrary filesystem path
```

---

# 74. CI TESTS — HLS

Synthetic FFmpeg CI must verify:

```text
playlist 200
latest segment 200
playlist advances
H.264
AAC
MPEG-TS
720p
```

Specifically test sliding-window race behavior.

---

# 75. CI TOOLING

Go:

```text
go test ./...
go test -race ./...
go vet ./...
staticcheck ./...
gosec ./...
govulncheck ./...
```

Desktop:

```text
npm ci --omit=optional
npm audit --omit=optional --audit-level=moderate
JS syntax checks
package tests
```

Do not use:

```text
npm audit fix --force
```

Known electron-builder optional dependency behavior must not be “fixed” by destabilizing the build unnecessarily.

---

# 76. REQUIRED GITHUB WORKFLOWS

Maintain green:

```text
CI
CodeQL
Samsung TV Gateway
Desktop Client
Windows Server Build
```

Do not merge until required checks pass.

---

# 77. PHYSICAL HARDWARE VALIDATION

CI cannot prove these.

Record manually:

```text
RunBrowser accepted or TV browser opened manually
TV browser fetches the playlist and newest segment
video visible
audio audible
volume works
mute works
pairing works
WOL works
power-off works
input works
```

Unsupported is acceptable.

Fabricated success is not.

---

# 78. P0 ACCEPTANCE GATE

Do not proceed to secondary feature development until:

```text
[ ] server health 200
[ ] gateway LIVE
[ ] HLS READY
[ ] latest segment 200
[ ] playlist advancing
[ ] correct LAN IP selected
[ ] TV-81 ONLINE
[ ] TV-side `/tv/` page loads through RunBrowser or manual browser navigation
[ ] browser fetches playlist and newest segment
[ ] physical live HLS video confirmed
```

Then confirm live audio and repeat the browser result per TV. Use AVTransport
for the known-good MP4 baseline and record its URI/Play/transport result
separately. If AVTransport rejects HLS with `Illegal MIME-type`, do not treat
that as evidence that the browser path also failed.

Then:

```text
[ ] physical audio confirmed
```

Then repeat with remaining TVs.

---

# 79. PAIRING ACCEPTANCE

For any protocol that requires pairing:

```text
[ ] only one request issued at a time
[ ] UI enters WAITING_TV_APPROVAL
[ ] operator approves once
[ ] AUTHORIZED state recorded
[ ] commands work after authorization
[ ] DENIED stops retries
[ ] cooldown works
[ ] identity change invalidates state
[ ] no popup spam
[ ] no reconnect flood
```

---

# 80. FLEET ACCEPTANCE

```text
[ ] five known TVs always visible
[ ] SSDP devices merged without duplicates
[ ] SSDP=0 does not erase known fleet
[ ] online/offline works
[ ] capabilities reflect real SCPD
[ ] no fake actions
[ ] per-TV failures isolated
```

---

# 81. START TV WALL ACCEPTANCE

Final one-click target:

```text
Gateway: LIVE
HLS: READY
Known TVs: 5
Online TVs: N

81 PLAYING
82 PLAYING
89 PLAYING
90 PLAYING
91 PLAYING
```

where supported and online.

If not:

```text
OFFLINE
PAIR REQUIRED
UNSUPPORTED
FAILED
```

must be reported honestly.

---

# 82. STOP TV WALL ACCEPTANCE

Must:

```text
stop transport
stop gateway
preserve TV power state
report individual failures
```

---

# 83. WINDOWS BUILD

Build should produce versioned:

```text
StreamDBC-Control-Panel-Setup-<version>.exe
StreamDBC-Control-Panel-Portable-<version>.exe
build-manifest.json
SHA256SUMS.txt
```

---

# 84. VERSIONING

Current known baseline:

```text
1.4.0
```

If only urgent playback fixes:

```text
1.4.1
```

If full TV Wall/fleet functionality is delivered:

```text
1.5.0
```

Follow actual repository convention.

Never replace an already-released binary without changing version when materially different.

---

# 85. DOCUMENTATION

After P0 works, update:

```text
README.md
docs/SAMSUNG-F5500.md
docs/SINGLE-CONTROL-PANEL.md
docs/USER-MANUAL.md
CHANGELOG.md
```

Document:

```text
vMix setup
test source
HLS
known fleet
SSDP
AVTransport
pairing
pairing safety
cooldown
Start TV Wall
Stop TV Wall
physical verification
failure states
firewall
LAN security
```

---

# 86. FIREWALL

Windows inbound application port:

```text
8081
```

Do not open:

```text
55000
7676
```

as Windows inbound ports merely because TVs expose them.

Control Panel connects outbound to those TV ports.

---

# 87. TRUSTED LAN ONLY

Samsung legacy control protocols may be unauthenticated or weakly authenticated.

Document:

```text
trusted private LAN only
never expose TV control ports to Internet
never router-forward 55000/7676
never proxy proprietary TV control through Cloudflare
```

---

# 88. EXACT DEVELOPMENT ORDER

The evidence-backed resume order in
[`docs/SAMSUNG-CURRENT-STATUS.md`](docs/SAMSUNG-CURRENT-STATUS.md) takes
precedence over starting every phase below from zero. Keep the generic checks
below for any area that lacks current evidence, and update its status only
after the check runs.

Follow exactly:

```text
PHASE 0A
Reconcile repository + PR state

PHASE 0B
Fix all current CI failures

PHASE 0C
Verify StreamDBC server

PHASE 0D
Verify FFmpeg

PHASE 0E
Verify TEST source

PHASE 0F
Verify vMix source

PHASE 0G
Verify HLS

PHASE 0H
Load known fleet

PHASE 0I
Fix SSDP/direct-probe discovery

PHASE 0J
Select 192.168.1.81

PHASE 0K
Discover AVTransport

PHASE 0L
Determine whether AVTransport requires authorization

PHASE 0M
If NOT:
    SetAVTransportURI

If YES:
    execute safe one-time pairing flow

PHASE 0N
Play

PHASE 0O
GetTransportInfo

PHASE 0P
Require PLAYING

PHASE 0Q
Physical video confirmation

PHASE 0R
Physical audio confirmation

PHASE 0S
Repeat for remaining TVs

PHASE 0T
START TV WALL across fleet

PHASE 0U
Per-TV final validation

PHASE 1
Fleet dashboard

PHASE 2
Volume/Mute

PHASE 3
Pairing-dependent remote controls

PHASE 4
WOL/Power/Input

PHASE 5
Release
```

---

# 89. DO NOT DO THESE

Do not:

```text
spam pairing packets
brute-force authorization
retry DENIED pairing automatically
continuously reconnect to 55000
blindly send KEY_POWER
hardcode /smp_N_
hardcode PC LAN IP
scan entire subnet
send TV arbitrary URLs
allow renderer arbitrary sockets
call SOAP HTTP 200 playback success
claim physical video without observation
claim production-ready while checks are red
```

---

# 90. FINAL REPORT

Return a final structured report:

```text
STATUS

REPOSITORY:
BRANCH:
PR:
HEAD SHA:
MERGE SHA:
VERSION:

CI:
CodeQL:
Desktop:
Samsung Gateway:
Windows Build:

SERVER:
FFmpeg:
Source:
Gateway:
HLS:
LAN IP:

FLEET:

TV-81
IP:
MAC:
ONLINE:
MODEL:
PAIRING:
AVTRANSPORT:
RUNBROWSER:
BROWSER PAGE:
PLAYLIST FETCHED:
LATEST SEGMENT FETCHED:
SET URI:
PLAY:
TRANSPORT:
VIDEO:
AUDIO:
ERROR:

TV-82
...

TV-89
...

TV-90
...

TV-91
...

SUMMARY:
Known:
Online:
Playing:
Pair Required:
Authorized:
Physical Video Confirmed:

SECURITY:
Pairing rate limit:
Cooldown:
Identity validation:
Private-LAN validation:

BLOCKERS:

NEXT ACTION:
```

If Codex cannot physically see the television:

```text
SOFTWARE PLAYBACK CONFIRMED
PHYSICAL TV OBSERVATION REQUIRED
```

Never invent physical evidence.

---

# 91. DEFINITION OF DONE

The primary live-browser milestone is complete only when:

> StreamDBC reliably serves compatible media over the physical LAN, the Samsung browser opens `/tv/`, fetches and decodes live HLS, and the operator confirms live video and audio on the physical TV.

Use AVTransport `SetAVTransportURI` / `Play` / `GetTransportInfo` to validate
the known-good MP4 baseline or other media that the TV actually accepts. Do
not require AVTransport to accept HLS when the firmware returns
`Illegal MIME-type`.

Fleet milestone is complete only when:

> START TV WALL controls all available supported televisions with independent per-TV status, safe authorization behavior, bounded retries, and no pairing spam.

Production milestone is complete only when:

```text
required CI is green
security checks pass
Windows build succeeds
TV playback is physically verified
pairing behavior is safe
fleet results are accurately reported
```

Continue working through failures until the current priority phase is complete.

Do not divert into unrelated work.
