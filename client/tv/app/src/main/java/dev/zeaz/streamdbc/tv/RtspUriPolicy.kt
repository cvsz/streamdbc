package dev.zeaz.streamdbc.tv

import java.net.URI

object RtspUriPolicy {
    private const val MAX_URI_LENGTH = 2048

    fun validate(value: String): Result<String> = runCatching {
        val candidate = value.trim()
        require(candidate.isNotEmpty()) { "RTSP URL is required" }
        require(candidate.length <= MAX_URI_LENGTH) { "RTSP URL is too long" }
        require(candidate.none { it.isISOControl() }) { "RTSP URL contains control characters" }

        val uri = URI(candidate)
        require(uri.scheme.equals("rtsp", true) || uri.scheme.equals("rtsps", true)) {
            "Only rtsp:// or rtsps:// URLs are accepted"
        }
        require(!uri.host.isNullOrBlank()) { "RTSP URL must include a host" }
        candidate
    }

    fun redact(value: String): String {
        val uri = runCatching { URI(value) }.getOrNull() ?: return "<invalid RTSP URL>"
        val authority = buildString {
            append(uri.host ?: "unknown")
            if (uri.port != -1) append(":").append(uri.port)
        }
        val path = uri.rawPath.orEmpty().ifBlank { "/" }
        val queryMarker = if (uri.rawQuery.isNullOrBlank()) "" else "?…"
        return "${uri.scheme}://$authority$path$queryMarker"
    }
}
