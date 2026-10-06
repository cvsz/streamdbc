package dev.zeaz.streamdbc.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RtspUriPolicyTest {
    @Test
    fun acceptsRtspAndRtsps() {
        assertTrue(RtspUriPolicy.validate("rtsp://camera.local/live").isSuccess)
        assertTrue(RtspUriPolicy.validate("rtsps://camera.example:322/live").isSuccess)
    }

    @Test
    fun rejectsWrongSchemeMissingHostAndControlCharacters() {
        assertTrue(RtspUriPolicy.validate("https://camera.local/live").isFailure)
        assertTrue(RtspUriPolicy.validate("rtsp:///live").isFailure)
        assertTrue(RtspUriPolicy.validate("rtsp://camera.local/live\nsecret").isFailure)
    }

    @Test
    fun redactsCredentialsAndQueryValues() {
        assertEquals(
            "rtsp://camera.local:554/live?…",
            RtspUriPolicy.redact("rtsp://admin:password@camera.local:554/live?token=secret")
        )
    }
}
