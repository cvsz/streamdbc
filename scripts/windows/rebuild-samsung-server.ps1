[CmdletBinding()]
param(
    [switch]$SkipTests,
    [switch]$Start,
    [switch]$ConfigureFirewall,
    [int]$Port = 8081
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).ProviderPath
Push-Location $repoRoot
try {
    Write-Host "== StreamDBC Samsung server rebuild ==" -ForegroundColor Cyan

    $go = Get-Command go -ErrorAction SilentlyContinue
    if (-not $go) { throw "Go is not installed or not on PATH." }

    Write-Host "Preparing verified bundled FFmpeg x64..." -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot "prepare-bundled-ffmpeg.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Bundled FFmpeg preparation failed." }
    . (Join-Path $PSScriptRoot "samsung-tv-common.ps1")
    $resolvedFFmpeg = Get-SamsungTVFFmpegPath -Requested "ffmpeg"
    if (-not $resolvedFFmpeg) { throw "FFmpeg could not be resolved after preparation." }
    $env:STREMDBC_FFMPEG_PATH = $resolvedFFmpeg

    if (-not $SkipTests) {
        Write-Host "Running Go tests..." -ForegroundColor Cyan
        & go test ./...
        if ($LASTEXITCODE -ne 0) { throw "go test ./... failed." }

        Write-Host "Running go vet..." -ForegroundColor Cyan
        & go vet ./...
        if ($LASTEXITCODE -ne 0) { throw "go vet ./... failed." }
    }

    $exe = Join-Path $repoRoot "stremdbc.exe"
    if (Test-Path -LiteralPath $exe) {
        Remove-Item -LiteralPath $exe -Force
    }

    Write-Host "Building stremdbc.exe..." -ForegroundColor Cyan
    & go build -trimpath -ldflags="-s -w" -o $exe ./cmd/stremdbc
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $exe)) {
        throw "Windows server build failed."
    }

    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash
    Write-Host "Built: $exe" -ForegroundColor Green
    Write-Host "SHA256: $hash" -ForegroundColor Green

    if ($ConfigureFirewall) {
        Write-Host "Configuring Private-profile firewall rule on TCP $Port..." -ForegroundColor Cyan
        & (Join-Path $PSScriptRoot "samsung-tv-firewall.ps1") -Port $Port
        if ($LASTEXITCODE -ne 0) { throw "Firewall configuration failed." }
    }

    if ($Start) {
        if ([string]::IsNullOrWhiteSpace($env:STREMDBC_JWT_SECRET)) {
            $env:STREMDBC_JWT_SECRET = ((New-Guid).Guid + (New-Guid).Guid)
            Write-Host "Generated session-only STREMDBC_JWT_SECRET." -ForegroundColor Yellow
        }
        if ([string]::IsNullOrWhiteSpace($env:STREMDBC_API_KEY)) {
            $env:STREMDBC_API_KEY = ((New-Guid).Guid + (New-Guid).Guid)
            Write-Host "Generated session-only STREMDBC_API_KEY." -ForegroundColor Yellow
        }

        & (Join-Path $PSScriptRoot "samsung-tv-start.ps1") -Port $Port
        if ($LASTEXITCODE -ne 0) { throw "Samsung TV gateway start failed." }

        & (Join-Path $PSScriptRoot "samsung-tv-test.ps1") -Port $Port
        if ($LASTEXITCODE -ne 0) { throw "Samsung TV smoke test failed." }
    }

    Write-Host ""
    Write-Host "Server URL: http://ztv.zeaz.dev:$Port/tv/" -ForegroundColor Cyan
    Write-Host "LAN fallback: http://192.168.1.100:$Port/tv/" -ForegroundColor DarkCyan
    Write-Host "Health:     http://ztv.zeaz.dev:$Port/health" -ForegroundColor Cyan
} finally {
    Pop-Location
}
