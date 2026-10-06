# StreamDBC TV

Native Android TV / Google TV RTSP viewer.

## Controls

- LEFT / RIGHT: previous or next channel
- CENTER / ENTER: show or hide status overlay
- MENU: add, select, or remove channels
- PLAY / PLAY_PAUSE: retry current stream immediately

## Security

The complete saved channel list, including any RTSP user-info credentials, is
encrypted at rest with AES-256-GCM using a non-exportable Android Keystore key.
The app does not log RTSP URLs.

RTSP itself is normally plaintext. Use the TV and camera on a trusted LAN or
private VPN. Do not expose camera RTSP ports directly to the public Internet.

## Build

Requirements:

- JDK 17
- Android SDK Platform 36
- Android SDK Build Tools 36.0.0
- Gradle 9.6.0

```bash
gradle --no-daemon :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

## Release checklist

A production release still requires device-level evidence on representative
Android TV / Google TV hardware, real camera interoperability, long-running
reconnect/soak tests, signed APK/AAB key custody, and rollback testing.


## NDI

The TV client includes Android-native NDI discovery via `NsdManager`
(`_ndi._tcp.`) and detects whether the official `libndi.so` runtime is
packaged. NDI decode/playback remains fail-closed until the licensed official
NDI SDK/native receiver bridge is supplied and device-tested.

See [`ndi/README.md`](ndi/README.md) for the integration and release gates.
