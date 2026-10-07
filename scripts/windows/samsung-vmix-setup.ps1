[CmdletBinding()]
param(
    [string]$VmixApiUrl = "http://127.0.0.1:8088/api/",
    [string]$ProgramInput = "1",
    [int]$TransitionMs = 500,
    [int]$MasterVolume = 100,
    [int]$StreamDbcPort = 8080
)

# Applies the Samsung F5500 vMix settings that the vMix API supports, then
# verifies them by re-reading vMix state. Only function names from the
# official Shortcut Function Reference are used:
#   https://www.vmix.com/help28/ShortcutFunctionReference.html
# The API cannot select the External Output device, frame rate, or output
# size, and it cannot open presets; those stay manual (see Reminders below).

. (Join-Path $PSScriptRoot "samsung-tv-common.ps1")

$ErrorActionPreference = "Stop"

function Step-Ok([string]$Name, [string]$Detail) {
    Write-Host ("PASS {0}: {1}" -f $Name, $Detail) -ForegroundColor Green
}

function Step-Fail([string]$Name, [string]$Detail) {
    Write-Host ("FAIL {0}: {1}" -f $Name, $Detail) -ForegroundColor Red
}

function Invoke-VmixFunction([string]$Function, [hashtable]$Extra = @{}) {
    $uri = $script:VmixApiUrl.TrimEnd("/") + "/?Function=" + $Function
    foreach ($entry in $Extra.GetEnumerator()) {
        $uri += "&" + $entry.Key + "=" + [uri]::EscapeDataString([string]$entry.Value)
    }
    try {
        $null = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 10
    } catch {
        throw ("vMix API Function={0} failed: {1}" -f $Function, $_.Exception.Message)
    }
}

function Get-VmixState {
    try {
        [xml]$state = (Invoke-WebRequest -Uri $script:VmixApiUrl.TrimEnd("/") -UseBasicParsing -TimeoutSec 10).Content
    } catch {
        throw ("vMix API is unreachable at {0}. In vMix open Settings, Web, enable the web interface (default port 8088), then rerun this script. Detail: {1}" -f $script:VmixApiUrl, $_.Exception.Message)
    }
    return $state
}

$vmixProcess = Get-Process -Name "vmix64", "vmix" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $vmixProcess) {
    Step-Fail "vMix running" "Start vMix and open docs\streamdbc.vmix (or your show preset) first."
    exit 1
}
Step-Ok "vMix running" ("{0} (PID {1})" -f $vmixProcess.ProcessName, $vmixProcess.Id)

$state = Get-VmixState
$version = ""
if ($state.vmix.version) { $version = $state.vmix.version }
Step-Ok "vMix API" ("reachable; vMix {0}" -f $version)

$inputs = @($state.vmix.inputs.input | Where-Object { $_ -ne $null })
if ($inputs.Count -eq 0) {
    Step-Fail "Program input" "vMix has no inputs; open docs\streamdbc.vmix or add your camera input first."
    exit 1
}
$program = $inputs | Where-Object { $_.number -eq $ProgramInput -or $_.title -eq $ProgramInput } | Select-Object -First 1
if ($null -eq $program) {
    $titles = ($inputs | ForEach-Object { "{0}:{1}" -f $_.number, $_.title }) -join ", "
    Step-Fail "Program input" ("input '{0}' not found. Available: {1}" -f $ProgramInput, $titles)
    exit 1
}
Step-Ok "Program input" ("{0}:{1}" -f $program.number, $program.title)

Invoke-VmixFunction "SetTransitionEffect1" @{ Value = "Fade" }
Invoke-VmixFunction "SetTransitionDuration1" @{ Value = [string]$TransitionMs }
Step-Ok "Transition 1" ("Fade {0} ms" -f $TransitionMs)

Invoke-VmixFunction "PreviewInput" @{ Input = $program.number }
Invoke-VmixFunction "ActiveInput" @{ Input = $program.number }
Step-Ok "Preview/Program" ("input {0} on preview and program" -f $program.number)

Invoke-VmixFunction "MasterAudioOn" @{}
Invoke-VmixFunction "SetMasterVolume" @{ Value = [string]$MasterVolume }
Step-Ok "Master audio" ("on, volume {0}" -f $MasterVolume)

Invoke-VmixFunction "StartExternal" @{}
Start-Sleep -Seconds 2
$state = Get-VmixState
if ($state.vmix.external -ne "True") {
    Step-Fail "External output" "vMix did not report external=True. Open External cog, Settings, set Output 1 to 'vMix Video / Streaming', then rerun this script."
    exit 1
}
Step-Ok "External output" "running (vMix reports external=True)"

Write-Host ""
Write-Host "Reminders that the vMix API cannot apply (manual, one time):" -ForegroundColor Yellow
Write-Host "  1. External cog, Settings: Output 1 device 'vMix Video / Streaming'."
Write-Host "  2. External frame rate = master frame rate; output size at least 1280x720."
Write-Host "  3. Keep this script's External output running while StreamDBC captures it."

$lan = Get-SamsungTVLanAddress
if ($null -ne $lan) {
    Write-Host ""
    Write-Host "Open this on the Samsung TV:" -ForegroundColor Cyan
    Write-Host ("  http://{0}:{1}/tv" -f $lan.IPAddress, $StreamDbcPort)
    Write-Host "Direct HLS fallback:" -ForegroundColor Cyan
    Write-Host ("  http://{0}:{1}/tv/live/index.m3u8" -f $lan.IPAddress, $StreamDbcPort)
}
