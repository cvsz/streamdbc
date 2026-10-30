# Run from any directory in Windows PowerShell as the Windows user who will use vMix.
# One-time firewall setup prompts for UAC; credentials and the task remain with this user.
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 8081,
    [switch]$Offline,
    [switch]$SkipFirewall,
    [switch]$SkipAutostart,
    [switch]$SkipStart,
    [switch]$PlanOnly,
    [switch]$FirewallOnly
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Run this installer on the Windows PC that hosts vMix.' }

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).ProviderPath
$exe = Join-Path $repoRoot 'stremdbc.exe'
$config = Join-Path $repoRoot 'configs\samsung-f5500.yaml'
$runner = Join-Path $PSScriptRoot 'samsung-tv-run-8081.ps1'
$credentialFile = Join-Path $env:LOCALAPPDATA 'StreamDBC\tv-credentials.dat'

function Test-PrivateFirewallRule {
    $rules = @(Get-NetFirewallRule -DisplayName 'StreamDBC Samsung TV' -ErrorAction SilentlyContinue |
        Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' })
    foreach ($rule in $rules) {
        $filter = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule -ErrorAction SilentlyContinue
        if ($rule.Profile.ToString() -eq 'Private' -and $filter.Protocol -eq 'TCP' -and
            @($filter.LocalPort) -contains [string]$Port) { return $true }
    }
    return $false
}

if ($FirewallOnly) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Firewall setup requires Administrator.' }
    if (-not (Test-PrivateFirewallRule)) {
        New-NetFirewallRule -Name "StreamDBC-SamsungTV-$Port" -DisplayName 'StreamDBC Samsung TV' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
    }
    Write-Host "Private-profile inbound TCP $Port is allowed." -ForegroundColor Green
    return
}

function Refresh-ExecutablePath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $links = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'
    $env:Path = "${machine};${user};$links;$env:Path"
}

function Get-FFmpeg {
    Refresh-ExecutablePath
    $command = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    return $null
}

function Get-Go {
    Refresh-ExecutablePath
    $command = Get-Command go.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    foreach ($candidate in @((Join-Path $env:ProgramFiles 'Go\bin\go.exe'), (Join-Path $env:LOCALAPPDATA 'Programs\Go\bin\go.exe'))) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

function Install-WinGetPackage {
    param([string]$Id)
    if ($Offline) { throw "$Id is missing; install it manually or rerun without -Offline." }
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) { throw "Missing $Id and WinGet is unavailable. Install it manually and rerun." }
    Write-Host "Installing $Id through WinGet (you may see a Windows installer prompt)..." -ForegroundColor Cyan
    & $winget.Source install --exact --id $Id --source winget --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { throw "WinGet could not install $Id (exit code $LASTEXITCODE)." }
    Refresh-ExecutablePath
}

function Test-LocalPort {
    $tcp = New-Object System.Net.Sockets.TcpClient
    try {
        $tcp.Connect('127.0.0.1', $Port)
        return $true
    } catch { return $false }
    finally { $tcp.Close() }
}

if (-not (Test-Path -LiteralPath $config -PathType Leaf) -or -not (Test-Path -LiteralPath $runner -PathType Leaf)) {
    throw "Copy the complete streamdbc folder to this PC first; the config or runner is missing under $repoRoot."
}
$running = $null
try { $running = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/tv/status" -TimeoutSec 2 } catch {}
if ($null -ne $running) {
    if ($running.enabled -ne $true -or $running.profile -notlike 'f5500_*') {
        throw "Port $Port is occupied by a different service. Choose another -Port."
    }
} elseif (Test-LocalPort) {
    throw "Port $Port is in use by another service. Choose another -Port."
}

$ffmpeg = Get-FFmpeg
$go = if (Test-Path -LiteralPath $exe -PathType Leaf) { $null } else { Get-Go }
$needsBuild = -not (Test-Path -LiteralPath $exe -PathType Leaf)
if (-not $needsBuild) {
    try {
        $version = & $exe -version 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0 -or $version -notmatch 'STREMDBC') { $needsBuild = $true }
    } catch { $needsBuild = $true }
}
if ($needsBuild -and -not $go) { $go = Get-Go }

if ($PlanOnly) {
    Write-Host "Repository: $repoRoot"
    Write-Host "Port: $Port; FFmpeg: $(if ($ffmpeg) { $ffmpeg } else { 'missing (WinGet: Gyan.FFmpeg)' })"
    Write-Host "Binary: $(if ($needsBuild) { 'build required (Go 1.27+)' } else { $exe })"
    Write-Host "Go: $(if ($go) { $go } else { 'missing if build is required (WinGet: GoLang.Go)' })"
    Write-Host "Firewall: $(if (Test-PrivateFirewallRule) { 'ready' } else { 'Private rule required' })"
    Write-Host "vMix: $(if (Get-Process -Name 'vMix64', 'vMix' -ErrorAction SilentlyContinue) { 'running' } else { 'not running; install/start vMix manually' })"
    return
}

if (-not $ffmpeg) {
    Install-WinGetPackage 'Gyan.FFmpeg'
    $ffmpeg = Get-FFmpeg
    if (-not $ffmpeg) { throw 'FFmpeg was installed but not found. Reopen PowerShell and rerun the installer.' }
}
$encoders = & $ffmpeg -hide_banner -encoders | Out-String
$devices = & $ffmpeg -hide_banner -devices | Out-String
if ($encoders -notmatch '\blibx264\b' -or $devices -notmatch '\bdshow\b') {
    throw "FFmpeg at $ffmpeg lacks libx264 or DirectShow. Install a Windows full build (Gyan.FFmpeg) and rerun."
}
Write-Host "FFmpeg ready: $ffmpeg" -ForegroundColor Green

if ($needsBuild) {
    if (-not $go) {
        Install-WinGetPackage 'GoLang.Go'
        $go = Get-Go
        if (-not $go) { throw 'Go was installed but not found. Reopen PowerShell and rerun the installer.' }
    }
    $goVersion = & $go version | Out-String
    if ($goVersion -notmatch '\bgo(\d+)\.(\d+)') { throw "Cannot determine Go version from $goVersion" }
    if ([int]$Matches[1] -lt 1 -or ([int]$Matches[1] -eq 1 -and [int]$Matches[2] -lt 27)) {
        throw "Go 1.27+ is required (found $goVersion). Upgrade Go and rerun."
    }
    if ($Offline) {
        $env:GOTOOLCHAIN = 'local'
        $env:GOPROXY = 'off'
    }
    Write-Host 'Building stremdbc.exe for this Windows PC...' -ForegroundColor Cyan
    Push-Location $repoRoot
    try {
        & $go build -o $exe ./cmd/stremdbc
        if ($LASTEXITCODE -ne 0) { throw "Go build failed (exit code $LASTEXITCODE)." }
    } finally { Pop-Location }
}
Write-Host "StreamDBC ready: $exe" -ForegroundColor Green

$stored = $null
if (Test-Path -LiteralPath $credentialFile -PathType Leaf) {
    $encrypted = @(Get-Content -LiteralPath $credentialFile)
    if ($encrypted.Count -ne 2) { throw "Invalid $credentialFile; fix it before installing." }
    $stored = @(
        ([System.Management.Automation.PSCredential]::new('tv', (ConvertTo-SecureString $encrypted[0]))).GetNetworkCredential().Password,
        ([System.Management.Automation.PSCredential]::new('tv', (ConvertTo-SecureString $encrypted[1]))).GetNetworkCredential().Password
    )
}
$hasSecret = -not [string]::IsNullOrWhiteSpace($env:STREMDBC_JWT_SECRET)
$hasKey = -not [string]::IsNullOrWhiteSpace($env:STREMDBC_API_KEY)
if ($hasSecret -xor $hasKey) { throw 'Set both STREMDBC_JWT_SECRET and STREMDBC_API_KEY together, or neither.' }
if ($hasSecret -and $stored -and ($stored[0] -cne $env:STREMDBC_JWT_SECRET -or $stored[1] -cne $env:STREMDBC_API_KEY)) {
    throw 'Session credentials differ from the saved credentials. Use the original keys; do not rotate a running gateway implicitly.'
}
if (-not $hasSecret -and $stored) {
    $env:STREMDBC_JWT_SECRET = $stored[0]
    $env:STREMDBC_API_KEY = $stored[1]
} elseif (-not $hasSecret -and $null -eq $running) {
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $bytes = New-Object byte[] 48
        $rng.GetBytes($bytes)
        $env:STREMDBC_JWT_SECRET = [Convert]::ToBase64String($bytes)
        $rng.GetBytes($bytes)
        $env:STREMDBC_API_KEY = [Convert]::ToBase64String($bytes)
    } finally { $rng.Dispose() }
    Write-Host 'Generated new credentials for this Windows user (not printed).' -ForegroundColor Green
} elseif (-not $hasSecret) {
    throw 'A gateway is already running. Supply its existing STREMDBC_JWT_SECRET and STREMDBC_API_KEY; no new keys were generated.'
}
if ($env:STREMDBC_JWT_SECRET.Length -lt 32 -or $env:STREMDBC_API_KEY.Length -lt 16) { throw 'JWT secret must be 32+ characters and API key 16+ characters.' }

# Save encrypted credentials even when autostart is disabled, so the GUI can
# control the gateway in a later logon. Do not use setx or print the keys.
$credentialDirectory = Split-Path -Parent $credentialFile
[IO.Directory]::CreateDirectory($credentialDirectory) | Out-Null
$secretCipher = ConvertFrom-SecureString (ConvertTo-SecureString $env:STREMDBC_JWT_SECRET -AsPlainText -Force)
$keyCipher = ConvertFrom-SecureString (ConvertTo-SecureString $env:STREMDBC_API_KEY -AsPlainText -Force)
[IO.File]::WriteAllLines($credentialFile, [string[]]@($secretCipher, $keyCipher))

if (-not $SkipFirewall -and -not (Test-PrivateFirewallRule)) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        & $PSCommandPath -Port $Port -FirewallOnly
    } else {
        Write-Host "Requesting Administrator approval for Private TCP $Port firewall rule..." -ForegroundColor Cyan
        $ps = Join-Path $PSHOME 'powershell.exe'
        $args = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Port {1} -FirewallOnly' -f $PSCommandPath, $Port
        $elevated = Start-Process -FilePath $ps -Verb RunAs -ArgumentList $args -Wait -PassThru
        if ($elevated.ExitCode -ne 0 -or -not (Test-PrivateFirewallRule)) { throw "Firewall setup failed. From Administrator PowerShell run: .\scripts\windows\samsung-tv-setup.ps1 -Port $Port -FirewallOnly" }
    }
}

if (-not $SkipAutostart) {
    & (Join-Path $PSScriptRoot 'samsung-tv-install-autostart.ps1') -Port $Port
    Write-Host 'Autostart registered for this user at logon (+60 seconds).' -ForegroundColor Green
}

$privateNetwork = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Private' })
if ($privateNetwork.Count -eq 0) { Write-Warning 'No Private network profile detected. On a trusted LAN set the PC network to Private; the firewall rule will not apply to Public networks.' }
if (-not (Get-Process -Name 'vMix64', 'vMix' -ErrorAction SilentlyContinue)) {
    Write-Warning 'vMix is not running. Install/licence vMix, enable External Output 1 (vMix Video/Audio) before expecting live HLS; vMix cannot be installed automatically here.'
}
if (-not $SkipStart) {
    & $runner -Port $Port -NoGui
    Write-Host 'Open the TV URL printed above; the TV must be on the same LAN.' -ForegroundColor Green
}
Write-Host "Control panel: powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File `"$runner`" -Port $Port"
