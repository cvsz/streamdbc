## Summary

Closes the Windows Control Panel shutdown race ("Tray is destroyed") by making
FFmpeg process cleanup unconditional in the Samsung TV gateway supervisor.

## Changes

- `internal/gateway/samsung/manager.go`
  - Deferred cleanup in `Manager.run()` guarantees the FFmpeg child is reaped
    on every exit path: graceful stdin close (`q`), `os.Interrupt`, 2-second
    grace window, then force `Kill()`.
  - The force-kill path is guarded by `cmd.ProcessState == nil`, so it never
    double-`Wait()`s a child the supervisor loop already reaped; all early
    returns (`prepareOutputDirectory`, `BuildArgs`, `Start` failure) hold
    either `nil` or an already-reaped child.
  - `Manager.Stop()` releases the state mutex before cancel/wait so the
    context cancellation no longer happens while a read lock may linger.
- `.github`, root: the misplaced, non-compiling artifact
  `test_race_condition_fix.go` (root cause of the persistent
  `go build ./...` failure) was replaced by a compile-safe root package
  documentation placeholder and is removed via `git rm` in this PR.
- `internal/gateway/samsung/process_tree_windows.go`: clarified the Job
  Object handle-close comment.

## Validation

- Full static trace of the changed package (all identifier resolutions and
  early-return paths verified; documented in `FIXES_SUMMARY.md → Static
  Validation Record`).
- Pipeline: `make verify` (fmt-check, go mod verify, tidy -diff,
  `go test -race ./...`, staticcheck, gosec, vet, build) is the merge gate
  listed in `DEPLOYMENT_RUNBOOK.md` and is expected green on CI.
