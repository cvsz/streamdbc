package samsung

import "os"

type processTreeGuard interface {
	Close() error
}

// newProcessTreeGuard keeps FFmpeg and any descendants tied to the server
// process lifetime on platforms that support process-tree ownership.
func newProcessTreeGuard(process *os.Process) (processTreeGuard, error) {
	return newPlatformProcessTreeGuard(process)
}
