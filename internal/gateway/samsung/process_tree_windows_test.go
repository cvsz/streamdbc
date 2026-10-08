//go:build windows

package samsung

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

const (
	processTreeParentEnv = "STREAMDBC_TEST_JOB_PARENT"
	processTreeWorkerEnv = "STREAMDBC_TEST_JOB_WORKER"
	processTreePIDEnv    = "STREAMDBC_TEST_JOB_PID_FILE"
)

// These helper tests run in subprocesses so the parent can exit abruptly,
// simulating a server crash while its FFmpeg child is active.
func TestProcessTreeCrashParentHelper(t *testing.T) {
	if os.Getenv(processTreeParentEnv) != "1" {
		return
	}
	executable, err := os.Executable()
	if err != nil {
		os.Exit(41)
	}
	if err := os.Setenv(processTreeWorkerEnv, "1"); err != nil {
		os.Exit(42)
	}
	_, err = (commandRunner{}).Start(context.Background(), executable, []string{"-test.run=^TestProcessTreeWorkerHelper$"})
	if err != nil {
		os.Exit(43)
	}
	pidPath := os.Getenv(processTreePIDEnv)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(pidPath); err == nil {
			os.Exit(23)
		}
		time.Sleep(25 * time.Millisecond)
	}
	os.Exit(44)
}

func TestProcessTreeWorkerHelper(t *testing.T) {
	if os.Getenv(processTreeWorkerEnv) != "1" {
		return
	}
	pidPath := os.Getenv(processTreePIDEnv)
	if pidPath == "" {
		t.Fatal("worker PID file is not configured")
	}
	if err := os.WriteFile(pidPath, []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		t.Fatalf("write worker PID: %v", err)
	}
	time.Sleep(time.Minute)
}

func TestCommandRunnerKillsFFmpegChildWhenServerCrashes(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("locate test executable: %v", err)
	}
	pidPath := filepath.Join(t.TempDir(), "worker.pid")
	parent := exec.Command(executable, "-test.run=^TestProcessTreeCrashParentHelper$")
	parent.Env = append(os.Environ(), processTreeParentEnv+"=1", processTreePIDEnv+"="+pidPath)
	err = parent.Run()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 23 {
		t.Fatalf("crash-parent exit = %v, want exit code 23 after starting its FFmpeg child", err)
	}

	pidText, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatalf("read FFmpeg child PID: %v", err)
	}
	pid, err := strconv.ParseUint(strings.TrimSpace(string(pidText)), 10, 32)
	if err != nil {
		t.Fatalf("parse FFmpeg child PID: %v", err)
	}
	processHandle, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return // The worker was already reaped before it could be opened.
	}
	if err != nil {
		t.Fatalf("open FFmpeg child process: %v", err)
	}
	defer windows.CloseHandle(processHandle)
	result, err := windows.WaitForSingleObject(processHandle, 5000)
	if err != nil {
		t.Fatalf("wait for FFmpeg child to exit: %v", err)
	}
	if result != windows.WAIT_OBJECT_0 {
		t.Fatal("FFmpeg child survived the server process exit")
	}
}
