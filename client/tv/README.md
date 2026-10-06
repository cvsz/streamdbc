# StreamDBC TV

Native Android TV / Google TV RTSP client for StreamDBC.

## Current scope

This client plays an RTSP URL directly with AndroidX Media3/ExoPlayer. It intentionally does **not** assume that the current StreamDBC RTSP output adapter carries RTP media. The repository currently documents that RTSP ingest/output are bounded control/session adapters and that media forwarding is not yet implemented.

## Features

- Native Android TV launcher
- RTSP / RTSPS playback
- RTP-over-TCP by default for NAT/Wi-Fi stability
- Hardware-decoder path through Media3
- Full-screen playback
- D-pad / media play-pause handling
- Automatic reconnect with bounded backoff
- Stream URL validation
- Screen keep-awake
- No logging of RTSP credentials

## Build

Requirements:

- JDK 17
- Android SDK 35
- Gradle compatible with AGP 8.7.x

From `client/tv`:

```bash
gradle :app:assembleDebug
```

Install:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The default development URL is `rtsp://192.168.1.100:554/stream1`. Replace it in the TV UI with the real camera/media-server URL.

For production, avoid embedding credentials in source. Prefer private LAN/VPN access over exposing RTSP directly to the Internet.

## Next production steps

1. Persist channel profiles with credentials protected by Android Keystore.
2. Add channel browser and last-channel startup behavior.
3. Add API-driven device/channel provisioning against the StreamDBC management plane.
4. Add release signing and GitHub Actions Android builds.
5. Test representative RTSP cameras plus long-running soak tests.
6. Integrate with StreamDBC RTSP output only after the server has a verified RTP media plane.
