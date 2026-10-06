package dev.zeaz.streamdbc.tv;

public final class NdiRuntime {
    private static final boolean AVAILABLE;

    static {
        boolean loaded;
        try {
            System.loadLibrary("ndi");
            loaded = true;
        } catch (UnsatisfiedLinkError | SecurityException error) {
            loaded = false;
        }
        AVAILABLE = loaded;
    }

    private NdiRuntime() {}

    public static boolean isAvailable() {
        return AVAILABLE;
    }
}
