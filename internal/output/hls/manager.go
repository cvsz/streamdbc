package hls

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/cvsz/stremdbc/internal/config"
	"github.com/cvsz/stremdbc/internal/core"
	"github.com/cvsz/stremdbc/internal/fsutil"
	"go.uber.org/zap"
)

// OutputManager manages HLS output for streams
type OutputManager struct {
	config *config.HLSConfig
	logger *zap.Logger
	dirs   map[string]*fsutil.PinnedDir // stream ID -> pinned output dir
	mu     sync.RWMutex
}

// NewOutputManager creates a new HLS output manager
func NewOutputManager(cfg *config.HLSConfig, logger *zap.Logger) (*OutputManager, error) {
	if cfg == nil {
		return nil, fmt.Errorf("HLS configuration is required")
	}
	if strings.TrimSpace(cfg.Path) == "" {
		return nil, fmt.Errorf("HLS path cannot be empty")
	}
	if cfg.SegmentDuration <= 0 || cfg.PlaylistSize <= 0 {
		return nil, fmt.Errorf("HLS segment duration and playlist size must be positive")
	}
	if cfg.PlaylistSize > config.MaxPlaylistSize {
		return nil, fmt.Errorf("HLS playlist size must not exceed %d", config.MaxPlaylistSize)
	}
	copyCfg := *cfg
	root, err := filepath.Abs(copyCfg.Path)
	if err != nil {
		return nil, fmt.Errorf("resolve HLS path: %w", err)
	}
	copyCfg.Path = root
	if logger == nil {
		logger = zap.NewNop()
	}
	// Ensure output directory exists
	if err := os.MkdirAll(root, 0o750); err != nil {
		return nil, fmt.Errorf("failed to create HLS directory: %w", err)
	}
	rootInfo, err := os.Lstat(root)
	if err != nil || rootInfo.Mode()&os.ModeSymlink != 0 || !rootInfo.IsDir() {
		return nil, fmt.Errorf("HLS path must be a regular directory")
	}

	return &OutputManager{
		config: &copyCfg,
		logger: logger.Named("hls"),
		dirs:   make(map[string]*fsutil.PinnedDir),
	}, nil
}

// Start starts HLS output for a stream
func (m *OutputManager) Start(streamID string) (string, error) {
	if err := core.ValidateStreamID(streamID); err != nil {
		return "", err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.config.Enable {
		return "", fmt.Errorf("HLS output is disabled")
	}

	if _, exists := m.dirs[streamID]; exists {
		return "", fmt.Errorf("HLS output already started for stream %s", streamID)
	}

	pinned, err := fsutil.OpenStreamDir(m.config.Path, streamID)
	if err != nil {
		return "", fmt.Errorf("failed to create stream directory: %w", err)
	}

	m.dirs[streamID] = pinned
	streamPath := pinned.Path()
	m.logger.Info("HLS output started",
		zap.String("stream_id", streamID),
		zap.String("path", streamPath),
	)

	return streamPath, nil
}

// Stop stops HLS output for a stream
func (m *OutputManager) Stop(streamID string) error {
	m.mu.Lock()

	path, exists := m.dirs[streamID]
	if !exists {
		m.mu.Unlock()
		return fmt.Errorf("HLS output not found for stream %s", streamID)
	}

	delete(m.dirs, streamID)
	dirPath := path.Path()
	m.mu.Unlock()
	// Removal is pinned to the validated directory handle, so a symlink
	// swapped in after Start cannot redirect it outside the output root.
	removeErr := path.RemoveAll()
	_ = path.Close()
	if removeErr != nil {
		return fmt.Errorf("remove HLS output for stream %s: %w", streamID, removeErr)
	}
	m.logger.Info("HLS output stopped",
		zap.String("stream_id", streamID),
		zap.String("path", dirPath),
	)

	return nil
}

// GetPath returns the HLS output path for a stream
func (m *OutputManager) GetPath(streamID string) (string, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	pinned, exists := m.dirs[streamID]
	if !exists {
		return "", false
	}
	return pinned.Path(), true
}

// WriteSegment writes a media segment to disk
func (m *OutputManager) WriteSegment(streamID string, sequence int, data []byte) error {
	if err := core.ValidateStreamID(streamID); err != nil {
		return err
	}
	if sequence < 0 {
		return fmt.Errorf("segment sequence must not be negative")
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	pinned, exists := m.dirs[streamID]
	if !exists {
		return fmt.Errorf("HLS output not found for stream %s", streamID)
	}

	filename := fmt.Sprintf("segment_%d.ts", sequence)
	return pinned.WriteFile(filename, data, 0o640)
}

// WritePlaylist writes an HLS playlist file
func (m *OutputManager) WritePlaylist(streamID string, segments []int) error {
	return m.writePlaylist(streamID, segments, false)
}

// WriteFinalPlaylist writes a completed HLS playlist with an ENDLIST marker.
func (m *OutputManager) WriteFinalPlaylist(streamID string, segments []int) error {
	return m.writePlaylist(streamID, segments, true)
}

func (m *OutputManager) writePlaylist(streamID string, segments []int, final bool) error {
	if err := core.ValidateStreamID(streamID); err != nil {
		return err
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	pinned, exists := m.dirs[streamID]
	if !exists {
		return fmt.Errorf("HLS output not found for stream %s", streamID)
	}
	for _, seq := range segments {
		if seq < 0 {
			return fmt.Errorf("segment sequence must not be negative")
		}
	}
	normalized := normalizeSegments(segments, m.config.PlaylistSize)

	targetDuration := int(math.Ceil(m.config.SegmentDuration.Seconds()))
	if targetDuration < 1 {
		targetDuration = 1
	}
	mediaSequence := 0
	if len(normalized) > 0 {
		mediaSequence = normalized[0]
	}
	var playlist strings.Builder
	playlist.WriteString("#EXTM3U\n")
	playlist.WriteString("#EXT-X-VERSION:3\n")
	playlist.WriteString(fmt.Sprintf("#EXT-X-TARGETDURATION:%d\n", targetDuration))
	playlist.WriteString(fmt.Sprintf("#EXT-X-MEDIA-SEQUENCE:%d\n\n", mediaSequence))

	for _, seq := range normalized {
		playlist.WriteString(fmt.Sprintf("#EXTINF:%.3f,\n", m.config.SegmentDuration.Seconds()))
		playlist.WriteString(fmt.Sprintf("segment_%d.ts\n", seq))
	}

	if final {
		playlist.WriteString("#EXT-X-ENDLIST\n")
	}

	playlistPath := "index.m3u8"
	return pinned.WriteFile(playlistPath, []byte(playlist.String()), 0o640)
}

// Cleanup removes old segments based on playlist size
func (m *OutputManager) Cleanup(ctx context.Context, interval time.Duration) {
	if ctx == nil || interval <= 0 {
		return
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.cleanupOldSegments()
			}
		}
	}()
}

func normalizeSegments(segments []int, limit int) []int {
	seen := make(map[int]struct{}, len(segments))
	normalized := make([]int, 0, len(segments))
	for _, sequence := range segments {
		if _, exists := seen[sequence]; exists {
			continue
		}
		seen[sequence] = struct{}{}
		normalized = append(normalized, sequence)
	}
	sort.Ints(normalized)
	if limit > 0 && len(normalized) > limit {
		normalized = normalized[len(normalized)-limit:]
	}
	return normalized
}

func (m *OutputManager) cleanupOldSegments() {
	m.mu.RLock()
	dirs := make([]*fsutil.PinnedDir, 0, len(m.dirs))
	for _, pinned := range m.dirs {
		dirs = append(dirs, pinned)
	}
	m.mu.RUnlock()

	for _, pinned := range dirs {
		entries, err := pinned.FileNames()
		if err != nil {
			m.logger.Warn("failed to read HLS stream directory", zap.String("path", pinned.Path()), zap.Error(err))
			continue
		}
		sequences := make([]int, 0, len(entries))
		files := make(map[int]string, len(entries))
		for _, name := range entries {
			if !strings.HasPrefix(name, "segment_") || !strings.HasSuffix(name, ".ts") {
				continue
			}
			sequence, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(name, "segment_"), ".ts"))
			if err != nil || sequence < 0 {
				continue
			}
			sequences = append(sequences, sequence)
			files[sequence] = name
		}
		sort.Ints(sequences)
		keepFrom := len(sequences) - m.config.PlaylistSize
		if keepFrom < 0 {
			keepFrom = 0
		}
		for _, sequence := range sequences[:keepFrom] {
			if err := pinned.RemoveFile(files[sequence]); err != nil && !os.IsNotExist(err) {
				m.logger.Warn("failed to remove old HLS segment", zap.String("path", files[sequence]), zap.Error(err))
			}
		}
	}
}

// GetStats returns statistics about HLS output
func (m *OutputManager) GetStats() map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()

	return map[string]interface{}{
		"active_streams":   len(m.dirs),
		"output_path":      m.config.Path,
		"segment_duration": m.config.SegmentDuration.Seconds(),
		"playlist_size":    m.config.PlaylistSize,
	}
}

func (m *OutputManager) GetOutputPath(streamID string) (string, bool) {
	return m.GetPath(streamID)
}
