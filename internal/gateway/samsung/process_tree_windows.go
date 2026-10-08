//go:build windows

package samsung

import (
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

type windowsProcessTreeGuard struct {
	handle windows.Handle
}

func newPlatformProcessTreeGuard(process *os.Process) (processTreeGuard, error) {
	if process == nil || process.Pid <= 0 {
		return nil, fmt.Errorf("FFmpeg process identity is unavailable")
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("create FFmpeg job object: %w", err)
	}

	var limits windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	limits.BasicLimitInformation.LimitFlags |= windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)),
		uint32(unsafe.Sizeof(limits)),
	); err != nil {
		_ = windows.CloseHandle(job)
		return nil, fmt.Errorf("set FFmpeg job lifetime policy: %w", err)
	}
	processHandle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(process.Pid))
	if err != nil {
		_ = windows.CloseHandle(job)
		return nil, fmt.Errorf("open FFmpeg process for job assignment: %w", err)
	}
	defer windows.CloseHandle(processHandle)
	if err := windows.AssignProcessToJobObject(job, processHandle); err != nil {
		_ = windows.CloseHandle(job)
		return nil, fmt.Errorf("assign FFmpeg to managed job: %w", err)
	}
	return &windowsProcessTreeGuard{handle: job}, nil
}

func (guard *windowsProcessTreeGuard) Close() error {
	if guard == nil || guard.handle == 0 {
		return nil
	}
	handle := guard.handle
	guard.handle = 0
	if err := windows.CloseHandle(handle); err != nil {
		return fmt.Errorf("close FFmpeg job object: %w", err)
	}
	return nil
}
