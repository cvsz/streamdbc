package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cvsz/stremdbc/internal/auth"
	"github.com/cvsz/stremdbc/internal/config"
	"github.com/cvsz/stremdbc/internal/core"
	"github.com/cvsz/stremdbc/internal/metrics"
	"go.uber.org/zap"
)

func newTestServer(t *testing.T) *Server {
	t.Helper()
	cfg := config.DefaultConfig()
	registry := core.NewStreamRegistry(cfg)
	server := NewServer(&cfg.API, registry, metrics.NewMetrics(), zap.NewNop())
	server.SetVersion("test")
	return server
}

func TestHealthAndStats(t *testing.T) {
	server := newTestServer(t)
	for _, path := range []string{"/health", "/health/live", "/health/ready", "/api/v1/stats"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		res := httptest.NewRecorder()
		server.Handler().ServeHTTP(res, req)
		if res.Code != http.StatusOK {
			t.Fatalf("%s returned %d: %s", path, res.Code, res.Body.String())
		}
	}
}

func TestMutationRequiresAPIKeyWhenAuthEnabled(t *testing.T) {
	server := newTestServer(t)
	manager, err := auth.NewManager("0123456789abcdef0123456789abcdef0123456789abcdef", "15m", []string{"secret-key-123456"}, false)
	if err != nil {
		t.Fatalf("new auth manager: %v", err)
	}
	server.SetAuthManager(manager)

	body := `{"id":"demo","name":"Demo"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/streams", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	server.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without API key, got %d", res.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/streams", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", "secret-key-123456")
	res = httptest.NewRecorder()
	server.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusCreated {
		t.Fatalf("expected 201 with API key, got %d: %s", res.Code, res.Body.String())
	}
}

func TestAnonymousPlaybackDoesNotAuthorizeManagementMutations(t *testing.T) {
	server := newTestServer(t)
	manager, err := auth.NewManager("0123456789abcdef0123456789abcdef0123456789abcdef", "15m", []string{"secret-key-123456"}, true)
	if err != nil {
		t.Fatalf("new auth manager: %v", err)
	}
	server.SetAuthManager(manager)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/streams", strings.NewReader(`{"id":"demo"}`))
	res := httptest.NewRecorder()
	server.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous mutation returned %d: %s", res.Code, res.Body.String())
	}
}

func TestTokenEndpoint(t *testing.T) {
	server := newTestServer(t)
	manager, err := auth.NewManager("0123456789abcdef0123456789abcdef0123456789abcdef", "15m", []string{"secret-key-123456"}, false)
	if err != nil {
		t.Fatalf("new auth manager: %v", err)
	}
	server.SetAuthManager(manager)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/token", strings.NewReader(`{"stream_id":"demo","action":"play"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", "secret-key-123456")
	res := httptest.NewRecorder()
	server.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusCreated {
		t.Fatalf("expected token creation, got %d: %s", res.Code, res.Body.String())
	}
	var payload map[string]string
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload["token"] == "" {
		t.Fatal("token response should contain a token")
	}
}

func TestCreateStreamRejectsTrailingJSONAndUnsafeID(t *testing.T) {
	server := newTestServer(t)
	for _, body := range []string{
		`{"id":"demo","name":"Demo"}{"id":"second"}`,
		`{"id":"../secret","name":"Secret"}`,
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/streams", strings.NewReader(body))
		res := httptest.NewRecorder()
		server.Handler().ServeHTTP(res, req)
		if res.Code != http.StatusBadRequest {
			t.Fatalf("body %q: expected 400, got %d: %s", body, res.Code, res.Body.String())
		}
	}
}

func TestCORSRejectsDisallowedPreflight(t *testing.T) {
	server := newTestServer(t)
	server.config.CORSOrigins = []string{"https://trusted.example"}
	req := httptest.NewRequest(http.MethodOptions, "/api/v1/streams", nil)
	req.Header.Set("Origin", "https://attacker.example")
	res := httptest.NewRecorder()
	server.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("expected disallowed preflight to return 403, got %d", res.Code)
	}
}

func TestStaticPlaybackRequiresPlayTokenWhenAuthenticationIsRequired(t *testing.T) {
	server := newTestServer(t)
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "demo"), 0o700); err != nil {
		t.Fatalf("create stream directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "demo", "index.m3u8"), []byte("#EXTM3U\n"), 0o600); err != nil {
		t.Fatalf("write playlist: %v", err)
	}
	server.SetStaticRoutes(dir, "", "", "")
	manager, err := auth.NewManager("0123456789abcdef0123456789abcdef0123456789abcdef", "15m", []string{"secret-key-123456"}, false)
	if err != nil {
		t.Fatalf("new auth manager: %v", err)
	}
	server.SetAuthManager(manager)

	req := httptest.NewRequest(http.MethodGet, "/hls/demo/index.m3u8", nil)
	res := httptest.NewRecorder()
	server.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized playback, got %d", res.Code)
	}

	token, err := manager.GeneratePlayToken("demo", server.clientIP(req))
	if err != nil {
		t.Fatalf("generate play token: %v", err)
	}
	req = httptest.NewRequest(http.MethodGet, "/hls/demo/index.m3u8?token="+token, nil)
	res = httptest.NewRecorder()
	server.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("expected authorized playback, got %d: %s", res.Code, res.Body.String())
	}
}

func TestStaticDirectoryIndexCannotEscapeThroughSymlink(t *testing.T) {
	server := newTestServer(t)
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.html"), []byte("secret"), 0o600); err != nil {
		t.Fatalf("write outside file: %v", err)
	}
	if err := os.Mkdir(filepath.Join(root, "sub"), 0o700); err != nil {
		t.Fatalf("create static subdirectory: %v", err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.html"), filepath.Join(root, "sub", "index.html")); err != nil {
		t.Fatalf("create symlink: %v", err)
	}
	server.SetStaticRoutes("", "", "", root)
	res := httptest.NewRecorder()
	server.Handler().ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/dashboard/sub/", nil))
	if res.Code != http.StatusNotFound {
		t.Fatalf("symlink escape returned %d: %s", res.Code, res.Body.String())
	}
}

func TestMetricsConfigurationControlsOnlyConfiguredPath(t *testing.T) {
	server := newTestServer(t)
	server.SetMetricsConfig(true, "/internal/metrics")
	for _, path := range []string{"/metrics", "/internal/metrics"} {
		res := httptest.NewRecorder()
		server.Handler().ServeHTTP(res, httptest.NewRequest(http.MethodGet, path, nil))
		if path == "/metrics" && res.Code != http.StatusNotFound {
			t.Fatalf("default metrics path returned %d", res.Code)
		}
		if path == "/internal/metrics" && res.Code != http.StatusOK {
			t.Fatalf("configured metrics path returned %d", res.Code)
		}
	}
}

func TestMetricsConfigurationRejectsDynamicRouteShadowing(t *testing.T) {
	server := newTestServer(t)
	server.SetMetricsConfig(true, "/api/v1/streams/demo")
	res := httptest.NewRecorder()
	server.Handler().ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/streams/demo", nil))
	if res.Code != http.StatusNotFound {
		t.Fatalf("shadowed stream route returned %d: %s", res.Code, res.Body.String())
	}
}

func TestMetricsConfigurationRejectsStaticRouteShadowing(t *testing.T) {
	server := newTestServer(t)
	server.SetStaticRoutes("", "", "", t.TempDir())
	server.SetMetricsConfig(true, "/dashboard")
	res := httptest.NewRecorder()
	server.Handler().ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/dashboard", nil))
	if res.Code != http.StatusTemporaryRedirect {
		t.Fatalf("static dashboard route was shadowed by metrics, got %d: %s", res.Code, res.Body.String())
	}
}

func TestTrustedProxyClientIP(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.API.TrustedProxies = []string{"192.0.2.1"}
	server := NewServer(&cfg.API, core.NewStreamRegistry(cfg), metrics.NewMetrics(), zap.NewNop())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/info", nil)
	req.RemoteAddr = "192.0.2.1:12345"
	req.Header.Set("X-Forwarded-For", "198.51.100.7, 192.0.2.1")
	if got := server.clientIP(req); got != "198.51.100.7" {
		t.Fatalf("trusted proxy client IP = %q", got)
	}

	cfg = config.DefaultConfig()
	server = NewServer(&cfg.API, core.NewStreamRegistry(cfg), metrics.NewMetrics(), zap.NewNop())
	if got := server.clientIP(req); got != "192.0.2.1" {
		t.Fatalf("untrusted proxy header was accepted: %q", got)
	}
}

func TestManagementRateLimit(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.API.RateLimitPerMinute = 1
	server := NewServer(&cfg.API, core.NewStreamRegistry(cfg), metrics.NewMetrics(), zap.NewNop())
	for i, want := range []int{http.StatusOK, http.StatusTooManyRequests} {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/info", nil)
		req.RemoteAddr = "198.51.100.20:12345"
		res := httptest.NewRecorder()
		server.Handler().ServeHTTP(res, req)
		if res.Code != want {
			t.Fatalf("request %d returned %d, want %d", i+1, res.Code, want)
		}
	}
}

func TestSamsungTVPagesAndReadOnlyStatus(t *testing.T) {
	server := newTestServer(t)
	webDir := t.TempDir()
	for name, contents := range map[string]string{
		"index.html": "tv page",
		"basic.html": "basic page",
	} {
		if err := os.WriteFile(filepath.Join(webDir, name), []byte(contents), 0o600); err != nil {
			t.Fatalf("write TV page: %v", err)
		}
	}
	outputDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(outputDir, "index.m3u8"), []byte("#EXTM3U\n"), 0o600); err != nil {
		t.Fatalf("write TV playlist: %v", err)
	}
	cfg := config.DefaultConfig().SamsungTV
	cfg.Enable = true
	cfg.OutputPath = outputDir
	server.SetSamsungTV(nil, cfg, webDir)

	for path, want := range map[string]string{"/tv": "tv page", "/tv/": "tv page", "/tv/basic": "basic page"} {
		res := httptest.NewRecorder()
		server.Handler().ServeHTTP(res, httptest.NewRequest(http.MethodGet, path, nil))
		if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), want) {
			t.Errorf("GET %s returned %d with body %q", path, res.Code, res.Body.String())
		}
	}
	res := httptest.NewRecorder()
	server.Handler().ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/tv/status", nil))
	if res.Code != http.StatusOK {
		t.Fatalf("TV status returned %d: %s", res.Code, res.Body.String())
	}
	var status map[string]interface{}
	if err := json.Unmarshal(res.Body.Bytes(), &status); err != nil {
		t.Fatalf("decode TV status: %v", err)
	}
	if status["enabled"] != true || status["state"] != "stopped" || status["profile"] != cfg.Profile {
		t.Fatalf("unexpected TV status: %#v", status)
	}
	if _, exists := status["playlist_path"]; exists || strings.Contains(res.Body.String(), outputDir) {
		t.Fatalf("TV status exposed a local filesystem path: %s", res.Body.String())
	}
}

func TestSamsungTVHLSRouteEnforcesNamesMethodsAndCacheHeaders(t *testing.T) {
	server := newTestServer(t)
	webDir := t.TempDir()
	outputDir := t.TempDir()
	for name, contents := range map[string]string{
		"index.m3u8":        "#EXTM3U\nsegment_000001.ts\n",
		"segment_000001.ts": "mpegts",
	} {
		if err := os.WriteFile(filepath.Join(outputDir, name), []byte(contents), 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	cfg := config.DefaultConfig().SamsungTV
	cfg.Enable = true
	cfg.OutputPath = outputDir
	server.SetSamsungTV(nil, cfg, webDir)

	for _, test := range []struct {
		path        string
		contentType string
		cache       string
	}{
		{path: "/tv/live/index.m3u8", contentType: "application/vnd.apple.mpegurl", cache: "no-cache, no-store, must-revalidate"},
		{path: "/tv/live/segment_000001.ts", contentType: "video/mp2t", cache: "public, max-age=2"},
	} {
		res := httptest.NewRecorder()
		server.Handler().ServeHTTP(res, httptest.NewRequest(http.MethodGet, test.path, nil))
		if res.Code != http.StatusOK || res.Header().Get("Content-Type") != test.contentType || res.Header().Get("Cache-Control") != test.cache {
			t.Errorf("GET %s: status=%d content-type=%q cache=%q", test.path, res.Code, res.Header().Get("Content-Type"), res.Header().Get("Cache-Control"))
		}
	}
	for _, path := range []string{"/tv/live/", "/tv/live/../secret", "/tv/live/%2e%2e/secret", "/tv/live/segment_123.ts", "/tv/live/segment_000001.ts/"} {
		res := httptest.NewRecorder()
		server.Handler().ServeHTTP(res, httptest.NewRequest(http.MethodGet, path, nil))
		if res.Code != http.StatusNotFound {
			t.Errorf("unsafe or directory URL %s returned %d", path, res.Code)
		}
	}
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		res := httptest.NewRecorder()
		server.Handler().ServeHTTP(res, httptest.NewRequest(method, "/tv/live/index.m3u8", nil))
		if res.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s returned %d, want 405", method, res.Code)
		}
	}
	res := httptest.NewRecorder()
	server.Handler().ServeHTTP(res, httptest.NewRequest(http.MethodHead, "/tv/live/segment_000001.ts", nil))
	if res.Code != http.StatusOK || res.Body.Len() != 0 {
		t.Errorf("HEAD segment returned status=%d body=%q", res.Code, res.Body.String())
	}
}

func TestSamsungTVHLSRouteIsNotExposedWhenDisabled(t *testing.T) {
	server := newTestServer(t)
	outputDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(outputDir, "index.m3u8"), []byte("#EXTM3U\n"), 0o600); err != nil {
		t.Fatalf("write stale TV playlist: %v", err)
	}
	cfg := config.DefaultConfig().SamsungTV
	cfg.OutputPath = outputDir
	server.SetSamsungTV(nil, cfg, t.TempDir())
	res := httptest.NewRecorder()
	server.Handler().ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/tv/live/index.m3u8", nil))
	if res.Code != http.StatusNotFound {
		t.Fatalf("disabled Samsung gateway exposed stale playlist with status %d", res.Code)
	}
}

func TestSamsungTVHLSRouteReturnsNotFoundBeforePlaylistExists(t *testing.T) {
	server := newTestServer(t)
	cfg := config.DefaultConfig().SamsungTV
	cfg.Enable = true
	cfg.OutputPath = t.TempDir()
	server.SetSamsungTV(nil, cfg, t.TempDir())
	res := httptest.NewRecorder()
	server.Handler().ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/tv/live/index.m3u8", nil))
	if res.Code != http.StatusNotFound {
		t.Fatalf("missing TV playlist returned status %d, want 404", res.Code)
	}
}

func TestSamsungTVMutationsRequireAPIKeyAndRejectUnknownBodyFields(t *testing.T) {
	server := newTestServer(t)
	cfg := config.DefaultConfig().SamsungTV
	server.SetSamsungTV(nil, cfg, t.TempDir())

	request := func(key, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/tv/start", strings.NewReader(body))
		if key != "" {
			req.Header.Set("X-API-Key", key)
		}
		res := httptest.NewRecorder()
		server.Handler().ServeHTTP(res, req)
		return res
	}
	if res := request("", `{}`); res.Code != http.StatusServiceUnavailable {
		t.Fatalf("anonymous TV management returned %d: %s", res.Code, res.Body.String())
	}
	manager, err := auth.NewManager("0123456789abcdef0123456789abcdef0123456789abcdef", "15m", []string{"secret-key-123456"}, false)
	if err != nil {
		t.Fatalf("new auth manager: %v", err)
	}
	server.SetAuthManager(manager)
	if res := request("", `{}`); res.Code != http.StatusUnauthorized {
		t.Fatalf("TV management without API key returned %d", res.Code)
	}
	if res := request("secret-key-123456", `{"unknown":true}`); res.Code != http.StatusBadRequest {
		t.Fatalf("TV management accepted unknown fields: %d %s", res.Code, res.Body.String())
	}
	if res := request("secret-key-123456", `{}`); res.Code != http.StatusServiceUnavailable {
		t.Fatalf("TV management with valid key and no manager returned %d", res.Code)
	}
}

func TestSamsungTVHLSRouteCannotEscapeThroughSymlink(t *testing.T) {
	server := newTestServer(t)
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.ts"), []byte("secret"), 0o600); err != nil {
		t.Fatalf("write outside file: %v", err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.ts"), filepath.Join(root, "segment_000001.ts")); err != nil {
		t.Skipf("symlink creation unavailable: %v", err)
	}
	cfg := config.DefaultConfig().SamsungTV
	cfg.Enable = true
	cfg.OutputPath = root
	server.SetSamsungTV(nil, cfg, t.TempDir())
	res := httptest.NewRecorder()
	server.Handler().ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/tv/live/segment_000001.ts", nil))
	if res.Code != http.StatusNotFound {
		t.Fatalf("symlink escape returned %d: %s", res.Code, res.Body.String())
	}
}

func TestSamsungTVStartRequiresBoundedEmptyJSONBody(t *testing.T) {
	server := newTestServer(t)
	manager, err := auth.NewManager("0123456789abcdef0123456789abcdef0123456789abcdef", "15m", []string{"secret-key-123456"}, false)
	if err != nil {
		t.Fatalf("new auth manager: %v", err)
	}
	server.SetAuthManager(manager)
	server.SetSamsungTV(nil, config.DefaultConfig().SamsungTV, t.TempDir())
	for _, body := range []string{"", `[]`, `{"operation":"start"}`, `{} {}`, strings.Repeat(" ", 1200) + `{}`} {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/tv/start", strings.NewReader(body))
		req.Header.Set("X-API-Key", "secret-key-123456")
		res := httptest.NewRecorder()
		server.Handler().ServeHTTP(res, req)
		if res.Code != http.StatusBadRequest {
			t.Errorf("body %q returned %d, want 400", body, res.Code)
		}
	}
}
