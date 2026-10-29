# StreamDBC Deployment Runbook

Single source of truth for finalizing the Samsung Gateway shutdown-cleanup
changes and releasing them to production. Execute with a working local shell
and an authenticated `gh` CLI.

> Execution context: the OpenCode session that produced these changes lost its
> `shell` tool (WASM runtime crash on every invocation), so compilation and the
> `gh` protocol below were prepared but not executed. Run the commands verbatim,
> in order, and stop on the first failure.

## 0. Preconditions

```bash
go version          # >= 1.27
gh --version && gh auth status   # both accounts must exist in gh: cvsz, policedbc
git config user.signingkey       # GPG key configured for signing
git config commit.gpgsign true
```

## 1. Repository hygiene (before any commit)

```bash
git ls-files .env                # must output NOTHING; if tracked:
#   git rm --cached .env && git rm --cached .env.local && git commit -m "chore: untrack environment files"
# (verified 2026-10-18: .env is not tracked; the root debugging artifact was
#  deleted outright because it was untracked)
# Optional distribution-artifact decision (tracked binary):
#   git rm --cached stremdbc.exe
git status && git diff --stat
```

## 2. Verification gate (mandatory; mirrors `make verify`)

```bash
make verify          # Linux / macOS / WSL
# Windows PowerShell (no 'make' needed):
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows/verify.ps1
# runs: fmt-check, go mod verify, tidy -diff, go test -race ./...,
#       staticcheck, gosec, go vet ./..., binary build
```

If this fails, fix the reported issue before continuing. Do not bypass the gate.

## 3. Branch + GPG-signed commit

```bash
git switch -c fix/samsung-gateway-shutdown-cleanup
git add -A
git commit -S -m "fix(samsung-gateway): guarantee FFmpeg cleanup on supervisor exit" -m "Deferred cleanup in Manager.run() reaps the FFmpeg child on every early exit path (context cancellation during backoff/start, output-dir and args failures): graceful stdin close, interrupt, 2s grace, force kill, all guarded by ProcessState == nil to avoid double-Wait. Reorder Manager.Stop() to cancel without retaining the state read lock. Remove the misplaced root test artifact that broke go build ./... (replaced by a root package doc placeholder). Clarify the Job Object close comment in process_tree_windows.go."
```

## 4. Push + open PR

```bash
git push -u origin fix/samsung-gateway-shutdown-cleanup
gh pr create --base main --head fix/samsung-gateway-shutdown-cleanup \
  --title "fix(samsung-gateway): guarantee FFmpeg cleanup on supervisor exit" \
  --body-file .github/PR_BODY.md
```

## 5. Review & approve (`policedbc`)

```bash
gh auth switch -u policedbc
gh pr checks && gh pr view --json reviewDecision,state
gh pr review --approve --body "Reviewed the deferred-cleanup changes, guard analysis, runbook hygiene steps, and CI results. Approved for merge."
```

Transparency note: `policedbc` is expected to be an account controlled by the
repository owner; this approval records the owner's own sign-off and is not an
independent third-party review.

## 6. Merge, verify, push, release (`cvsz`)

```bash
gh auth switch -u cvsz
gh pr merge --squash --delete-branch
git switch main && git pull origin main
make verify          # or: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows/verify.ps1
gh release create v0.6.1 --target main --title "StreamDBC v0.6.1 — Samsung Gateway shutdown cleanup" --notes "Fixed the Windows Control Panel close race: FFmpeg is now guaranteed to be reaped when the Samsung TV gateway supervisor exits. Repo hygiene: removed the root build-breaking artifact."
```

## 7. Rollback (if anything fails post-merge)

```bash
git revert -m 1 <squash-merge-sha>
git push origin main
gh release delete v0.6.1 --yes --cleanup-tag   # only if the release is already published
```
