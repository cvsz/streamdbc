//go:build linux

package fsutil

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

func openPinned(dir string) (int, error) {
	fd, err := unix.Open(dir, unix.O_NOFOLLOW|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, fmt.Errorf("pin stream directory: %w", err)
	}
	return fd, nil
}

func closePinned(d *PinnedDir) error {
	if d.fd < 0 {
		return nil
	}
	fd := d.fd
	d.fd = -1
	return unix.Close(fd)
}

// pinCheck verifies the pinned handle still refers to the same directory
// that path operations would resolve: same device, same inode, still a
// directory. A post-open symlink swap changes what the path resolves to,
// so the comparison fails closed.
func pinCheck(d *PinnedDir) error {
	if d.fd < 0 {
		return fmt.Errorf("pinned directory is closed")
	}
	var handleStat, pathStat unix.Stat_t
	if err := unix.Fstat(d.fd, &handleStat); err != nil {
		return fmt.Errorf("stat pinned directory: %w", err)
	}
	if err := unix.Stat(d.dir, &pathStat); err != nil {
		return fmt.Errorf("stat stream directory: %w", err)
	}
	if handleStat.Dev != pathStat.Dev || handleStat.Ino != pathStat.Ino {
		return fmt.Errorf("stream directory was replaced")
	}
	if handleStat.Mode&unix.S_IFMT != unix.S_IFDIR {
		return fmt.Errorf("pinned handle is not a directory")
	}
	return nil
}

func tempName() (string, error) {
	var nonce [8]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", fmt.Errorf("generate temp name: %w", err)
	}
	return ".stremdbc-" + hex.EncodeToString(nonce[:]), nil
}

func writeFilePinned(d *PinnedDir, name string, data []byte, perm os.FileMode) error {
	if err := pinCheck(d); err != nil {
		return err
	}
	var tmp string
	var tmpFD int = -1
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		if tmp, err = tempName(); err != nil {
			return err
		}
		// #nosec G304 -- tmp is a generated dotfile inside the pinned dir.
		tmpFD, err = unix.Openat(d.fd, tmp, unix.O_CREAT|unix.O_EXCL|unix.O_WRONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, uint32(perm.Perm()))
		if err == nil {
			break
		}
	}
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	defer func() {
		_ = unix.Close(tmpFD)
		_ = unix.Unlinkat(d.fd, tmp, 0)
	}()
	for len(data) > 0 {
		n, writeErr := unix.Write(tmpFD, data)
		if writeErr != nil {
			return fmt.Errorf("write temp file: %w", writeErr)
		}
		data = data[n:]
	}
	if err := unix.Fsync(tmpFD); err != nil {
		return fmt.Errorf("sync temp file: %w", err)
	}
	if err := unix.Close(tmpFD); err != nil {
		return fmt.Errorf("close temp file: %w", err)
	}
	tmpFD = -1
	if err := unix.Renameat(d.fd, tmp, d.fd, name); err != nil {
		return fmt.Errorf("publish output file: %w", err)
	}
	return nil
}

func removeFilePinned(d *PinnedDir, name string) error {
	if err := pinCheck(d); err != nil {
		return err
	}
	if err := unix.Unlinkat(d.fd, name, 0); err != nil {
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
	// Every entry is unlinked relative to the pinned handle, so entries can
	// never be resolved through a swapped path: a swapped-in symlink is
	// unlinked itself, never followed.
	entries, err := os.ReadDir(d.dir)
	if err != nil {
		return fmt.Errorf("read stream directory: %w", err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == "." || name == ".." {
			continue
		}
		flags := 0
		if entry.IsDir() {
			// Recurse fd-relative would require a child handle; instead
			// refuse: generator output is always flat files.
			return fmt.Errorf("unexpected subdirectory %q in stream output", name)
		}
		if err := unix.Unlinkat(d.fd, name, flags); err != nil {
			return fmt.Errorf("remove output entry: %w", err)
		}
	}
	// The directory is empty as seen through the pinned handle. Removing it
	// by path can at worst delete an empty directory or a symlink itself.
	if err := os.Remove(d.dir); err != nil {
		return fmt.Errorf("remove stream directory: %w", err)
	}
	return nil
}
