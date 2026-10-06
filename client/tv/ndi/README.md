# Optional NDI Receiver Integration

StreamDBC TV performs Android-native NDI discovery with `NsdManager` using
`_ndi._tcp.`. Actual NDI decode/playback is intentionally gated on the
official NDI SDK and is not vendored in this repository.

## Why the SDK is not committed

NDI SDK binaries and headers are distributed under NDI/Vizrt licensing terms.
Do not copy `libndi.so`, SDK headers, Vendor IDs, license files, or other
restricted artifacts into this public repository unless redistribution is
explicitly permitted by the applicable license.

Official SDK:
https://ndi.video/for-developers/ndi-sdk/

Official Android platform notes:
https://docs.ndi.video/all/developing-with-ndi/sdk/platform-considerations

## Expected production integration

A release that claims NDI playback must provide and verify all of the following:

1. Official Android NDI SDK for every supported TV ABI.
2. Native receiver binding using the official SDK ABI.
3. `NsdManager` kept alive while NDI finder/receiver instances exist.
4. Video rendering with bounded frame queues and no UI-thread decode.
5. Audio output with A/V synchronization.
6. Receiver reconnect, source-loss recovery, and discovery refresh.
7. Soak tests for High Bandwidth NDI, HX2, and HX3 sources supported by the licensed SDK.
8. Tests on both 64-bit and any intentionally supported 32-bit Android TV firmware.
9. License/Vendor-ID compliance for commercial distribution.

## Current fail-closed behavior

`NdiRuntime.isAvailable()` checks whether the official `libndi.so` runtime is
installed in the APK/runtime. Discovery is usable without bundling the SDK.
Selecting an NDI source for decode must remain disabled until the native
receiver implementation and licensed runtime are supplied and device-tested.
