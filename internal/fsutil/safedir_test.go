package fsutil

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestOpenWriteRemoveRoundTrip(t *testing.T) {
	root := t.TempDir()
	dir, err := OpenStreamDir(root, "demo")
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	if err := dir.WriteFile("segment_0.ts", []byte("payload"), 0o640); err != nil {
		t.Fatal(err)
	}
	names, err := dir.FileNames()
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 1 || names[0] != "segment_0.ts" {
		t.Fatalf("names = %v", names)
	}
	content, err := os.ReadFile(filepath.Join(dir.Path(), "segment_0.ts"))
	if err != nil || string(content) != "payload" {
		t.Fatalf("content = %q, err = %v", content, err)
	}
	info, err := os.Stat(filepath.Join(dir.Path(), "segment_0.ts"))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o640 {
		t.Fatalf("perm = %v", info.Mode().Perm())
	}
	if err := dir.RemoveFile("segment_0.ts"); err != nil {
		t.Fatal(err)
	}
	if err := dir.RemoveAll(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir.Path()); !os.IsNotExist(err) {
		t.Fatalf("directory still exists: %v", err)
	}
}

func TestRejectsBadNames(t *testing.T) {
	root := t.TempDir()
	dir, err := OpenStreamDir(root, "demo")
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	for _, name := range []string{"", ".", "..", "../x", "a/b", "a\\b", ".hidden", "x\x00y", "segment_*.ts"} {
		if err := dir.WriteFile(name, []byte("x"), 0o640); err == nil {
			t.Fatalf("WriteFile(%q) unexpectedly succeeded", name)
		}
		if err := dir.RemoveFile(name); err == nil {
			t.Fatalf("RemoveFile(%q) unexpectedly succeeded", name)
		}
	}
	if _, err := OpenStreamDir(root, "../escape"); err == nil {
		t.Fatal("OpenStreamDir accepted escaping stream ID")
	}
}

func TestSymlinkSwapFailsClosed(t *testing.T) {
	root := t.TempDir()
	dir, err := OpenStreamDir(root, "demo")
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	target := t.TempDir()
	// Swap the validated directory for a symlink after pinning.
	if err := os.Remove(dir.Path()); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, dir.Path()); err != nil {
		t.Fatal(err)
	}
	if err := dir.WriteFile("segment_0.ts", []byte("payload"), 0o640); err == nil {
		t.Fatal("WriteFile through swapped symlink unexpectedly succeeded")
	}
	if _, err := dir.FileNames(); err == nil {
		t.Fatal("FileNames through swapped symlink unexpectedly succeeded")
	}
	if err := dir.RemoveFile("segment_0.ts"); err == nil {
		t.Fatal("RemoveFile through swapped symlink unexpectedly succeeded")
	}
	if entries, _ := os.ReadDir(target); len(entries) != 0 {
		t.Fatalf("symlink target was written through: %v", entries)
	}
}

func TestRemoveAllDoesNotFollowSwappedSymlink(t *testing.T) {
	root := t.TempDir()
	dir, err := OpenStreamDir(root, "demo")
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	if err := dir.WriteFile("segment_0.ts", []byte("payload"), 0o640); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	canary := filepath.Join(outside, "canary.txt")
	if err := os.WriteFile(canary, []byte("keep"), 0o640); err != nil {
		t.Fatal(err)
	}
	// Swap the directory for a symlink to an outside tree, then remove.
	// (Remove the pinned file first so the swap starts from an empty dir.)
	if err := dir.RemoveFile("segment_0.ts"); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(dir.Path()); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, dir.Path()); err != nil {
		t.Fatal(err)
	}
	_ = dir.RemoveAll()
	if _, err := os.Stat(canary); err != nil {
		t.Fatalf("outside file was removed through swapped symlink: %v", err)
	}
}
