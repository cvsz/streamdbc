package samsung

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveFFmpegPrefersConfiguredPathOnPATH(t *testing.T) {
	ffmpeg, err := os.Executable()
	if err != nil {
		t.Fatalf("locate test binary: %v", err)
	}
	if resolved := resolveFFmpeg(ffmpeg); resolved != ffmpeg {
		t.Fatalf("resolveFFmpeg(%q) = %q, want the configured executable", ffmpeg, resolved)
	}
}

func TestResolveFFmpegRejectsMissingAbsolutePath(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "no-such-ffmpeg")
	if resolved := resolveFFmpeg(missing); resolved != "" {
		t.Fatalf("resolveFFmpeg(%q) = %q, want empty so startup fails loudly", missing, resolved)
	}
}

func TestResolveFFmpegFallsBackToManagedBuild(t *testing.T) {
	localAppData := t.TempDir()
	t.Setenv("LOCALAPPDATA", localAppData)
	t.Setenv("PATH", t.TempDir())

	root := filepath.Join(localAppData, "StreamDBC", "FFmpeg")
	older := filepath.Join(root, "7.1-x64")
	newer := filepath.Join(root, "9.0.2-x64")
	for _, dir := range []string{older, newer} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatalf("create managed directory %s: %v", dir, err)
		}
	}
	if err := os.WriteFile(filepath.Join(older, "ffmpeg.exe"), []byte("old"), 0o700); err != nil {
		t.Fatalf("write older managed binary: %v", err)
	}
	want := filepath.Join(newer, "ffmpeg.exe")
	if err := os.WriteFile(want, []byte("new"), 0o700); err != nil {
		t.Fatalf("write newer managed binary: %v", err)
	}

	if got := resolveFFmpeg("ffmpeg"); got != want {
		t.Fatalf("resolveFFmpeg = %q, want the newest managed build %q", got, want)
	}
}

func TestResolveFFmpegReturnsEmptyWithoutManagedBuild(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("PATH", t.TempDir())

	if got := resolveFFmpeg("ffmpeg"); got != "" {
		t.Fatalf("resolveFFmpeg = %q, want empty when no FFmpeg exists anywhere", got)
	}
}
