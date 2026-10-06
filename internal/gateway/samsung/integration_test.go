package samsung

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cvsz/stremdbc/internal/config"
)

func TestSyntheticFFmpegHLSCompatibility(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("FFmpeg is not installed")
	}
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe is not installed")
	}

	cfg := config.DefaultConfig().SamsungTV
	cfg.Enable = true
	cfg.Source = "test"
	cfg.OutputPath = t.TempDir()
	manager, err := NewManager(&cfg, nil)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	// Resolve the exact FFmpeg binary found above, even when the PATH contains
	// more than one executable name.
	manager.executable = ffmpeg
	if err := manager.Start(); err != nil {
		t.Fatalf("Start synthetic FFmpeg: %v", err)
	}
	stopContext, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	defer func() {
		if err := manager.Stop(stopContext); err != nil {
			t.Errorf("Stop synthetic FFmpeg: %v", err)
		}
	}()

	playlistPath := filepath.Join(cfg.OutputPath, "index.m3u8")
	var playlist string
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		contents, readErr := os.ReadFile(playlistPath)
		if readErr == nil && strings.Contains(string(contents), "segment_") {
			playlist = string(contents)
			break
		}
		if manager.Status().State == StateFailed {
			t.Fatalf("FFmpeg failed before making a playlist: %+v", manager.Status())
		}
		time.Sleep(100 * time.Millisecond)
	}
	if playlist == "" {
		t.Fatalf("FFmpeg did not generate an HLS playlist; status: %+v", manager.Status())
	}
	if !strings.HasPrefix(playlist, "#EXTM3U\n") || !strings.Contains(playlist, "#EXT-X-VERSION:3") {
		t.Fatalf("playlist is not the expected legacy version 3 HLS format:\n%s", playlist)
	}
	for _, unsupported := range []string{"#EXT-X-MAP", ".m4s", "#EXT-X-PART", "#EXT-X-INDEPENDENT-SEGMENTS"} {
		if strings.Contains(playlist, unsupported) {
			t.Fatalf("playlist contains unsupported feature %q:\n%s", unsupported, playlist)
		}
	}
	segmentName := ""
	for _, line := range strings.Split(playlist, "\n") {
		if strings.HasPrefix(line, "segment_") && strings.HasSuffix(line, ".ts") {
			segmentName = line
		}
	}
	if segmentName == "" {
		t.Fatalf("playlist does not reference an MPEG-TS segment:\n%s", playlist)
	}

	ctx, probeCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer probeCancel()
	command := exec.CommandContext(ctx, ffprobe, "-v", "error", "-show_entries", "format=format_name:stream=codec_name,profile,pix_fmt,width,height,r_frame_rate,sample_rate,channels", "-of", "json", filepath.Join(cfg.OutputPath, segmentName))
	probeOutput, err := command.Output()
	if err != nil {
		t.Fatalf("ffprobe generated segment: %v", err)
	}
	var probe struct {
		Streams []struct {
			CodecName  string `json:"codec_name"`
			Profile    string `json:"profile"`
			PixelFmt   string `json:"pix_fmt"`
			Width      int    `json:"width"`
			Height     int    `json:"height"`
			FrameRate  string `json:"r_frame_rate"`
			SampleRate string `json:"sample_rate"`
			Channels   int    `json:"channels"`
		} `json:"streams"`
		Format struct {
			Name string `json:"format_name"`
		} `json:"format"`
	}
	if err := json.Unmarshal(probeOutput, &probe); err != nil {
		t.Fatalf("decode ffprobe output %q: %v", probeOutput, err)
	}
	var video, audio *struct {
		CodecName  string `json:"codec_name"`
		Profile    string `json:"profile"`
		PixelFmt   string `json:"pix_fmt"`
		Width      int    `json:"width"`
		Height     int    `json:"height"`
		FrameRate  string `json:"r_frame_rate"`
		SampleRate string `json:"sample_rate"`
		Channels   int    `json:"channels"`
	}
	for index := range probe.Streams {
		stream := &probe.Streams[index]
		if stream.CodecName == "h264" {
			video = stream
		}
		if stream.CodecName == "aac" {
			audio = stream
		}
	}
	if probe.Format.Name != "mpegts" || video == nil || video.Profile != "Main" || video.PixelFmt != "yuv420p" || video.Width != 1280 || video.Height != 720 || video.FrameRate != "30/1" {
		t.Fatalf("unexpected video/container compatibility: format=%q video=%+v output=%s", probe.Format.Name, video, fmt.Sprint(probeOutput))
	}
	if audio == nil || audio.Profile != "LC" || audio.SampleRate != "48000" || audio.Channels != 2 {
		t.Fatalf("unexpected AAC-LC audio stream: %+v; output=%s", audio, fmt.Sprint(probeOutput))
	}
	if status := manager.Status(); !status.PlaylistReady || status.RestartCount != 0 {
		t.Fatalf("synthetic gateway status is not healthy: %+v", status)
	}
}
