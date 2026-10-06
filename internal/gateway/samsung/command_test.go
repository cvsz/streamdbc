package samsung

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/cvsz/stremdbc/internal/config"
)

func validTVConfig(t *testing.T) config.SamsungTVConfig {
	t.Helper()
	cfg := config.DefaultConfig().SamsungTV
	cfg.Enable = true
	cfg.OutputPath = t.TempDir()
	return cfg
}

func TestBuildArgsUsesSamsungDirectShowHLSBaseline(t *testing.T) {
	cfg := validTVConfig(t)
	args, err := BuildArgs(cfg)
	if err != nil {
		t.Fatalf("BuildArgs: %v", err)
	}
	for _, expected := range []string{
		"dshow", "1280x720", `video="vMix Video":audio="vMix Audio"`,
		"libx264", "main", "3.1", "yuv420p", "30", "60", "3500000", "4000000", "7000000",
		"aac", "aac_low", "48000", "mpegts", "delete_segments+temp_file",
	} {
		if !slices.Contains(args, expected) {
			t.Errorf("FFmpeg args do not contain %q: %v", expected, args)
		}
	}
	for _, expected := range [][]string{{"-g", "60"}, {"-hls_time", "2"}, {"-hls_list_size", "6"}, {"-hls_segment_type", "mpegts"}} {
		if !hasSequence(args, expected...) {
			t.Errorf("FFmpeg args do not contain %v: %v", expected, args)
		}
	}
	if !slices.Contains(args, filepath.Join(cfg.OutputPath, "segment_%06d.ts")) || !slices.Contains(args, filepath.Join(cfg.OutputPath, "index.m3u8")) {
		t.Fatalf("playlist and segment paths must use the configured output root: %v", args)
	}
	if !hasSequence(args, "-rtbufsize", "64M", "-f", "dshow", "-video_size", "1280x720", "-i", `video="vMix Video":audio="vMix Audio"`) {
		t.Fatalf("DirectShow input options are missing or ordered incorrectly: %v", args)
	}
	if slices.Contains(args, "independent_segments") || slices.Contains(args, "append_list") {
		t.Fatalf("legacy version 3 playlist should avoid newer or stale-list flags: %v", args)
	}
}

func TestBuildArgsSupportsSyntheticAndOptional1080pSources(t *testing.T) {
	cfg := validTVConfig(t)
	cfg.Source = "test"
	cfg.Profile = "f5500_1080p"
	cfg.Width, cfg.Height = 1920, 1080
	cfg.VideoBitrate, cfg.MaxVideoBitrate, cfg.VideoBuffer = 6_000_000, 7_000_000, 12_000_000
	cfg.AudioBitrate = 160_000
	args, err := BuildArgs(cfg)
	if err != nil {
		t.Fatalf("BuildArgs: %v", err)
	}
	for _, expected := range []string{"testsrc2=size=1920x1080:rate=30", "sine=frequency=1000:sample_rate=48000", "4.0"} {
		if !slices.Contains(args, expected) {
			t.Errorf("synthetic 1080p arguments do not contain %q: %v", expected, args)
		}
	}
	if strings.Contains(strings.Join(args, " "), "cmd.exe /c") {
		t.Fatal("the generated process invocation must not use a shell")
	}
}

func TestBuildArgsRejectsUnsafeDirectShowLabels(t *testing.T) {
	cfg := validTVConfig(t)
	cfg.VideoDevice = `Camera":audio="Other`
	if _, err := BuildArgs(cfg); err == nil {
		t.Fatal("quoted DirectShow device label should be rejected")
	}
}

func hasSequence(values []string, expected ...string) bool {
	for start := 0; start+len(expected) <= len(values); start++ {
		match := true
		for offset, value := range expected {
			if values[start+offset] != value {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}
