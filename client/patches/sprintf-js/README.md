# StreamDBC patched `sprintf-js`

This is a local BSD-3-Clause fork of upstream `sprintf-js` 1.1.3, used only by the Windows build toolchain. It bounds `e` and `f` precision to 0–100 and `g` precision to 1–100 before calling JavaScript number-formatting methods. Values above the supported maximum are capped; `g` precision zero is normalized to one.

The local package version `1.1.4+streamdbc.1` identifies this patch and is not an upstream release. Keep the patch until upstream publishes and we validate a fixed release for GHSA-hp3w-g68c-fv3c.
