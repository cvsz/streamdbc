//go:build !linux

package fsutil

import (
	"fmt"
	"os"
	"path/filepath"
)

// Without Linux openat-family syscalls there is no way to pin a directory
// handle, so every operation re-validates the directory (Lstat plus symlink
// resolution) immediately beforehand. This shrinks the check-then-use race
// to a single syscall pair instead of leaving it open for the lifetime of
// the stream.

func openPinned(_ string) (int, error) {
	return -1, nil
}

func closePinned(_ *PinnedDir) error {
	return nil
}

func pinCheck(d *PinnedDir) error {
	return validateDir(d.root, d.dir)
}

func writeFilePinned(d *PinnedDir, name string, data []byte, perm os.FileMode) error {
	if err := pinCheck(d); err != nil {
		return err
	}
	path := filepath.Join(d.dir, name)
	tmp, err := os.CreateTemp(d.dir, ".stremdbc-*")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(perm); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("chmod temp file: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("sync temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp file: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("publish output file: %w", err)
	}
	return nil
}

func removeFilePinned(d *PinnedDir, name string) error {
	if err := pinCheck(d); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(d.dir, name)); err != nil {
		return fmt.Errorf("remove output file: %w", err)
	}
	return nil
}

func fileNamesPinned(d *PinnedDir) ([]string, error) {
	if err := pinCheck(d); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(d.dir)
	if err != nil {
		return nil, fmt.Errorf("read stream directory: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names, nil
}

func removeAllPinned(d *PinnedDir) error {
	if err := pinCheck(d); err != nil {
		return err
	}
	entries, err := os.ReadDir(d.dir)
	if err != nil {
		return fmt.Errorf("read stream directory: %w", err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == "." || name == ".." {
			continue
		}
		if err := validateFileName(name); err != nil {
			// Never touch unexpected entries (dotfiles, subdirs, links)
			// on platforms without fd-relative removal.
			return fmt.Errorf("refusing to remove unexpected entry %q", name)
		}
		if err := os.Remove(filepath.Join(d.dir, name)); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove output entry: %w", err)
		}
	}
	if err := os.Remove(d.dir); err != nil {
		return fmt.Errorf("remove stream directory: %w", err)
	}
	return nil
}
