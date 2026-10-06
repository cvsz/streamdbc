# NDI SDK staging directory

Do not commit NDI SDK binaries or headers unless your license expressly permits
redistribution.

To enable native NDI receive, copy files from the official Android NDI SDK into
this normalized local layout:

```text
vendor/ndi/
├── include/
│   └── Processing.NDI.Lib.h
└── jniLibs/
    ├── arm64-v8a/
    │   └── libndi.so
    └── armeabi-v7a/
        └── libndi.so   # only if your SDK/device support it
```

The default CI build does not require these files. When both the header and the
ABI-specific library are present, CMake builds the real receiver path.
