//go:build !windows

package samsung

import "os"

type noopProcessTreeGuard struct{}

func (noopProcessTreeGuard) Close() error { return nil }

func newPlatformProcessTreeGuard(_ *os.Process) (processTreeGuard, error) {
	return noopProcessTreeGuard{}, nil
}
