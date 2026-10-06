package api

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cvsz/stremdbc/internal/config"
	samsunggateway "github.com/cvsz/stremdbc/internal/gateway/samsung"
)

func TestSamsungTVSyntheticHTTPPlayback(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("FFmpeg is not installed")
	}
	cfg := config.DefaultConfig().SamsungTV
	cfg.Enable = true
	cfg.Source = "test"
	cfg.FFmpegPath = ffmpeg
	cfg.OutputPath = t.TempDir()
	manager, err := samsunggateway.NewManager(&cfg, nil)
	if err != nil {
		t.Fatalf("create synthetic Samsung gateway: %v", err)
	}
	if err := manager.Start(); err != nil {
		t.Fatalf("start synthetic Samsung gateway: %v", err)
	}
	stopContext, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	defer func() {
		if err := manager.Stop(stopContext); err != nil {
			t.Errorf("stop synthetic Samsung gateway: %v", err)
		}
	}()

	server := newTestServer(t)
	server.SetSamsungTV(manager, cfg, filepath.Join("..", "..", "web", "tv"))
	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()
	client := &http.Client{Timeout: 5 * time.Second}
	for path, marker := range map[string]string{"/tv": "StreamDBC Samsung TV", "/tv/basic": "Basic Player"} {
		response, err := client.Get(httpServer.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		body, readErr := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if readErr != nil || response.StatusCode != http.StatusOK || !strings.Contains(string(body), marker) {
			t.Fatalf("GET %s returned status=%d marker=%q body=%q read_error=%v", path, response.StatusCode, marker, body, readErr)
		}
	}

	deadline := time.Now().Add(20 * time.Second)
	var response *http.Response
	var playlist string
	for time.Now().Before(deadline) {
		response, err = client.Get(httpServer.URL + "/tv/live/index.m3u8")
		if err == nil {
			body, readErr := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if readErr != nil {
				t.Fatalf("read HLS playlist: %v", readErr)
			}
			if response.StatusCode == http.StatusOK && strings.Contains(string(body), "segment_") {
				playlist = string(body)
				break
			}
		}
		if manager.Status().State == samsunggateway.StateFailed {
			t.Fatalf("synthetic gateway failed: %+v", manager.Status())
		}
		time.Sleep(100 * time.Millisecond)
	}
	if playlist == "" {
		t.Fatalf("HTTP HLS playlist did not become ready; gateway status: %+v", manager.Status())
	}
	if response.Header.Get("Content-Type") != "application/vnd.apple.mpegurl" || !strings.Contains(playlist, "#EXT-X-VERSION:3") {
		t.Fatalf("unexpected HTTP playlist: content-type=%q body=%s", response.Header.Get("Content-Type"), playlist)
	}
	var segment string
	for _, line := range strings.Split(playlist, "\n") {
		if strings.HasPrefix(line, "segment_") && strings.HasSuffix(line, ".ts") {
			segment = line
			break
		}
	}
	if segment == "" {
		t.Fatalf("HTTP playlist does not reference an MPEG-TS segment: %s", playlist)
	}
	response, err = client.Get(httpServer.URL + "/tv/live/" + segment)
	if err != nil {
		t.Fatalf("GET HLS segment: %v", err)
	}
	segmentBytes, readErr := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if readErr != nil || response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "video/mp2t" || len(segmentBytes) == 0 {
		t.Fatalf("unexpected HTTP segment response: status=%d content-type=%q bytes=%d read_error=%v", response.StatusCode, response.Header.Get("Content-Type"), len(segmentBytes), readErr)
	}
	if err := manager.Stop(stopContext); err != nil {
		t.Fatalf("stop synthetic gateway: %v", err)
	}
	if status := manager.Status(); status.PlaylistReady || status.State != samsunggateway.StateStopped {
		t.Fatalf("stopped gateway reports stale playlist readiness: %+v", status)
	}
	response, err = client.Get(httpServer.URL + "/tv/live/index.m3u8")
	if err != nil {
		t.Fatalf("request stopped gateway playlist: %v", err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("stopped gateway served stale playlist with HTTP %d", response.StatusCode)
	}
}
