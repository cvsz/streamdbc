package dev.zeaz.streamdbc.tv;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Objects;

public final class StreamConfig {
    private final String name;
    private final String url;

    public StreamConfig(String name, String url) {
        this.name = normalizeName(name);
        this.url = validateUrl(url);
    }

    public String name() { return name; }
    public String url() { return url; }

    public String redactedUrl() {
        try {
            URI uri = new URI(url);
            if (uri.getUserInfo() == null) return url;
            return new URI(uri.getScheme(), "***:***", uri.getHost(), uri.getPort(),
                    uri.getPath(), uri.getQuery(), uri.getFragment()).toString();
        } catch (URISyntaxException e) {
            return "rtsp://***";
        }
    }

    private static String normalizeName(String value) {
        String v = value == null ? "" : value.trim();
        if (v.isEmpty()) throw new IllegalArgumentException("Channel name is required");
        if (v.length() > 80) throw new IllegalArgumentException("Channel name is too long");
        return v;
    }

    public static String validateUrl(String value) {
        String v = value == null ? "" : value.trim();
        if (v.length() > 2048) throw new IllegalArgumentException("RTSP URL is too long");
        try {
            URI uri = new URI(v);
            if (!"rtsp".equalsIgnoreCase(uri.getScheme())) {
                throw new IllegalArgumentException("Only rtsp:// URLs are supported");
            }
            if (uri.getHost() == null || uri.getHost().isBlank()) {
                throw new IllegalArgumentException("RTSP host is required");
            }
            if (uri.getPort() < -1 || uri.getPort() > 65535) {
                throw new IllegalArgumentException("Invalid RTSP port");
            }
            return v;
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("Invalid RTSP URL", e);
        }
    }

    @Override public boolean equals(Object other) {
        if (!(other instanceof StreamConfig that)) return false;
        return name.equals(that.name) && url.equals(that.url);
    }

    @Override public int hashCode() { return Objects.hash(name, url); }
}
