# StreamDBC TV production gates

## Implemented in this change

- Android TV-only launcher and landscape playback UI.
- Media3 RTSP playback with RTP-over-TCP as the conservative default.
- Bounded reconnect backoff.
- Strict RTSP/RTSPS URI validation.
- Credential/query redaction for display.
- At-rest encryption of saved RTSP URIs with AES-256-GCM keys held by Android Keystore.
- Saved channel profiles and last-channel selection.
- No RTSP URI or credential logging.
- CI unit test, Android lint, and APK build gates.
- Release minification/resource shrinking configuration.

## Required external evidence before production declaration

The repository must not be labelled production-ready until these are completed against the target hardware and network:

1. CI passes on the final commit.
2. Signed release APK/AAB is generated with an organization-controlled Android signing key.
3. Real-device tests pass on each supported Android TV / Google TV device family.
4. At least 24-hour playback soak test passes for representative H.264/H.265 RTSP cameras.
5. Network interruption, camera reboot, DNS failure, Wi-Fi roaming, and credential rotation recovery are tested.
6. Hardware decoder limits are measured before enabling multi-view.
7. RTSP endpoints are reachable only on trusted LAN/VPN networks; public TCP/554 exposure is not accepted as the default deployment.
8. Backup/restore expectations for channel configuration are documented. Android Keystore-bound encrypted URIs are intentionally not portable as plaintext secrets.
9. Dependency/security scanning is reviewed for the release commit.
10. StreamDBC RTSP output integration remains blocked until the server has verified RTP media forwarding; current control/session adapters are not a media plane.

## Signing

Release builds must use a private signing key managed outside Git. Do not commit keystores, passwords, API keys, or RTSP credentials. CI release signing should be added only after repository/environment secrets are provisioned and branch/environment protection is configured.
