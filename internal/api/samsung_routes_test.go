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
	samsunggateway "github.com/cvsz/stremdbc/internal/gateway/samsung"
)

const testSamsungSecret = "0123456789abcdef0123456789abcdef0123456789abcdef"

func newSamsungTestServer(t *testing.T, enableGateway bool) *Server {
	t.Helper()
	cfg := config.DefaultConfig().SamsungTV
	cfg.Enable = enableGateway
	cfg.OutputPath = t.TempDir()
	if enableGateway {
		// The manager is never started; the executable only needs to
		// resolve so the /tv/live routes are registered.
		fake := filepath.Join(t.TempDir(), "fake-ffmpeg")
		if err := os.WriteFile(fake, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
			t.Fatal(err)
		}
		cfg.FFmpegPath = fake
	}
	manager, err := samsunggateway.NewManager(&cfg, nil)
	if err != nil {
		t.Fatalf("create Samsung gateway: %v", err)
	}
	server := newTestServer(t)
	server.SetSamsungTV(manager, cfg, filepath.Join("..", "..", "web", "tv"))
	return server
}

func TestTVPingIsOpenProbe(t *testing.T) {
	server := newSamsungTestServer(t, false)
	for _, path := range []string{"/tv/ping", "/api/v1/tv/ping"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		res := httptest.NewRecorder()
		server.Handler().ServeHTTP(res, req)
		if res.Code != http.StatusOK || strings.TrimSpace(res.Body.String()) != "pong" {
			t.Fatalf("GET %s returned %d %q", path, res.Code, res.Body.String())
		}
		if contentType := res.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "text/plain") {
			t.Fatalf("GET %s content-type = %q", path, contentType)
		}
	}
	req := httptest.NewRequest(http.MethodPost, "/tv/ping", nil)
	res := httptest.NewRecorder()
	server.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /tv/ping returned %d", res.Code)
	}
}

func TestTVPagesServeWithoutLiveGateway(t *testing.T) {
	server := newSamsungTestServer(t, false)
	for path, marker := range map[string]string{"/tv": "video", "/tv/basic": "video"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		res := httptest.NewRecorder()
		server.Handler().ServeHTTP(res, req)
		if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), marker) {
			t.Fatalf("GET %s returned %d", path, res.Code)
		}
	}
	req := httptest.NewRequest(http.MethodHead, "/tv", nil)
	res := httptest.NewRecorder()
	server.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("HEAD /tv returned %d", res.Code)
	}
}

func TestTVLiveRejectsTraversalAndUnknownNames(t *testing.T) {
	server := newSamsungTestServer(t, true)
	for _, path := range []string{
		"/tv/live/../index.m3u8",
		"/tv/live/%2e%2e/index.m3u8",
		"/tv/live/..%2findex.m3u8",
		"/tv/live/segment_abc.ts",
		"/tv/live/segment_1.ts",
		"/tv/live/index.m3u8.backup",
		"/tv/live/.stremdbc-tmp",
	} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		res := httptest.NewRecorder()
		server.Handler().ServeHTTP(res, req)
		if res.Code != http.StatusNotFound {
			t.Fatalf("GET %s returned %d, want 404", path, res.Code)
		}
	}
}

func TestTVLiveMissingPlaylistIsNotFound(t *testing.T) {
	server := newSamsungTestServer(t, true)
	req := httptest.NewRequest(http.MethodGet, "/tv/live/index.m3u8", nil)
	res := httptest.NewRecorder()
	server.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("missing playlist returned %d, want 404", res.Code)
	}
}

func TestTVStatusShapeLeaksNoPaths(t *testing.T) {
	server := newSamsungTestServer(t, false)
	for _, path := range []string{"/tv/status", "/api/v1/tv/status"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		res := httptest.NewRecorder()
		server.Handler().ServeHTTP(res, req)
		if res.Code != http.StatusOK {
			t.Fatalf("GET %s returned %d", path, res.Code)
		}
		var body map[string]interface{}
		if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
		for _, key := range []string{"enabled", "state", "profile", "restart_count", "playlist_ready"} {
			if _, exists := body[key]; !exists {
				t.Fatalf("GET %s missing %q in %v", path, key, body)
			}
		}
		serialized := strings.ToLower(res.Body.String())
		for _, leaked := range []string{"output_path", "playlist_path", "tmp", "vmix", "dshow", "ffmpeg"} {
			if strings.Contains(serialized, leaked) {
				t.Fatalf("GET %s leaks %q: %s", path, leaked, res.Body.String())
			}
		}
	}
}

func TestTVMutationsRequireKeyAndStrictBody(t *testing.T) {
	server := newSamsungTestServer(t, false)
	manager, err := auth.NewManager(testSamsungSecret, "15m", []string{"secret-key-123456"}, false)
	if err != nil {
		t.Fatal(err)
	}
	server.SetAuthManager(manager)

	post := func(path, key, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if key != "" {
			req.Header.Set("X-API-Key", key)
		}
		res := httptest.NewRecorder()
		server.Handler().ServeHTTP(res, req)
		return res
	}
	for _, path := range []string{"/api/v1/tv/start", "/api/v1/tv/stop", "/api/v1/tv/restart"} {
		if res := post(path, "", `{}`); res.Code != http.StatusUnauthorized {
			t.Fatalf("POST %s without key returned %d", path, res.Code)
		}
		if res := post(path, "secret-key-123456", `{"unknown":true}`); res.Code != http.StatusBadRequest {
			t.Fatalf("POST %s with unknown field returned %d", path, res.Code)
		}
	}
}
