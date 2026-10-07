// Package fsutil provides directory-pinned file operations for generated
// stream output (HLS segments, LL-HLS parts, playlists). A PinnedDir binds
// an output directory at creation time so a later symlink swap of that
// directory cannot redirect segment writes, playlist writes, cleanups, or
// recursive removal outside the output root.
//
// On Linux every mutation is performed relative to an O_NOFOLLOW directory
// file descriptor (openat/renameat/unlinkat), which closes the
// check-then-write race completely. On other platforms each operation
// re-validates the directory (Lstat plus symlink resolution) immediately
// beforehand, shrinking the race window to a single syscall pair.
package fsutil

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/cvsz/stremdbc/internal/core"
)

var validFileName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

// PinnedDir is a validated, optionally fd-pinned stream output directory.
type PinnedDir struct {
	root string
	dir  string
	fd   int
}

// OpenStreamDir creates (if needed), validates, and pins the output
// directory root/streamID. The stream ID allowlist blocks path separators,
// so streamID can never escape root; the Lstat and symlink-resolution
// checks additionally reject pre-existing symlink swaps.
func OpenStreamDir(root, streamID string) (*PinnedDir, error) {
	if err := core.ValidateStreamID(streamID); err != nil {
		return nil, err
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve output root: %w", err)
	}
	dir := filepath.Join(rootAbs, streamID)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("create stream directory: %w", err)
	}
	if err := validateDir(rootAbs, dir); err != nil {
		return nil, err
	}
	fd, err := openPinned(dir)
	if err != nil {
		return nil, err
	}
	return &PinnedDir{root: rootAbs, dir: dir, fd: fd}, nil
}

// Path returns the absolute stream directory path.
func (d *PinnedDir) Path() string {
	return d.dir
}

// Close releases the pinned directory handle. File operations after Close
// fail closed.
func (d *PinnedDir) Close() error {
	return closePinned(d)
}

// WriteFile atomically writes data to name inside the pinned directory.
func (d *PinnedDir) WriteFile(name string, data []byte, perm os.FileMode) error {
	if err := validateFileName(name); err != nil {
		return err
	}
	return writeFilePinned(d, name, data, perm)
}

// RemoveFile removes name from the pinned directory.
func (d *PinnedDir) RemoveFile(name string) error {
	if err := validateFileName(name); err != nil {
		return err
	}
	return removeFilePinned(d, name)
}

// FileNames lists entry names in the pinned directory.
func (d *PinnedDir) FileNames() ([]string, error) {
	return fileNamesPinned(d)
}

// RemoveAll removes every entry inside the pinned directory and then the
// directory itself. It retries briefly so a racing writer cannot leave the
// directory half-removed without an error.
func (d *PinnedDir) RemoveAll() error {
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		if err = removeAllPinned(d); err == nil {
			return nil
		}
	}
	return err
}

func validateFileName(name string) error {
	if !validFileName.MatchString(name) || strings.Contains(name, "..") {
		return fmt.Errorf("invalid output file name %q", name)
	}
	return nil
}

// validateDir rejects symlink swaps and root escapes.
func validateDir(root, dir string) error {
	info, err := os.Lstat(dir)
	if err != nil {
		return fmt.Errorf("stat stream directory: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("stream directory is not a regular directory")
	}
	rootResolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return fmt.Errorf("resolve output root: %w", err)
	}
	dirResolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return fmt.Errorf("resolve stream directory: %w", err)
	}
	relative, err := filepath.Rel(rootResolved, dirResolved)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("stream directory escapes output root")
	}
	return nil
}
