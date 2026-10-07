package recorder

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/cvsz/stremdbc/internal/config"
	"go.uber.org/zap"
)

func testRecorder(t *testing.T) *Manager {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake POSIX FFmpeg fixture is covered on Linux CI")
	}
	ffmpeg := filepath.Join(t.TempDir(), "fake-ffmpeg")
	if err := os.WriteFile(ffmpeg, []byte("#!/bin/sh\nlast=\"\"\nfor arg in \"$@\"; do last=\"$arg\"; done\ncase \"$*\" in *-encoders*) exit 0;; esac\nprintf test-output > \"$last\"\n"), 0o700); err != nil {
		t.Fatalf("write fake ffmpeg: %v", err)
	}
	manager, err := NewManager(&config.RecorderConfig{
		Enable:     true,
		Path:       t.TempDir(),
		FFmpegPath: ffmpeg,
	}, zap.NewNop())
	if err != nil {
		t.Fatalf("new recorder: %v", err)
	}
	return manager
}

func TestRecorderFailsWhenFFmpegProducesNoOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("/bin/true fixture is POSIX-only")
	}
	manager, err := NewManager(&config.RecorderConfig{Enable: true, Path: t.TempDir(), FFmpegPath: "/bin/true"}, zap.NewNop())
	if err != nil {
		t.Fatalf("new recorder: %v", err)
	}
	done := make(chan error, 1)
	if err := manager.StartRecording("empty", "rtmp://example/live", func(_ string, err error) { done <- err }); err != nil {
		t.Fatalf("start recording: %v", err)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("recorder reported success without an output file")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("recorder completion callback did not run")
	}
	if recording, _ := manager.GetRecording("empty"); recording.State != stateFailed {
		t.Fatalf("missing output state = %q", recording.State)
	}
}

func TestRecorderValidatesIDsAndInputURLs(t *testing.T) {
	manager := testRecorder(t)

	if err := manager.StartRecording("../escape", "rtmp://example/live", nil); !errors.Is(err, ErrInvalidStreamID) {
		t.Fatalf("unsafe stream ID error = %v", err)
	}
	if err := manager.StartRecording("demo", "not a URL", nil); !errors.Is(err, ErrInvalidInputURL) {
		t.Fatalf("invalid input URL error = %v", err)
	}
	if err := manager.StartRecording("demo", "rtmp://example/live", nil); err != nil {
		t.Fatalf("start recording: %v", err)
	}

	deadline := time.After(2 * time.Second)
	for {
		recording, ok := manager.GetRecording("demo")
		if ok && recording.State == stateStopped {
			recording.State = "corrupted"
			snapshot, _ := manager.GetRecording("demo")
			if snapshot.State != stateStopped {
				t.Fatalf("mutable recording leaked: %+v", snapshot)
			}
			break
		}
		select {
		case <-deadline:
			t.Fatal("recording did not finish")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestRecorderUsesConfiguredBinaryAndStopsWithContext(t *testing.T) {
	manager := testRecorder(t)
	if err := manager.StartRecording("demo", "rtsp://example/live", nil); err != nil {
		t.Fatalf("start recording: %v", err)
	}
	if err := manager.Stop(context.Background()); err != nil {
		t.Fatalf("stop recorder: %v", err)
	}
	if got := manager.GetRecordingCount(); got != 1 {
		t.Fatalf("recording count = %d", got)
	}
	if err := manager.StartRecording("after-stop", "rtmp://example/live", nil); !errors.Is(err, ErrRecorderStopped) {
		t.Fatalf("start after stop error = %v", err)
	}
}

func TestRecorderOutputPathStaysUnderConfiguredDirectory(t *testing.T) {
	manager := testRecorder(t)
	if err := manager.StartRecording("demo", "srt://example:9000?streamid=demo", nil); err != nil {
		t.Fatalf("start recording: %v", err)
	}
	recording, ok := manager.GetRecording("demo")
	if !ok {
		t.Fatal("recording missing")
	}
	root, _ := filepath.Abs(manager.config.Path)
	output, _ := filepath.Abs(recording.OutputPath)
	if filepath.Dir(output) != root {
		t.Fatalf("output path escaped root: %s", recording.OutputPath)
	}
	if _, err := os.Stat(root); err != nil {
		t.Fatalf("recording directory missing: %v", err)
	}
	_ = manager.Stop(context.Background())
}

func TestRecorderContainsCompletionCallbackPanics(t *testing.T) {
	manager := testRecorder(t)
	if err := manager.StartRecording("panic-test", "rtmp://example/live", func(string, error) { panic("callback failure") }); err != nil {
		t.Fatalf("start recording: %v", err)
	}
	deadline := time.After(2 * time.Second)
	for {
		recording, ok := manager.GetRecording("panic-test")
		if ok && recording.State == stateStopped {
			return
		}
		select {
		case <-deadline:
			t.Fatal("recording did not finish after callback panic")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestRecorderArchivesSupersededRecordingInHistory(t *testing.T) {
	manager := testRecorder(t)
	if err := manager.StartRecording("demo", "rtmp://example/live", nil); err != nil {
		t.Fatalf("start first recording: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		recording, ok := manager.GetRecording("demo")
		if !ok {
			t.Fatal("first recording missing")
		}
		if !isActive(recording.State) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("first recording still %q", recording.State)
		}
		time.Sleep(10 * time.Millisecond)
	}
	first, _ := manager.GetRecording("demo")
	if err := manager.StartRecording("demo", "rtmp://example/live", nil); err != nil {
		t.Fatalf("start second recording: %v", err)
	}
	recordings := manager.ListRecordings()
	if len(recordings) != 2 {
		t.Fatalf("expected current plus archived recording, got %d", len(recordings))
	}
	second, _ := manager.GetRecording("demo")
	if second.ID == first.ID {
		t.Fatal("current recording was not replaced")
	}
	archived := 0
	for _, recording := range recordings {
		if recording.ID == first.ID {
			archived++
		}
	}
	if archived != 1 {
		t.Fatalf("superseded recording missing from history: %+v", recordings)
	}
}
