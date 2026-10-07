# Samsung UA40F5500 Legacy launcher

This is a Samsung Smart TV Legacy Platform (2013 / Orsay) JavaScript project.
It is **not** a Tizen project and must not be packaged with Tizen Studio.

The launcher performs one task:

```text
open app
  -> http://192.168.1.100:8081/tv/
  -> StreamDBC kiosk player
```

The target URL is intentionally fixed for the deployed vMix/StreamDBC host.

## Files

Samsung Legacy JavaScript projects require at least `index.html` and
`config.xml`. `widget.info` pins the legacy logical screen to 960x540.

## Packaging for the physical 2013 TV

Use Samsung TV SDK for Legacy Platform (SDK 4.5 generation for 2013 devices).
Tizen Studio cannot create a Legacy Platform package.

For USB testing on a 2013 TV, Samsung requires the target TV DUID and a
Samsung Apps TV Seller Office `.sig` file. On the TV open:

```text
Store -> More Apps
```

then press:

```text
Fast Forward, 2, 8, 9, 2
```

Record the DUID and request the signature from Samsung Apps TV Seller Office
support. Put the SDK-built application package and the signature file in the
USB drive root. Some models expect `cpdeveloper.sig` to be named
`developer.sig`.

`scripts/windows/build-samsung-f5500-usb.ps1` prepares the source archive and
USB staging directory, but it intentionally does not fabricate a Samsung
signature or claim that a raw ZIP replaces the Legacy SDK package step.
