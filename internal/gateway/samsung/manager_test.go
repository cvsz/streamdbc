package samsung

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/cvsz/stremdbc/internal/config"
)

type fakeRunner struct {
	mu        sync.Mutex
	startErrs []error
	processes chan *fakeProcess
	args      chan []string
}

func newFakeRunner() *fakeRunner {
	return &fakeRunner{processes: make(chan *fakeProcess, 8), args: make(chan []string, 8)}
}

func (r *fakeRunner) Start(ctx context.Context, _ string, args []string) (process, error) {
	r.mu.Lock()
	if len(r.startErrs) > 0 {
		err := r.startErrs[0]
		r.startErrs = r.startErrs[1:]
		r.mu.Unlock()
		return nil, err
	}
	r.mu.Unlock()
	child := &fakeProcess{ctx: ctx, exit: make(chan error, 1)}
	r.args <- append([]string(nil), args...)
	r.processes <- child
	return child, nil
}

type fakeProcess struct {
	ctx  context.Context
	exit chan error
}

func (p *fakeProcess) Wait() error {
	select {
	case err := <-p.exit:
		return err
	case <-p.ctx.Done():
		return nil
	}
}

func testManager(t *testing.T, runner processRunner, autoRestart bool) (*Manager, *fakeRunner) {
	t.Helper()
	fake, _ := runner.(*fakeRunner)
	cfg := testConfig(t)
	cfg.AutoRestart = autoRestart
	manager, err := newManager(&cfg, runner, nil)
	if err != nil {
		t.Fatalf("newManager: %v", err)
	}
	return manager, fake
}

func testConfig(t *testing.T) config.SamsungTVConfig {
	t.Helper()
	cfg := config.DefaultConfig().SamsungTV
	cfg.Enable = true
	cfg.OutputPath = t.TempDir()
	return cfg
}

func TestManagerStartDuplicateStartAndGracefulStop(t *testing.T) {
	runner := newFakeRunner()
	manager, _ := testManager(t, runner, true)
	if err := manager.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	child := waitForProcess(t, runner)
	waitForState(t, manager, StateLive)
	if err := manager.Start(); !errors.Is(err, ErrAlreadyStarted) {
		t.Fatalf("duplicate Start error = %v, want %v", err, ErrAlreadyStarted)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := manager.Stop(ctx); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	select {
	case <-child.ctx.Done():
	default:
		t.Fatal("Stop did not cancel the FFmpeg process context")
	}
	waitForState(t, manager, StateStopped)
	if err := manager.Stop(ctx); err != nil {
		t.Fatalf("repeated Stop: %v", err)
	}
}

func TestManagerRestartsAfterUnexpectedExit(t *testing.T) {
	runner := newFakeRunner()
	manager, _ := testManager(t, runner, true)
	if err := manager.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	first := waitForProcess(t, runner)
	waitForState(t, manager, StateLive)
	first.exit <- errors.New("device unavailable")
	second := waitForProcess(t, runner)
	if second == first {
		t.Fatal("restart reused the exited process")
	}
	status := manager.Status()
	if status.State != StateLive || status.RestartCount != 1 || status.LastExit.IsZero() || status.LastError == "" {
		t.Fatalf("restart status does not report the recovered exit: %+v", status)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := manager.Stop(ctx); err != nil {
		t.Fatalf("Stop after restart: %v", err)
	}
}

func TestManagerStopsRestartingAfterUnexpectedExitWhenAutoRestartDisabled(t *testing.T) {
	runner := newFakeRunner()
	manager, _ := testManager(t, runner, false)
	if err := manager.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	child := waitForProcess(t, runner)
	waitForState(t, manager, StateLive)
	child.exit <- errors.New("capture ended")
	waitForState(t, manager, StateFailed)
	if status := manager.Status(); status.RestartCount != 1 || status.LastError == "" {
		t.Fatalf("failed status does not report the exit: %+v", status)
	}
	select {
	case <-runner.processes:
		t.Fatal("manager restarted even though auto_restart is disabled")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestManagerReportsDisabledAndRejectsStart(t *testing.T) {
	cfg := config.DefaultConfig().SamsungTV
	manager, err := newManager(&cfg, newFakeRunner(), nil)
	if err != nil {
		t.Fatalf("newManager disabled: %v", err)
	}
	if err := manager.Start(); !errors.Is(err, ErrDisabled) {
		t.Fatalf("disabled Start error = %v, want %v", err, ErrDisabled)
	}
	status := manager.Status()
	if status.Enabled || status.State != StateStopped || status.PlaylistPath == "" {
		t.Fatalf("disabled status is incomplete: %+v", status)
	}
}

func TestRestartBackoffIsBounded(t *testing.T) {
	for attempt, expected := range map[int]time.Duration{0: time.Second, 1: 2 * time.Second, 2: 4 * time.Second, 3: 8 * time.Second, 4: 16 * time.Second, 5: 30 * time.Second, 20: 30 * time.Second, 1000: 30 * time.Second} {
		if got := BackoffDuration(attempt); got != expected {
			t.Errorf("BackoffDuration(%d) = %s, want %s", attempt, got, expected)
		}
	}
}

func TestPrepareOutputDirectoryOnlyRemovesManagedFiles(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	for _, name := range []string{"index.m3u8", "index.m3u8.tmp", "segment_000001.ts", "segment_000002.ts.tmp", "keep.txt"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("data"), 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o600); err != nil {
		t.Fatalf("write outside file: %v", err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "segment_000003.ts")); err != nil {
		t.Skipf("symlink creation unavailable: %v", err)
	}
	if err := os.Mkdir(filepath.Join(root, "segment_000004.ts"), 0o700); err != nil {
		t.Fatalf("create unrelated directory: %v", err)
	}
	if err := prepareOutputDirectory(root); err != nil {
		t.Fatalf("prepareOutputDirectory: %v", err)
	}
	for _, name := range []string{"index.m3u8", "index.m3u8.tmp", "segment_000001.ts", "segment_000002.ts.tmp", "segment_000003.ts"} {
		if _, err := os.Lstat(filepath.Join(root, name)); !os.IsNotExist(err) {
			t.Errorf("managed entry %s remains or failed to stat: %v", name, err)
		}
	}
	for _, name := range []string{"keep.txt", "segment_000004.ts"} {
		if _, err := os.Lstat(filepath.Join(root, name)); err != nil {
			t.Errorf("unmanaged entry %s was removed: %v", name, err)
		}
	}
	if contents, err := os.ReadFile(filepath.Join(outside, "secret.txt")); err != nil || string(contents) != "secret" {
		t.Fatalf("cleanup touched a file outside the configured output root: %q, %v", contents, err)
	}
}

func TestManagerRejectsSymlinkOutputRoot(t *testing.T) {
	target := t.TempDir()
	link := filepath.Join(t.TempDir(), "output")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink creation unavailable: %v", err)
	}
	cfg := testConfig(t)
	cfg.OutputPath = link
	manager, err := newManager(&cfg, newFakeRunner(), nil)
	if err != nil {
		t.Fatalf("newManager: %v", err)
	}
	if err := manager.Start(); err == nil {
		t.Fatal("Start accepted a symlink output root")
	}
	if status := manager.Status(); status.State != StateFailed || status.LastError == "" {
		t.Fatalf("failed output root status = %+v", status)
	}
}

func waitForProcess(t *testing.T, runner *fakeRunner) *fakeProcess {
	t.Helper()
	select {
	case child := <-runner.processes:
		return child
	case <-time.After(4 * time.Second):
		t.Fatal("FFmpeg process did not start")
		return nil
	}
}

func waitForState(t *testing.T, manager *Manager, state string) {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if manager.Status().State == state {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("gateway state did not become %s; got %+v", state, manager.Status())
}
