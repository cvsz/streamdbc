# Samsung TV Wall: Current Status and Next Actions

- **Snapshot:** 2026-10-09
- **Working branch:** `fix/client-close-exit-status`
- **Distribution state:** workspace changes are not rebuilt into the installed Windows Control Panel.

This is the operational source of truth for the five-TV Samsung F5500 work.
The two Samsung master prompts and operator guides should defer to this dated
checkpoint whenever older instructions disagree with the current checkout.

## Evidence recorded

| Area | Result | Evidence boundary |
|---|---|---|
| StreamDBC gateway | `LIVE`; playlist ready; a current MPEG-TS segment returned HTTP 200 and the playlist advanced | PC-side delivery is confirmed; this does not establish TV decode |
| TV discovery | TV-81, TV-82, TV-89, TV-90 and TV-91 online | Discovery and advertised services were verified in the Control Panel log |
| MP4 baseline | URI/Play accepted on all five; the operator confirmed picture and sound on all five | The initial AVTransport query showed `TRANSITIONING`, not `PLAYING` |
| HLS over AVTransport | Rejected earlier on all five with `Illegal MIME-type` | Do not count an HTTP 200 or a successful `Play` after a rejected URI as TV playback |
| Live Browser | `RunBrowser` was acknowledged by all five in the latest reported run | The operator later reported that Live Browser showed `Offline`; the affected TV IDs were not recorded |
| HDMI inputs | Latest command/read-back confirmed all five on a connected HDMI input | TV-81/82/89/91: HDMI1 (source ID 57); TV-90: HDMI2 (source ID 58). The operator previously confirmed an HDMI picture on all five; no new visual check followed this latest command |
| Close-button error | The installed app reported `Error: Tray is destroyed` while a child process was exiting | A source guard is in the workspace. Syntax and whitespace checks passed; runtime close behavior has not been retested and the installed app has not been rebuilt |

The Windows PC was observed at `192.168.1.85` during these operations. Detect
the active LAN address at runtime; do not persist that address as a product
constant.

## Source and endpoint constraints

`configs/samsung-f5500.yaml` uses `source: vmix_external`, which captures the
`vMix Video` and `vMix Audio` DirectShow devices. In this checkout, RTMP media
ingest is not implemented: port 1935 is a bounded control adapter and does not
accept an RTMP audio/video stream. The RTMP destination supplied during setup
must not be treated as verified input until the exact running executable and
configuration prove otherwise.

The Samsung HTTP profile serves the browser page and HLS under port 8081. The
PC-side live status and a successful `RunBrowser` SOAP reply do not prove that
the legacy TV browser fetched or decoded the HLS stream. AVTransport also does
not report browser playback state.

## Ordered next actions

### P0: Update and verify the Control Panel close fix

- Build the current Windows workspace on Windows, preserving the existing
  installer/runtime artifacts and unrelated uncommitted changes. Inspect the
  diff first; do not reset or switch branches.
- Use the native Windows build flow. Do not run the Windows-only
  `client/scripts/prepare-server-runtime.js` from WSL: it clears
  `client/server-runtime` before checking the host platform.
- Install the resulting Control Panel build and start the managed StreamDBC
  server.
- Close the main window with **X**. Confirm there is no `Tray is destroyed`
  exception, the application exits, and the managed server process tree is
  gone.
- Record the exact app version and build SHA. The current installed `app.asar`
  is still the old build until this is done.

### P0: Find why Live Browser reports Offline

- Start with one TV, preferably TV-81. Record the TV ID, exact URL, time, and
  exact screen message for every attempt.
- From that TV, check `/tv/ping`, `/tv/test.mp4`, `/tv/live/index.m3u8`, and the
  newest segment separately. A PC-side HTTP 200 is not a TV-side fetch check.
- Compare opening `/tv/` manually with launching it through `RunBrowser`.
- Keep the earlier AVTransport HLS `Illegal MIME-type` result separate from the
  MP4 baseline and browser path; do not repeat the same rejected media URI
  without a compatibility change.
- Capture the page's actual `error`/`stalled` state and inspect the served
  playlist, segment MIME type, codecs and segment continuity. Do not infer the
  failure from a SOAP acknowledgement or an advancing playlist.
- Do not repeat a command when a TV gives no SOAP response; first inspect the
  screen and current state.

### P0: Prove live video and audio, then repeat across the fleet

- On one TV, require visible moving live video and audible live audio from the
  Samsung browser path. Record this separately from the already-confirmed MP4
  and HDMI results.
- Once one TV passes, repeat sequentially on TV-82, TV-89, TV-90 and TV-91.
- Record each TV's browser result independently. Do not use `RunBrowser`
  acceptance or `PLAYING` from a different playback path as proof.

### P1: Recovery, soak and release evidence

- Verify recovery after vMix/source stop and restart, TV reboot, and Wi-Fi
  interruption.
- Run a 30-minute initial soak, then the two-hour and four-hour checks from the
  Samsung acceptance prompts. Record CPU/RAM, gateway restart count, playlist
  advancement, and browser stability.
- Reconcile the exact Git head, local changes, Windows package version, CI,
  CodeQL and build artifacts before making a release claim.
- Update this checkpoint and the prompt acceptance checkboxes only when new
  evidence is available.

## Current completion statement

- **PASS:** five-TV discovery; MP4 picture and sound reported on all five;
  HDMI source read-back on all five.
- **FAIL / unresolved:** Live Browser displays `Offline` despite PC-side HLS
  readiness and five acknowledged browser-launch commands.
- **NOT TESTED:** live HLS picture/audio on a TV; post-fix close behavior in a
  rebuilt Windows app; source/Wi-Fi recovery; soak; current branch CI and
  release verification.

Do not report live Samsung browser playback as complete until the physical
video and audio checks pass on the required TVs.
