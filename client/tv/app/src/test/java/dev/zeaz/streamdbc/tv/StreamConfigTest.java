package dev.zeaz.streamdbc.tv;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

public final class StreamConfigTest {
    @Test
    public void acceptsRtspAndRedactsCredentials() {
        StreamConfig config = new StreamConfig("Front Gate", "rtsp://admin:secret@192.168.1.50:554/live");
        assertEquals("Front Gate", config.name());
        assertFalse(config.redactedUrl().contains("admin"));
        assertFalse(config.redactedUrl().contains("secret"));
        assertEquals("rtsp://***:***@192.168.1.50:554/live", config.redactedUrl());
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsHttp() {
        new StreamConfig("Bad", "http://example.com/live");
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsMissingHost() {
        new StreamConfig("Bad", "rtsp:///live");
    }
}
