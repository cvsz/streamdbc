package auth

import (
	"net/url"
	"strings"
)

// SplitStreamToken splits a stream identifier of the form "id?token=..."
// into its stream ID and token parts. Identifiers without a query string
// yield an empty token.
func SplitStreamToken(raw string) (string, string) {
	idx := strings.Index(raw, "?")
	if idx < 0 {
		return raw, ""
	}
	token := ""
	if query, err := url.ParseQuery(raw[idx+1:]); err == nil {
		token = query.Get("token")
	}
	return raw[:idx], token
}

// TokenFromHeader extracts a bearer token from an Authorization header value.
func TokenFromHeader(header string) string {
	const prefix = "Bearer "
	if strings.HasPrefix(header, prefix) {
		return strings.TrimSpace(strings.TrimPrefix(header, prefix))
	}
	return ""
}

// Authorize validates a publish/play token for streamID from ip. A nil manager
// permits all requests. When action is "play" and no token is presented,
// anonymous access is allowed only if the manager permits it.
func Authorize(m *Manager, token, action, streamID, ip string) bool {
	if m == nil {
		return true
	}
	if token == "" && action == "play" && m.AllowAnonymous() {
		return true
	}
	claims, err := m.ValidateToken(token)
	if err != nil {
		return false
	}
	switch action {
	case "publish":
		return m.CanPublishFromIP(claims, streamID, ip)
	case "play":
		return m.CanPlayFromIP(claims, streamID, ip)
	default:
		return false
	}
}
