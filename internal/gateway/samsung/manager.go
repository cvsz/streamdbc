package samsung

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/cvsz/stremdbc/internal/config"
	"go.uber.org/zap"
)

const (
	StateStopped    = "STOPPED"
	StateStarting   = "STARTING"
	StateLive       = "LIVE"
	StateRestarting = "RESTARTING"
	StateFailed     = "FAILED"

	maxBackoff = 30 * time.Second

	// maxStderrBytes caps retained FFmpeg diagnostics to the most recent
	// output, which is where the actionable failure detail lives.
	maxStderrBytes = 64 * 1024
)

var (
	ErrDisabled       = errors.New("the Samsung TV gateway is disabled")
	ErrAlreadyStarted = errors.New("the Samsung TV gateway is already running")
	ErrNotStarted     = errors.New("the Samsung TV gateway is not running")
)

type process interface {
	Wait() error
}

type processRunner interface {
	Start(context.Context, string, []string) (process, error)
}

type commandRunner struct{}

type commandProcess struct {
	cmd         *exec.Cmd
	stdinWriter *os.File
	// stderrBuf keeps only the tail of FFmpeg diagnostics so a chatty child
	// cannot grow manager memory without bound over long runs.
	stderrBuf *tailBuffer
}

func (commandRunner) Start(ctx context.Context, executable string, args []string) (process, error) {
	// #nosec G204 -- this is direct FFmpeg execution with an argument array; no shell interprets the configured path or arguments.
	cmd := exec.CommandContext(ctx, executable, args...)
	stdinReader, stdinWriter, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd.Stdin = stdinReader
	cmd.Stdout = nil
	// Capture the tail of stderr for debugging; the buffer is capped so a
	// long-lived FFmpeg process cannot exhaust memory with diagnostics.
	stderrBuf := &tailBuffer{limit: maxStderrBytes}
	cmd.Stderr = stderrBuf
	cmd.WaitDelay = 5 * time.Second
	cmd.Cancel = func() error {
		_, writeErr := stdinWriter.Write([]byte("q\n"))
		closeErr := stdinWriter.Close()
		if writeErr != nil {
			return writeErr
		}
		return closeErr
	}
	if err := cmd.Start(); err != nil {
		_ = stdinReader.Close()
		_ = stdinWriter.Close()
		return nil, err
	}
	_ = stdinReader.Close()
	return &commandProcess{cmd: cmd, stdinWriter: stdinWriter, stderrBuf: stderrBuf}, nil
}

func (p *commandProcess) Wait() error {
	err := p.cmd.Wait()
	_ = p.stdinWriter.Close()
	return err
}

type Status struct {
	Enabled       bool      `json:"enabled"`
	State         string    `json:"state"`
	StartedAt     time.Time `json:"started_at,omitempty"`
	RestartCount  uint64    `json:"restart_count"`
	LastExit      time.Time `json:"last_exit,omitempty"`
	LastError     string    `json:"last_error,omitempty"`
	Profile       string    `json:"profile"`
	PlaylistPath  string    `json:"-"`
	PlaylistReady bool      `json:"playlist_ready"`
}

// Manager owns the FFmpeg process and its bounded HLS output directory.
type Manager struct {
	cfg        config.SamsungTVConfig
	executable string
	runner     processRunner
	logger     *zap.Logger

	mu           sync.RWMutex
	state        string
	startedAt    time.Time
	lastExit     time.Time
	lastError    string
	restartCount uint64
	active       bool
	generation   uint64
	ctx          context.Context
	cancel       context.CancelFunc
	done         chan struct{}
}

func NewManager(cfg *config.SamsungTVConfig, logger *zap.Logger) (*Manager, error) {
	return newManager(cfg, nil, logger)
}

// resolveFFmpeg locates the FFmpeg executable the gateway will run. An explicit
// configured path is honoured first. When that path is a bare command name it is
// resolved from PATH, and if PATH has no FFmpeg the gateway falls back to a
// StreamDBC-managed build under the per-user application data directory. The
// fallback keeps the Windows one-click flow working on hosts where FFmpeg was
// installed beside StreamDBC instead of onto the system PATH.
func resolveFFmpeg(configured string) string {
	configured = strings.TrimSpace(configured)
	if configured != "" && configured != "ffmpeg" && configured != "ffmpeg.exe" {
		if resolved, err := exec.LookPath(configured); err == nil {
			return resolved
		}
		if filepath.IsAbs(configured) {
			return ""
		}
	}

	// The Windows Control Panel sets this to its bundled runtime before
	// starting the server, making the bundled verified build the first choice.
	if bundled := strings.TrimSpace(os.Getenv("STREMDBC_FFMPEG_PATH")); bundled != "" {
		if info, err := os.Stat(bundled); err == nil && !info.IsDir() {
			return bundled
		}
	}

	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData != "" {
		managedRoot := filepath.Join(localAppData, "StreamDBC", "FFmpeg")
		entries, err := os.ReadDir(managedRoot)
		if err == nil {
			names := make([]string, 0, len(entries))
			for _, entry := range entries {
				if entry.IsDir() {
					names = append(names, entry.Name())
				}
			}
			sort.Slice(names, func(i, j int) bool { return compareVersionDirs(names[i], names[j]) > 0 })
			for _, name := range names {
				for _, candidate := range []string{"ffmpeg.exe", "ffmpeg"} {
					candidatePath := filepath.Join(managedRoot, name, candidate)
					if info, err := os.Stat(candidatePath); err == nil && !info.IsDir() {
						return candidatePath
					}
				}
			}
		}
	}

	// System PATH is intentionally the final fallback.
	for _, candidate := range []string{configured, "ffmpeg.exe", "ffmpeg"} {
		if strings.TrimSpace(candidate) == "" {
			continue
		}
		if resolved, err := exec.LookPath(candidate); err == nil {
			return resolved
		}
	}
	return ""
}

// compareVersionDirs compares directory names as dot-separated numeric
// versions, falling back to string comparison for non-numeric segments.
func compareVersionDirs(a, b string) int {
	aParts := strings.Split(a, ".")
	bParts := strings.Split(b, ".")
	for i := 0; i < len(aParts) && i < len(bParts); i++ {
		aNum, aErr := strconv.Atoi(aParts[i])
		bNum, bErr := strconv.Atoi(bParts[i])
		if aErr == nil && bErr == nil {
			if aNum != bNum {
				return aNum - bNum
			}
			continue
		}
		if aParts[i] != bParts[i] {
			if aParts[i] < bParts[i] {
				return -1
			}
			return 1
		}
	}
	return len(aParts) - len(bParts)
}

// newManager accepts a process runner for lifecycle tests while production
// construction always resolves and starts the configured FFmpeg executable.
func newManager(cfg *config.SamsungTVConfig, runner processRunner, logger *zap.Logger) (*Manager, error) {
	if cfg == nil {
		return nil, fmt.Errorf("configuration for Samsung TV is required")
	}
	copyCfg := *cfg
	validation := config.DefaultConfig()
	validation.SamsungTV = copyCfg
	validation.API.Enable = true
	if err := validation.Validate(); err != nil {
		return nil, fmt.Errorf("invalid Samsung TV configuration: %w", err)
	}
	if copyCfg.Enable && !filepath.IsAbs(copyCfg.OutputPath) {
		return nil, fmt.Errorf("output path for Samsung TV is not absolute on this operating system")
	}
	if logger == nil {
		logger = zap.NewNop()
	}
	executable := copyCfg.FFmpegPath
	if runner == nil && copyCfg.Enable {
		resolved := resolveFFmpeg(executable)
		if resolved == "" {
			return nil, fmt.Errorf("FFmpeg executable is not available")
		}
		executable = resolved
		runner = commandRunner{}
	} else if runner == nil {
		runner = commandRunner{}
	}
	return &Manager{
		cfg:        copyCfg,
		executable: executable,
		runner:     runner,
		logger:     logger.Named("samsung-tv"),
		state:      StateStopped,
	}, nil
}

// Start launches FFmpeg in the background. It returns once the output
// directory is ready; Status reports when FFmpeg reaches LIVE.
func (m *Manager) Start() error {
	if !m.cfg.Enable {
		return ErrDisabled
	}
	m.mu.Lock()
	if m.active {
		m.mu.Unlock()
		return ErrAlreadyStarted
	}
	m.active = true
	m.state = StateStarting
	m.startedAt = time.Now().UTC()
	m.lastExit = time.Time{}
	m.lastError = ""
	m.restartCount = 0
	m.generation++
	gen := m.generation
	ctx, cancel := context.WithCancel(context.Background())
	m.ctx, m.cancel, m.done = ctx, cancel, make(chan struct{})
	done := m.done
	m.mu.Unlock()

	if err := prepareOutputDirectory(m.cfg.OutputPath); err != nil {
		m.finish(gen, StateFailed)
		m.setLastError(gen, "HLS output directory could not be prepared")
		close(done)
		return fmt.Errorf("prepare Samsung TV output directory: %w", err)
	}
	if ctx.Err() != nil {
		m.finish(gen, StateStopped)
		close(done)
		return nil
	}
	go m.run(ctx, gen, done)
	m.logger.Info("Samsung TV gateway started", zap.String("profile", m.cfg.Profile), zap.String("source", m.cfg.Source))
	return nil
}

// Stop asks FFmpeg to quit, waits for the child process, and stops automatic
// restarts. A five-second FFmpeg grace period is followed by exec's kill fallback.
func (m *Manager) Stop(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	m.mu.RLock()
	if !m.active {
		m.mu.RUnlock()
		return nil
	}
	cancel, done := m.cancel, m.done
	m.mu.RUnlock()
	if cancel != nil {
		cancel()
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("waiting for Samsung TV gateway to stop: %w", ctx.Err())
	}
}

func (m *Manager) Status() Status {
	m.mu.RLock()
	playlistActive := m.active && m.state == StateLive
	status := Status{
		Enabled:      m.cfg.Enable,
		State:        m.state,
		StartedAt:    m.startedAt,
		RestartCount: m.restartCount,
		LastExit:     m.lastExit,
		LastError:    m.lastError,
		Profile:      m.cfg.Profile,
		PlaylistPath: filepath.Join(m.cfg.OutputPath, "index.m3u8"),
	}
	m.mu.RUnlock()
	if playlistActive {
		info, err := os.Lstat(status.PlaylistPath)
		status.PlaylistReady = err == nil && info.Mode().IsRegular() && info.Size() > 0
	}
	return status
}

func (m *Manager) run(ctx context.Context, gen uint64, done chan struct{}) {
	defer func() {
		finalState := StateStopped
		m.mu.RLock()
		if m.generation == gen && m.state == StateFailed {
			finalState = StateFailed
		}
		m.mu.RUnlock()
		m.finish(gen, finalState)
		close(done)
	}()

	attempt := 0
	for {
		if ctx.Err() != nil {
			return
		}
		if attempt > 0 {
			m.setState(gen, StateRestarting)
			if !waitContext(ctx, BackoffDuration(attempt-1)) {
				return
			}
		}
		if err := prepareOutputDirectory(m.cfg.OutputPath); err != nil {
			m.recordFailure(gen, "HLS output directory could not be prepared", time.Time{})
			if !m.cfg.AutoRestart {
				m.finish(gen, StateFailed)
				return
			}
			attempt++
			continue
		}
		args, err := BuildArgs(m.cfg)
		if err != nil {
			m.recordFailure(gen, "FFmpeg arguments could not be built", time.Time{})
			m.finish(gen, StateFailed)
			return
		}
		child, err := m.runner.Start(ctx, m.executable, args)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			m.recordFailure(gen, "FFmpeg failed to start", time.Time{})
			if !m.cfg.AutoRestart {
				m.finish(gen, StateFailed)
				return
			}
			attempt++
			continue
		}
		m.setState(gen, StateLive)
		waitErr := child.Wait()
		if ctx.Err() != nil {
			return
		}
		exitedAt := time.Now().UTC()
		// Capture stderr from the process for debugging
		var stderr string
		if cp, ok := child.(*commandProcess); ok && cp.stderrBuf != nil {
			stderr = cp.stderrBuf.String()
		}
		msg := describeExit(waitErr)
		if stderr != "" {
			msg += "; stderr: " + stderr
		}
		m.recordFailure(gen, msg, exitedAt)
		if !m.cfg.AutoRestart {
			m.finish(gen, StateFailed)
			return
		}
		attempt++
	}
}

// tailBuffer retains only the most recent bytes written to it.
type tailBuffer struct {
	mu    sync.Mutex
	data  []byte
	limit int
}

func (b *tailBuffer) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	originalLength := len(data)
	if b.limit > 0 {
		if len(data) > b.limit {
			data = data[len(data)-b.limit:]
		}
		b.data = append(b.data, data...)
		if len(b.data) > b.limit {
			b.data = append([]byte(nil), b.data[len(b.data)-b.limit:]...)
		}
	}
	return originalLength, nil
}

func (b *tailBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.data)
}

func (m *Manager) setState(gen uint64, state string) {
	m.mu.Lock()
	if m.generation == gen {
		m.state = state
	}
	m.mu.Unlock()
}

func (m *Manager) setLastError(gen uint64, message string) {
	m.mu.Lock()
	if m.generation == gen {
		m.lastError = message
	}
	m.mu.Unlock()
}

func (m *Manager) recordFailure(gen uint64, message string, exitedAt time.Time) {
	m.mu.Lock()
	if m.generation == gen {
		m.restartCount++
		m.lastError = message
		if !exitedAt.IsZero() {
			m.lastExit = exitedAt
		}
		m.state = StateRestarting
		m.logger.Warn("Samsung TV FFmpeg process exited", zap.Uint64("restart_count", m.restartCount), zap.String("state", m.state))
	}
	m.mu.Unlock()
}

func (m *Manager) finish(gen uint64, state string) {
	m.mu.Lock()
	if m.generation == gen {
		m.active = false
		m.state = state
	}
	m.mu.Unlock()
}

func describeExit(err error) string {
	if err == nil {
		return "FFmpeg exited unexpectedly"
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return "FFmpeg exited with code " + strconv.Itoa(exitErr.ExitCode())
	}
	return "FFmpeg process wait failed"
}

func waitContext(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// BackoffDuration grows exponentially and is capped at 30 seconds.
func BackoffDuration(attempt int) time.Duration {
	duration := time.Second
	for index := 0; index < attempt && duration < maxBackoff; index++ {
		duration *= 2
	}
	if duration > maxBackoff {
		return maxBackoff
	}
	return duration
}

func prepareOutputDirectory(outputPath string) error {
	if err := os.MkdirAll(outputPath, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(outputPath)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("configured output root is not a plain directory")
	}
	root, err := os.OpenRoot(outputPath)
	if err != nil {
		return err
	}
	defer root.Close()
	directory, err := root.Open(".")
	if err != nil {
		return err
	}
	entries, err := directory.ReadDir(-1)
	_ = directory.Close()
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() && managedOutputName(entry.Name()) {
			if err := root.Remove(entry.Name()); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
	}
	return nil
}

func managedOutputName(name string) bool {
	if name == "index.m3u8" || name == "index.m3u8.tmp" {
		return true
	}
	if !strings.HasPrefix(name, "segment_") {
		return false
	}
	segment := strings.TrimPrefix(name, "segment_")
	segment = strings.TrimSuffix(segment, ".tmp")
	if !strings.HasSuffix(segment, ".ts") {
		return false
	}
	digits := strings.TrimSuffix(segment, ".ts")
	if len(digits) < 6 {
		return false
	}
	for _, digit := range digits {
		if digit < '0' || digit > '9' {
			return false
		}
	}
	return true
}
