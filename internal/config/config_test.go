package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDefaultConfigValid(t *testing.T) {
	cfg := DefaultConfig()
	if err := cfg.Validate(); err != nil {
		t.Fatalf("default config should validate: %v", err)
	}
	if cfg.RTSP.Port != 8554 {
		t.Fatalf("expected non-root RTSP port 8554, got %d", cfg.RTSP.Port)
	}
}

func TestAuthRequiresStrongSecret(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Auth.Enable = true
	cfg.Auth.JWTSecret = "short"
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "32") {
		t.Fatalf("expected strong JWT secret validation, got %v", err)
	}
}

func TestLLHLSPartMustBeShorterThanSegment(t *testing.T) {
	cfg := DefaultConfig()
	cfg.LLHLS.Enable = true
	cfg.LLHLS.PartDuration = 2 * time.Second
	cfg.LLHLS.SegmentDuration = time.Second
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected invalid LL-HLS timing to fail")
	}
}

func TestClusterRequiresRedis(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Cluster.Enable = true
	cfg.Cluster.NodeID = "node-a"
	cfg.Redis.Enable = false
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected cluster without Redis to fail")
	}
}

func TestLoadParsesDurationStringsAndRejectsUnknownFields(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte("server:\n  read_timeout: 7s\n"), 0o600); err != nil {
		t.Fatalf("write valid config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load valid config: %v", err)
	}
	if cfg.Server.ReadTimeout != 7*time.Second {
		t.Fatalf("expected read timeout 7s, got %s", cfg.Server.ReadTimeout)
	}

	if err := os.WriteFile(path, []byte("server:\n  unknown_field: true\n"), 0o600); err != nil {
		t.Fatalf("write invalid config: %v", err)
	}
	if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "unknown_field") {
		t.Fatalf("expected unknown field error, got %v", err)
	}
}

func TestConfigRejectsInvalidTimeouts(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Server.ReadTimeout = 0
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "read_timeout") {
		t.Fatalf("expected invalid read timeout error, got %v", err)
	}
}

func TestConfigRejectsDuplicateEnabledListenerAddresses(t *testing.T) {
	cfg := DefaultConfig()
	cfg.RTMP.Enable = true
	cfg.RTSP.Enable = true
	cfg.RTSP.Host = cfg.RTMP.Host
	cfg.RTSP.Port = cfg.RTMP.Port
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "same address") {
		t.Fatalf("expected duplicate listener error, got %v", err)
	}
}

func TestConfigRequiresAuthenticationCredential(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Auth.Enable = true
	cfg.Auth.JWTSecret = strings.Repeat("x", 32)
	cfg.Auth.AllowAnonymous = false
	cfg.Auth.APIKeys = nil
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "api_keys") {
		t.Fatalf("expected API key credential error, got %v", err)
	}
}

func TestConfigRejectsUnauthenticatedLegacyIngestWithAuthEnabled(t *testing.T) {
	for _, name := range []string{"RTMP", "RTSP"} {
		cfg := DefaultConfig()
		cfg.Auth.Enable = true
		cfg.Auth.JWTSecret = strings.Repeat("x", 32)
		cfg.Auth.APIKeys = []string{"api-key-123456789"}
		if name == "RTMP" {
			cfg.RTMP.Enable = true
		} else {
			cfg.RTSP.Enable = true
		}
		if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "publish authentication") {
			t.Fatalf("%s with auth should be rejected, got %v", name, err)
		}
	}
}

func TestConfigAcceptsStandardWebRTCICEServerURLs(t *testing.T) {
	cfg := DefaultConfig()
	cfg.WebRTC.Enable = true
	cfg.WebRTC.UseTURN = true
	cfg.WebRTC.ICEServer.URLs = []string{
		"stun:stun.example.com:3478",
		"turn:turn.example.com:3478?transport=udp",
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("standard ICE server URLs should validate: %v", err)
	}
	cfg.WebRTC.ICEServer.URLs = []string{"stun:stun.example.com:3478"}
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "TURN") {
		t.Fatalf("use_turn without a TURN URL should fail, got %v", err)
	}
}

func TestLoadRejectsExplicitlyMissingConfig(t *testing.T) {
	if _, err := Load(filepath.Join(t.TempDir(), "missing.yaml")); err == nil {
		t.Fatal("explicitly missing config should not silently load defaults")
	}
}

func TestConfigRejectsInvalidHTTPConfigurationValues(t *testing.T) {
	cfg := DefaultConfig()
	cfg.API.CORSOrigins = []string{"not-an-origin"}
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "CORS") {
		t.Fatalf("expected invalid CORS error, got %v", err)
	}
	cfg = DefaultConfig()
	cfg.Metrics.Path = "metrics"
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "metrics.path") {
		t.Fatalf("expected invalid metrics path error, got %v", err)
	}
	cfg = DefaultConfig()
	cfg.Logging.Level = "trace"
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "logging.level") {
		t.Fatalf("expected invalid logging level error, got %v", err)
	}
	for _, origin := range []string{"https://trusted.example:bad", "https://trusted.example:", "https://trusted.example:0", "https://trusted.example:65536"} {
		cfg = DefaultConfig()
		cfg.API.CORSOrigins = []string{origin}
		if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "CORS") {
			t.Fatalf("expected invalid CORS port error for %q, got %v", origin, err)
		}
	}
	cfg = DefaultConfig()
	cfg.Server.Host = " 127.0.0.1"
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "HTTP host") {
		t.Fatalf("expected whitespace host error, got %v", err)
	}
	for _, host := range []string{"bad..host", "bad_host", "-bad.example"} {
		cfg = DefaultConfig()
		cfg.Server.Host = host
		if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "HTTP host") {
			t.Fatalf("expected invalid hostname error for %q, got %v", host, err)
		}
	}
	cfg = DefaultConfig()
	cfg.API.BasePath = "/api/../v1"
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "base_path") {
		t.Fatalf("expected dot-segment base path error, got %v", err)
	}
	cfg = DefaultConfig()
	cfg.Metrics.Path = "/api/v1/streams/demo"
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "conflicts") {
		t.Fatalf("expected metrics dynamic-route conflict, got %v", err)
	}
	for _, path := range []string{"/health/live", "/health/ready"} {
		cfg = DefaultConfig()
		cfg.Metrics.Path = path
		if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "conflicts") {
			t.Fatalf("expected metrics health-route conflict for %q, got %v", path, err)
		}
	}
	for _, path := range []string{"/dashboard", "/dashboard/status", "/player/demo", "/hls/demo", "/llhls/demo", "/tv", "/tv/live"} {
		cfg = DefaultConfig()
		cfg.Metrics.Path = path
		if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "conflicts") {
			t.Fatalf("expected metrics static-route conflict for %q, got %v", path, err)
		}
	}
}

func TestConfigRejectsUnboundedPlaylistWindows(t *testing.T) {
	cfg := DefaultConfig()
	cfg.HLS.Enable = true
	cfg.HLS.PlaylistSize = MaxPlaylistSize + 1
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "HLS playlist_size") {
		t.Fatalf("expected HLS playlist bound error, got %v", err)
	}

	cfg = DefaultConfig()
	cfg.LLHLS.Enable = true
	cfg.LLHLS.PlaylistSize = MaxPlaylistSize + 1
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "LL-HLS playlist_size") {
		t.Fatalf("expected LL-HLS playlist bound error, got %v", err)
	}
}

func TestConfigRejectsUnboundedTranscoderResources(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*Config)
		want   string
	}{
		{name: "workers", change: func(cfg *Config) { cfg.Transcoder.WorkerCount = 257 }, want: "worker_count"},
		{name: "width", change: func(cfg *Config) { cfg.Transcoder.ABRLadder[0].Width = 16385 }, want: "ABR profile"},
		{name: "height", change: func(cfg *Config) { cfg.Transcoder.ABRLadder[0].Height = 16385 }, want: "ABR profile"},
		{name: "video bitrate", change: func(cfg *Config) { cfg.Transcoder.ABRLadder[0].Bitrate = 100000001 }, want: "ABR profile"},
		{name: "frame rate", change: func(cfg *Config) { cfg.Transcoder.ABRLadder[0].FrameRate = 241 }, want: "ABR profile"},
		{name: "audio bitrate", change: func(cfg *Config) { cfg.Transcoder.ABRLadder[0].AudioBitrate = 10000001 }, want: "ABR profile"},
	} {
		t.Run(test.name, func(t *testing.T) {
			cfg := DefaultConfig()
			cfg.Transcoder.Enable = true
			test.change(cfg)
			if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("expected bounded transcoder validation error, got %v", err)
			}
		})
	}
}

func TestSamsungTVConfigProfilesAndValidation(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SamsungTV.Enable = true
	if err := cfg.Validate(); err != nil {
		t.Fatalf("default Samsung F5500 profile should validate: %v", err)
	}

	cfg = DefaultConfig()
	cfg.SamsungTV.Enable = true
	cfg.SamsungTV.Profile = "f5500_1080p"
	cfg.SamsungTV.Width = 1920
	cfg.SamsungTV.Height = 1080
	cfg.SamsungTV.VideoBitrate = 6_000_000
	cfg.SamsungTV.MaxVideoBitrate = 7_000_000
	cfg.SamsungTV.VideoBuffer = 12_000_000
	cfg.SamsungTV.AudioBitrate = 160_000
	if err := cfg.Validate(); err != nil {
		t.Fatalf("optional 1080p profile should validate: %v", err)
	}
}

func TestSamsungF5500ExampleConfigLoads(t *testing.T) {
	localAppData := filepath.Join(t.TempDir(), "LocalAppData")
	t.Setenv("LOCALAPPDATA", localAppData)
	t.Setenv("STREMDBC_JWT_SECRET", strings.Repeat("j", 40))
	t.Setenv("STREMDBC_API_KEY", "sample-api-key-with-sufficient-length")

	cfg, err := Load(filepath.Join("..", "..", "configs", "samsung-f5500.yaml"))
	if err != nil {
		t.Fatalf("load Samsung F5500 sample config: %v", err)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Samsung F5500 sample config should validate: %v", err)
	}
	if !cfg.API.Enable || !cfg.Auth.Enable || !cfg.Auth.AllowAnonymous || !cfg.SamsungTV.Enable {
		t.Fatalf("sample should enable only API, anonymous TV playback, and the Samsung gateway: api=%t auth=%t anonymous=%t samsung=%t", cfg.API.Enable, cfg.Auth.Enable, cfg.Auth.AllowAnonymous, cfg.SamsungTV.Enable)
	}
	if cfg.SamsungTV.OutputPath != filepath.Join(localAppData, "StreamDBC", "SamsungTV") {
		t.Fatalf("sample output path did not expand LOCALAPPDATA: %q", cfg.SamsungTV.OutputPath)
	}
	for name, enabled := range map[string]bool{
		"hls": cfg.HLS.Enable, "llhls": cfg.LLHLS.Enable, "rtmp": cfg.RTMP.Enable,
		"rtsp": cfg.RTSP.Enable, "srt": cfg.SRT.Enable, "webrtc": cfg.WebRTC.Enable,
		"recorder": cfg.Recorder.Enable, "dvr": cfg.DVR.Enable, "transcoder": cfg.Transcoder.Enable,
		"cluster": cfg.Cluster.Enable, "redis": cfg.Redis.Enable, "postgres": cfg.Postgres.Enable,
	} {
		if enabled {
			t.Errorf("sample config should not enable unrelated service %s", name)
		}
	}
}

func TestSamsungTVConfigRejectsUnsafeOrIncompatibleValues(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Config)
		want   string
	}{
		{name: "resolution", mutate: func(cfg *Config) { cfg.SamsungTV.Width = 1920 }, want: "requires 1280x720"},
		{name: "video bitrate", mutate: func(cfg *Config) { cfg.SamsungTV.VideoBitrate = 9_000_000 }, want: "bitrate"},
		{name: "playlist size", mutate: func(cfg *Config) { cfg.SamsungTV.PlaylistSize = 2 }, want: "playlist_size"},
		{name: "segment duration", mutate: func(cfg *Config) { cfg.SamsungTV.SegmentDuration = 1500 * time.Millisecond }, want: "segment_duration"},
		{name: "relative output path", mutate: func(cfg *Config) { cfg.SamsungTV.OutputPath = "./hls" }, want: "absolute"},
		{name: "empty video device", mutate: func(cfg *Config) { cfg.SamsungTV.VideoDevice = "" }, want: "video_device"},
		{name: "quoted device", mutate: func(cfg *Config) { cfg.SamsungTV.AudioDevice = `vMix Audio\":audio=other` }, want: "audio_device"},
		{name: "invalid ffmpeg executable", mutate: func(cfg *Config) { cfg.SamsungTV.FFmpegPath = "-version" }, want: "ffmpeg_path"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg := DefaultConfig()
			cfg.SamsungTV.Enable = true
			test.mutate(cfg)
			if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("expected %q validation error, got %v", test.want, err)
			}
		})
	}
}

func TestConfigRejectsInvalidProxyAndRateLimit(t *testing.T) {
	cfg := DefaultConfig()
	cfg.API.TrustedProxies = []string{"not-a-proxy"}
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "trusted_proxies") {
		t.Fatalf("expected invalid trusted proxy error, got %v", err)
	}

	cfg = DefaultConfig()
	cfg.API.RateLimitPerMinute = -1
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "rate_limit_per_minute") {
		t.Fatalf("expected invalid rate limit error, got %v", err)
	}

	cfg = DefaultConfig()
	cfg.WebRTC.Enable = true
	cfg.WebRTC.CORSOrigins = nil
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "cors_origins") {
		t.Fatalf("expected WebRTC CORS requirement error, got %v", err)
	}
}
