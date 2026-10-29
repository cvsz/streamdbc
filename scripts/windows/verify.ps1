[CmdletBinding()]
param(
    # The Windows race detector requires a C toolchain (MinGW) when CGO is
    # enabled; use this switch to skip it and run the plain test suite.
    [switch]$SkipRace
)

# Windows equivalent of the Makefile `verify` gate:
#   fmt-check -> go mod verify -> go mod tidy -diff -> go test -race ./... ->
#   staticcheck -> gosec -> go vet ./... -> binary build.

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).ProviderPath
Push-Location $repoRoot

$previousToolchain = $env:GOTOOLCHAIN

try {
    Write-Host "== StreamDBC verification gate (Windows) ==" -ForegroundColor Cyan

    $go = Get-Command go -ErrorAction SilentlyContinue
    if (-not $go) { throw "Go is not installed or not on PATH." }
    $gofmt = Get-Command gofmt -ErrorAction SilentlyContinue
    if (-not $gofmt) { throw "gofmt is not available; check the Go installation." }
    Write-Host ("Go toolchain: {0}" -f (& go version)) -ForegroundColor DarkGray

    Write-Host "==> [1/8] gofmt check" -ForegroundColor Cyan
    $unformatted = @(& gofmt -l . 2>$null)
    if ($LASTEXITCODE -ne 0) { throw "gofmt could not run." }
    if ($unformatted.Count -gt 0) {
        Write-Host "Go formatting is required in:" -ForegroundColor Yellow
        $unformatted | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
        throw "gofmt check failed (run: gofmt -w .)."
    }

    Write-Host "==> [2/8] go mod verify" -ForegroundColor Cyan
    & go mod verify
    if ($LASTEXITCODE -ne 0) { throw "go mod verify failed." }

    Write-Host "==> [3/8] go mod tidy -diff" -ForegroundColor Cyan
    & go mod tidy -diff
    if ($LASTEXITCODE -ne 0) {
        throw "go.mod/go.sum are not tidy (run: go mod tidy, then commit the change)."
    }

    Write-Host "==> [4/8] go test ./..." -ForegroundColor Cyan
    if ($SkipRace) {
        & go test -count=1 ./...
    } else {
        & go test -race -count=1 ./...
    }
    if ($LASTEXITCODE -ne 0) {
        if (-not $SkipRace) {
            Write-Host "Hint: if the failure output mentions cgo or MinGW, install a C toolchain or rerun with -SkipRace." -ForegroundColor Yellow
        }
        throw "go test ./... failed."
    }

    Write-Host "==> [5/8] staticcheck" -ForegroundColor Cyan
    $env:GOTOOLCHAIN = "go1.27.1"
    & go run honnef.co/go/tools/cmd/staticcheck@v0.8.1 ./...
    if ($LASTEXITCODE -ne 0) { throw "staticcheck failed." }

    Write-Host "==> [6/8] gosec" -ForegroundColor Cyan
    & go run github.com/securego/gosec/v2/cmd/gosec@v2.29.0 ./...
    if ($LASTEXITCODE -ne 0) { throw "gosec failed." }

    Write-Host "==> [7/8] go vet ./..." -ForegroundColor Cyan
    & go vet ./...
    if ($LASTEXITCODE -ne 0) { throw "go vet failed." }

    Write-Host "==> [8/8] build" -ForegroundColor Cyan
    $verifyBinary = Join-Path $env:TEMP "stremdbc-verify.exe"
    & go build -trimpath -o $verifyBinary ./cmd/stremdbc
    if ($LASTEXITCODE -ne 0) { throw "go build failed." }

    Write-Host "== VERIFY PASSED ==" -ForegroundColor Green
    Write-Host ("Verification binary: {0}" -f $verifyBinary) -ForegroundColor DarkGray
} finally {
    if ($null -eq $previousToolchain) {
        Remove-Item Env:\GOTOOLCHAIN -ErrorAction SilentlyContinue
    } else {
        $env:GOTOOLCHAIN = $previousToolchain
    }
    Pop-Location
}
