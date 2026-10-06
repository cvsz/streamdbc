[CmdletBinding()]
param(
    [string]$ConfigPath = "configs\samsung-f5500.yaml",
    [string]$Executable = "stremdbc.exe",
    [int]$Port = 8080,
    [switch]$SkipDoctor
)

. (Join-Path $PSScriptRoot "samsung-tv-common.ps1")

# ProviderPath yields a normalised filesystem path; .Path keeps the literal
# ".." segments and the PowerShell provider prefix, which breaks GetFullPath.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).ProviderPath
if (-not [System.IO.Path]::IsPathRooted($ConfigPath)) { $ConfigPath = Join-Path $repoRoot $ConfigPath }
if (-not [System.IO.Path]::IsPathRooted($Executable)) { $Executable = Join-Path $repoRoot $Executable }
$ConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
$Executable = [System.IO.Path]::GetFullPath($Executable)
$baseUrl = "http://127.0.0.1:$Port"
$pidDirectory = Join-Path $env:LOCALAPPDATA "StreamDBC"
$pidFile = Join-Path $pidDirectory "samsung-tv.pid"

if (-not $SkipDoctor) {
    & (Join-Path $PSScriptRoot "samsung-tv-doctor.ps1") -Port $Port -AllowPortInUse
    if ($LASTEXITCODE -ne 0) { throw "Samsung TV doctor failed; fix the reported checks first." }
}

$newProcess = $false
$healthy = $false
try {
    $null = Invoke-RestMethod -Uri "$baseUrl/health" -TimeoutSec 2
    $healthy = $true
} catch { $healthy = $false }

if (-not $healthy) {
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "StreamDBC executable not found: $Executable. Build it with go build -o stremdbc.exe ./cmd/stremdbc" }
    $process = Start-Process -FilePath $Executable -ArgumentList @("-config", ('"{0}"' -f $ConfigPath)) -WorkingDirectory $repoRoot -PassThru
    $newProcess = $true
    New-Item -ItemType Directory -Path $pidDirectory -Force | Out-Null
    Set-Content -LiteralPath $pidFile -Value $process.Id -NoNewline
} else {
    $status = Invoke-RestMethod -Uri "$baseUrl/api/v1/tv/status" -TimeoutSec 5
    if ($status.state -ne "live" -and $status.state -ne "starting") {
        if ([string]::IsNullOrWhiteSpace($env:STREMDBC_API_KEY)) { throw "Set STREMDBC_API_KEY to start the gateway on an existing server." }
        $headers = @{ "X-API-Key" = $env:STREMDBC_API_KEY }
        try {
            $null = Invoke-RestMethod -Uri "$baseUrl/api/v1/tv/start" -Method Post -Headers $headers -ContentType "application/json" -Body "{}" -TimeoutSec 15
        } catch {
            $status = Invoke-RestMethod -Uri "$baseUrl/api/v1/tv/status" -TimeoutSec 5
            if ($status.state -ne "live" -and $status.state -ne "starting") { throw }
        }
    }
}

$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
        $null = Invoke-RestMethod -Uri "$baseUrl/health" -TimeoutSec 2
        $status = Invoke-RestMethod -Uri "$baseUrl/api/v1/tv/status" -TimeoutSec 3
        if ($status.state -eq "live" -and $status.playlist_ready) { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
}
if (-not $ready) {
    $statusText = if ($status) { $status | ConvertTo-Json -Compress } else { "no status response" }
    throw "Samsung TV HLS did not become ready. Status: $statusText. Check vMix and FFmpeg DirectShow devices."
}

$lan = Get-SamsungTVLanAddress
if ($null -eq $lan) { throw "No active LAN IPv4 address found. Connect the PC to the same network as the Samsung TV." }

Write-Host "Samsung TV gateway is live on profile $($status.profile)." -ForegroundColor Green
Write-Host "Open this on Samsung TV:"
Write-Host "http://$($lan.IPAddress):$Port/tv" -ForegroundColor Cyan
Write-Host "Direct HLS fallback:"
Write-Host "http://$($lan.IPAddress):$Port/tv/live/index.m3u8" -ForegroundColor Cyan
if ($newProcess) { Write-Host "Managed StreamDBC PID: $($process.Id) (saved to $pidFile)" }
