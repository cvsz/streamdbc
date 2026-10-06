package dev.zeaz.streamdbc.tv;

import android.view.Surface;

public final class NdiReceiver {
    static {
        System.loadLibrary("streamdbc_ndi");
    }

    public boolean isAvailable() {
        return nativeIsAvailable();
    }

    public String[] listSources() {
        String[] sources = nativeListSources();
        return sources == null ? new String[0] : sources;
    }

    public boolean start(String sourceName, Surface surface) {
        if (sourceName == null || sourceName.isBlank() || surface == null || !surface.isValid()) {
            return false;
        }
        return nativeStart(sourceName, surface);
    }

    public void stop() {
        nativeStop();
    }

    private static native boolean nativeIsAvailable();
    private static native String[] nativeListSources();
    private static native boolean nativeStart(String sourceName, Surface surface);
    private static native void nativeStop();
}
