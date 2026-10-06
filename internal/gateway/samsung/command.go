package samsung

import (
	"fmt"
	"path/filepath"
	"strconv"

	"github.com/cvsz/stremdbc/internal/config"
)

// BuildArgs returns FFmpeg arguments for either the Windows DirectShow vMix
// source or the deterministic synthetic source used by integration checks.
// Values are kept as individual arguments; no shell parses this command.
func BuildArgs(cfg config.SamsungTVConfig) ([]string, error) {
	level := "3.1"
	if cfg.Profile == "f5500_1080p" {
		level = "4.0"
	} else if cfg.Profile != "f5500_720p" {
		return nil, fmt.Errorf("unsupported Samsung TV profile %q", cfg.Profile)
	}
	if cfg.Source != "vmix_external" && cfg.Source != "test" {
		return nil, fmt.Errorf("unsupported Samsung TV source %q", cfg.Source)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.FrameRate <= 0 || cfg.SegmentDuration <= 0 || cfg.VideoBitrate <= 0 || cfg.MaxVideoBitrate < cfg.VideoBitrate || cfg.VideoBuffer < cfg.MaxVideoBitrate || cfg.AudioBitrate <= 0 || cfg.AudioSampleRate <= 0 || cfg.PlaylistSize <= 0 || cfg.OutputPath == "" {
		return nil, fmt.Errorf("invalid Samsung TV encoder configuration")
	}
	if cfg.Source == "vmix_external" && (cfg.VideoDevice == "" || cfg.AudioDevice == "" || containsDeviceDelimiter(cfg.VideoDevice) || containsDeviceDelimiter(cfg.AudioDevice)) {
		return nil, fmt.Errorf("invalid DirectShow device label")
	}

	args := []string{"-hide_banner", "-loglevel", "warning"}
	if cfg.Source == "vmix_external" {
		args = append(args,
			"-rtbufsize", "64M",
			"-f", "dshow",
			"-video_size", fmt.Sprintf("%dx%d", cfg.Width, cfg.Height),
			"-i", fmt.Sprintf(`video="%s":audio="%s"`, cfg.VideoDevice, cfg.AudioDevice),
			"-map", "0:v:0", "-map", "0:a:0",
		)
	} else {
		args = append(args,
			"-re", "-f", "lavfi", "-i", fmt.Sprintf("testsrc2=size=%dx%d:rate=%d", cfg.Width, cfg.Height, cfg.FrameRate),
			"-re", "-f", "lavfi", "-i", fmt.Sprintf("sine=frequency=1000:sample_rate=%d", cfg.AudioSampleRate),
			"-map", "0:v:0", "-map", "1:a:0",
		)
	}

	segmentSeconds := int(cfg.SegmentDuration.Seconds())
	gop := cfg.FrameRate * segmentSeconds
	args = append(args,
		"-c:v", "libx264",
		"-preset", "veryfast",
		"-profile:v", "main",
		"-level:v", level,
		"-pix_fmt", "yuv420p",
		"-r", strconv.Itoa(cfg.FrameRate),
		"-g", strconv.Itoa(gop),
		"-keyint_min", strconv.Itoa(gop),
		"-sc_threshold", "0",
		"-force_key_frames", fmt.Sprintf("expr:gte(t,n_forced*%d)", segmentSeconds),
		"-b:v", strconv.Itoa(cfg.VideoBitrate),
		"-maxrate", strconv.Itoa(cfg.MaxVideoBitrate),
		"-bufsize", strconv.Itoa(cfg.VideoBuffer),
		"-c:a", "aac",
		"-profile:a", "aac_low",
		"-b:a", strconv.Itoa(cfg.AudioBitrate),
		"-ar", strconv.Itoa(cfg.AudioSampleRate),
		"-ac", "2",
		"-f", "hls",
		"-hls_time", strconv.Itoa(segmentSeconds),
		"-hls_list_size", strconv.Itoa(cfg.PlaylistSize),
		"-hls_delete_threshold", "2",
		"-hls_flags", "delete_segments+temp_file",
		"-hls_segment_type", "mpegts",
		"-hls_segment_filename", filepath.Join(cfg.OutputPath, "segment_%06d.ts"),
		filepath.Join(cfg.OutputPath, "index.m3u8"),
	)
	return args, nil
}

func containsDeviceDelimiter(value string) bool {
	for _, character := range value {
		if character == '"' || character == ':' || character == '\r' || character == '\n' || character == 0 {
			return true
		}
	}
	return false
}
