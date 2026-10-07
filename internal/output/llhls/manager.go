package llhls

import (
	"context"
	"errors"
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

// Manager manages Low-Latency HLS output.
type Manager struct {
	config       *config.LLHLSConfig
	registry     *core.StreamRegistry
	logger       *zap.Logger
	outputPath   string
	mu           sync.RWMutex
	streams      map[string]*LLHLSStream
	partDuration time.Duration
	segmentDur   time.Duration
	started      bool
	stopped      bool
}

// LLHLSStream represents a low-latency HLS stream.
type LLHLSStream struct {
	ID           string
	CreatedAt    time.Time
	LastSegment  time.Time
	SegmentCount int
	PartCount    int
	State        string
	removed      bool
	// dir is the pinned stream output directory. All segment, part, and
	// playlist writes go through it so a post-creation symlink swap cannot
	// redirect output outside the manager root.
	dir *fsutil.PinnedDir

	mu       sync.RWMutex
	segments []int
	parts    []int
}

// NewManager creates a new LL-HLS manager.
func NewManager(cfg *config.LLHLSConfig, registry *core.StreamRegistry, logger *zap.Logger) (*Manager, error) {
	if cfg == nil {
		return nil, fmt.Errorf("LL-HLS configuration is required")
	}
	copyCfg := *cfg
	if registry == nil {
		registry = core.NewStreamRegistry(nil)
	}
	if !copyCfg.Enable {
		return &Manager{config: &copyCfg, registry: registry, logger: safeLogger(logger, "llhls"), streams: make(map[string]*LLHLSStream)}, nil
	}
	if strings.TrimSpace(copyCfg.Path) == "" {
		return nil, fmt.Errorf("LL-HLS path cannot be empty")
	}
	if copyCfg.SegmentDuration <= 0 || copyCfg.PartDuration <= 0 || copyCfg.PlaylistSize <= 0 || copyCfg.PlaylistSize > config.MaxPlaylistSize || copyCfg.PartDuration >= copyCfg.SegmentDuration {
		return nil, fmt.Errorf("invalid LL-HLS timing or playlist size")
	}
	root, err := filepath.Abs(copyCfg.Path)
	if err != nil {
		return nil, fmt.Errorf("resolve LL-HLS path: %w", err)
	}
	copyCfg.Path = root
	if err := os.MkdirAll(root, 0o750); err != nil {
		return nil, fmt.Errorf("failed to create LL-HLS output directory: %w", err)
	}
	rootInfo, err := os.Lstat(root)
	if err != nil || rootInfo.Mode()&os.ModeSymlink != 0 || !rootInfo.IsDir() {
		return nil, fmt.Errorf("LL-HLS path must be a regular directory")
	}
	return &Manager{
		config:       &copyCfg,
		registry:     registry,
		logger:       safeLogger(logger, "llhls"),
		outputPath:   root,
		streams:      make(map[string]*LLHLSStream),
		partDuration: copyCfg.PartDuration,
		segmentDur:   copyCfg.SegmentDuration,
	}, nil
}

func safeLogger(logger *zap.Logger, name string) *zap.Logger {
	if logger == nil {
		logger = zap.NewNop()
	}
	return logger.Named(name)
}

// Start starts the LL-HLS manager.
func (m *Manager) Start(ctx context.Context) error {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stopped {
		return fmt.Errorf("LL-HLS manager is stopped")
	}
	if m.started {
		return nil
	}
	m.started = true
	m.logger.Info("LL-HLS manager started",
		zap.String("output_path", m.outputPath),
		zap.Duration("segment_duration", m.segmentDur),
		zap.Duration("part_duration", m.partDuration),
	)
	return nil
}

// Stop stops the LL-HLS manager.
func (m *Manager) Stop() error {
	m.mu.Lock()
	if m.stopped {
		m.mu.Unlock()
		return nil
	}
	m.stopped = true
	m.started = false
	detached := make([]*LLHLSStream, 0, len(m.streams))
	for _, stream := range m.streams {
		stream.mu.Lock()
		stream.removed = true
		stream.mu.Unlock()
		detached = append(detached, stream)
	}
	m.streams = make(map[string]*LLHLSStream)
	m.mu.Unlock()
	var removeErr error
	for _, stream := range detached {
		if err := removePinnedStreamDir(stream); err != nil {
			removeErr = errors.Join(removeErr, fmt.Errorf("remove LL-HLS output for %s: %w", stream.ID, err))
		}
	}
	m.logger.Info("stopping LL-HLS manager")
	return removeErr
}

// removePinnedStreamDir removes and closes a detached stream directory.
func removePinnedStreamDir(stream *LLHLSStream) error {
	if stream == nil || stream.dir == nil {
		return nil
	}
	removeErr := stream.dir.RemoveAll()
	closeErr := stream.dir.Close()
	return errors.Join(removeErr, closeErr)
}

// CreateStream creates a new LL-HLS stream.
func (m *Manager) CreateStream(streamID string) error {
	if err := core.ValidateStreamID(streamID); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stopped || !m.config.Enable {
		return fmt.Errorf("LL-HLS manager is disabled or stopped")
	}
	if _, exists := m.streams[streamID]; exists {
		return fmt.Errorf("stream already exists")
	}
	pinned, err := fsutil.OpenStreamDir(m.outputPath, streamID)
	if err != nil {
		return fmt.Errorf("failed to create stream directory: %w", err)
	}
	now := time.Now()
	m.streams[streamID] = &LLHLSStream{ID: streamID, CreatedAt: now, State: "active", dir: pinned}
	streamPath := pinned.Path()
	m.logger.Info("LL-HLS stream created", zap.String("stream_id", streamID), zap.String("path", streamPath))
	return nil
}

// RemoveStream removes an LL-HLS stream and its generated files.
func (m *Manager) RemoveStream(streamID string) error {
	if err := core.ValidateStreamID(streamID); err != nil {
		return err
	}
	m.mu.Lock()
	stream, exists := m.streams[streamID]
	if !exists {
		m.mu.Unlock()
		return fmt.Errorf("stream not found")
	}
	stream.mu.Lock()
	stream.removed = true
	stream.mu.Unlock()
	removeErr := removePinnedStreamDir(stream)
	delete(m.streams, streamID)
	m.mu.Unlock()
	if removeErr != nil {
		return fmt.Errorf("remove stream directory: %w", removeErr)
	}
	m.logger.Info("LL-HLS stream removed", zap.String("stream_id", streamID))
	return nil
}

// AddSegment adds a segment to an LL-HLS stream and refreshes its playlist.
func (m *Manager) AddSegment(streamID string, data []byte) error {
	stream, err := m.stream(streamID)
	if err != nil {
		return err
	}
	stream.mu.Lock()
	defer stream.mu.Unlock()
	if stream.removed {
		return fmt.Errorf("stream is removed")
	}
	stream.SegmentCount++
	sequence := stream.SegmentCount
	stream.segments = append(stream.segments, sequence)
	stream.LastSegment = time.Now()
	segmentName := fmt.Sprintf("segment_%d.ts", sequence)
	if err := stream.dir.WriteFile(segmentName, data, 0o640); err != nil {
		stream.segments = stream.segments[:len(stream.segments)-1]
		stream.SegmentCount--
		return fmt.Errorf("failed to write segment: %w", err)
	}
	if err := m.writePlaylistLocked(streamID, stream); err != nil {
		_ = stream.dir.RemoveFile(segmentName)
		stream.segments = stream.segments[:len(stream.segments)-1]
		stream.SegmentCount--
		return fmt.Errorf("failed to write playlist: %w", err)
	}
	return nil
}

// AddPart adds a partial CMAF segment to an LL-HLS stream and refreshes its playlist.
func (m *Manager) AddPart(streamID string, data []byte) error {
	stream, err := m.stream(streamID)
	if err != nil {
		return err
	}
	stream.mu.Lock()
	defer stream.mu.Unlock()
	if stream.removed {
		return fmt.Errorf("stream is removed")
	}
	stream.PartCount++
	sequence := stream.PartCount
	stream.parts = append(stream.parts, sequence)
	partName := fmt.Sprintf("part_%d.m4s", sequence)
	if err := stream.dir.WriteFile(partName, data, 0o640); err != nil {
		stream.parts = stream.parts[:len(stream.parts)-1]
		stream.PartCount--
		return fmt.Errorf("failed to write part: %w", err)
	}
	if err := m.writePlaylistLocked(streamID, stream); err != nil {
		_ = stream.dir.RemoveFile(partName)
		stream.parts = stream.parts[:len(stream.parts)-1]
		stream.PartCount--
		return fmt.Errorf("failed to write playlist: %w", err)
	}
	return nil
}

// WritePlaylist writes the current LL-HLS playlist for a stream.
func (m *Manager) WritePlaylist(streamID string) error {
	stream, err := m.stream(streamID)
	if err != nil {
		return err
	}
	stream.mu.RLock()
	defer stream.mu.RUnlock()
	if stream.removed {
		return fmt.Errorf("stream is removed")
	}
	return m.writePlaylistLocked(streamID, stream)
}

func (m *Manager) writePlaylistLocked(streamID string, stream *LLHLSStream) error {
	targetDuration := int(math.Ceil(m.segmentDur.Seconds()))
	if targetDuration < 1 {
		targetDuration = 1
	}
	mediaSequence := 0
	segments := newest(stream.segments, m.config.PlaylistSize)
	parts := newest(stream.parts, m.config.PlaylistSize*4)
	if len(segments) > 0 {
		mediaSequence = segments[0]
	}
	var playlist strings.Builder
	playlist.WriteString("#EXTM3U\n#EXT-X-VERSION:9\n")
	playlist.WriteString(fmt.Sprintf("#EXT-X-TARGETDURATION:%d\n", targetDuration))
	playlist.WriteString(fmt.Sprintf("#EXT-X-PART-INF:PART-TARGET=%.3f\n", m.partDuration.Seconds()))
	playlist.WriteString(fmt.Sprintf("#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,HOLD-BACK=%.3f,PART-HOLD-BACK=%.3f\n", multiplyDuration(m.segmentDur, 3).Seconds(), multiplyDuration(m.partDuration, 3).Seconds()))
	playlist.WriteString(fmt.Sprintf("#EXT-X-MEDIA-SEQUENCE:%d\n", mediaSequence))
	for _, part := range parts {
		playlist.WriteString(fmt.Sprintf("#EXT-X-PART:DURATION=%.3f,URI=\"part_%d.m4s\"\n", m.partDuration.Seconds(), part))
	}
	for _, segment := range segments {
		playlist.WriteString(fmt.Sprintf("#EXTINF:%.3f,\nsegment_%d.ts\n", m.segmentDur.Seconds(), segment))
	}
	return stream.dir.WriteFile("index.m3u8", []byte(playlist.String()), 0o640)
}

func (m *Manager) stream(streamID string) (*LLHLSStream, error) {
	if err := core.ValidateStreamID(streamID); err != nil {
		return nil, err
	}
	m.mu.RLock()
	if m.stopped || !m.config.Enable {
		m.mu.RUnlock()
		return nil, fmt.Errorf("LL-HLS manager is disabled or stopped")
	}
	stream, exists := m.streams[streamID]
	m.mu.RUnlock()
	if !exists {
		return nil, fmt.Errorf("stream not found")
	}
	return stream, nil
}

// GetStream returns an immutable snapshot of an LL-HLS stream.
func (m *Manager) GetStream(streamID string) (*LLHLSStream, bool) {
	m.mu.RLock()
	stream, exists := m.streams[streamID]
	m.mu.RUnlock()
	if !exists {
		return nil, false
	}
	stream.mu.RLock()
	defer stream.mu.RUnlock()
	if stream.removed {
		return nil, false
	}
	copy := &LLHLSStream{
		ID:           stream.ID,
		CreatedAt:    stream.CreatedAt,
		LastSegment:  stream.LastSegment,
		SegmentCount: stream.SegmentCount,
		PartCount:    stream.PartCount,
		State:        stream.State,
		segments:     append([]int(nil), stream.segments...),
		parts:        append([]int(nil), stream.parts...),
	}
	return copy, true
}

// GetStreamCount returns the number of active LL-HLS streams.
func (m *Manager) GetStreamCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.streams)
}

// GetOutputPath returns the LL-HLS output path.
func (m *Manager) GetOutputPath() string {
	return m.outputPath
}

// Cleanup periodically removes files outside the configured live window.
func (m *Manager) Cleanup(ctx context.Context, interval time.Duration) {
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
				m.cleanupOldFiles()
			}
		}
	}()
}

func (m *Manager) cleanupOldFiles() {
	m.mu.RLock()
	streams := make([]*LLHLSStream, 0, len(m.streams))
	for _, stream := range m.streams {
		streams = append(streams, stream)
	}
	m.mu.RUnlock()
	for _, stream := range streams {
		stream.mu.Lock()
		keepSegments := newest(stream.segments, m.config.PlaylistSize)
		keepParts := newest(stream.parts, m.config.PlaylistSize*4)
		keepSegmentSet := make(map[int]struct{}, len(keepSegments))
		keepPartSet := make(map[int]struct{}, len(keepParts))
		for _, value := range keepSegments {
			keepSegmentSet[value] = struct{}{}
		}
		for _, value := range keepParts {
			keepPartSet[value] = struct{}{}
		}
		entries, err := stream.dir.FileNames()
		if err == nil {
			for _, name := range entries {
				if value, ok := numberedFile(name, "segment_", ".ts"); ok {
					if _, keep := keepSegmentSet[value]; !keep {
						_ = stream.dir.RemoveFile(name)
					}
				}
				if value, ok := numberedFile(name, "part_", ".m4s"); ok {
					if _, keep := keepPartSet[value]; !keep {
						_ = stream.dir.RemoveFile(name)
					}
				}
			}
		}
		stream.mu.Unlock()
	}
}

func newest(values []int, count int) []int {
	copyValues := append([]int(nil), values...)
	sort.Ints(copyValues)
	if count < 0 {
		count = 0
	}
	if len(copyValues) > count {
		copyValues = copyValues[len(copyValues)-count:]
	}
	return copyValues
}

func multiplyDuration(value time.Duration, factor int64) time.Duration {
	if value <= 0 || factor <= 0 {
		return 0
	}
	maxDuration := time.Duration(math.MaxInt64)
	if value > maxDuration/time.Duration(factor) {
		return maxDuration
	}
	return value * time.Duration(factor)
}

func numberedFile(name, prefix, suffix string) (int, bool) {
	if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, suffix) {
		return 0, false
	}
	value, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(name, prefix), suffix))
	return value, err == nil && value >= 0
}

// GetStats returns LL-HLS statistics.
func (m *Manager) GetStats() map[string]interface{} {
	m.mu.RLock()
	streams := make([]*LLHLSStream, 0, len(m.streams))
	for _, stream := range m.streams {
		streams = append(streams, stream)
	}
	m.mu.RUnlock()
	totalSegments := 0
	totalParts := 0
	for _, stream := range streams {
		stream.mu.RLock()
		totalSegments += stream.SegmentCount
		totalParts += stream.PartCount
		stream.mu.RUnlock()
	}
	return map[string]interface{}{
		"stream_count":   len(streams),
		"total_segments": totalSegments,
		"total_parts":    totalParts,
		"output_path":    m.outputPath,
	}
}
