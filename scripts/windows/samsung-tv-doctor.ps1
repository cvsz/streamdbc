[CmdletBinding()]
param(
    [int]$Port = 8080,
    [string]$FFmpegPath = "ffmpeg",
    [string]$OutputPath = (Join-Path $env:LOCALAPPDATA "StreamDBC\SamsungTV"),
    [switch]$AllowPortInUse
)

$script:Failures = 0

function Report-Check {
    param([bool]$Passed, [string]$Name, [string]$Detail)
    if ($Passed) {
        Write-Host ("PASS {0}: {1}" -f $Name, $Detail) -ForegroundColor Green
    } else {
        Write-Host ("FAIL {0}: {1}" -f $Name, $Detail) -ForegroundColor Red
        $script:Failures++
    }
}

Report-Check ($env:OS -eq "Windows_NT") "Windows" ([System.Environment]::OSVersion.VersionString)

. (Join-Path $PSScriptRoot "samsung-tv-common.ps1")

$lanAddress = Get-SamsungTVLanAddress
Report-Check ($null -ne $lanAddress) "LAN IPv4" $(if ($lanAddress) { "{0} on {1}" -f $lanAddress.IPAddress, $lanAddress.InterfaceAlias } else { "No active LAN IPv4 address found" })
Report-Check ($null -ne $lanAddress) "Wi-Fi interface" $(if ($lanAddress) { "{0} ({1})" -f $lanAddress.InterfaceAlias, $lanAddress.Description } else { "Connect the PC to Wi-Fi or Ethernet on the TV LAN" })

$networkProfile = Get-NetConnectionProfile -ErrorAction SilentlyContinue |
    Where-Object { $_.InterfaceAlias -eq $lanAddress.InterfaceAlias } | Select-Object -First 1
Report-Check ($null -ne $networkProfile -and $networkProfile.NetworkCategory -eq "Private") "Private network" $(if ($networkProfile) { $networkProfile.NetworkCategory } else { "Set the active LAN connection to Private" })

$ffmpegSource = Get-SamsungTVFFmpegPath -Requested $FFmpegPath
Report-Check ($null -ne $ffmpegSource) "FFmpeg" $(if ($ffmpegSource) { $ffmpegSource } else { "Install FFmpeg with DirectShow and libx264, or pass -FFmpegPath" })
$deviceOutput = ""
if ($ffmpegSource) {
    $deviceOutput = (& $ffmpegSource -hide_banner -list_devices true -f dshow -i dummy 2>&1 | Out-String)
}
$vmixProcess = Get-Process -Name "vmix64", "vmix" -ErrorAction SilentlyContinue | Select-Object -First 1
Report-Check ($null -ne $vmixProcess) "vMix running" $(if ($vmixProcess) { $vmixProcess.ProcessName } else { "Start vMix and enable External Output" })
Report-Check ($deviceOutput -match "(?i)vMix Video") "vMix Video" $(if ($deviceOutput -match "(?i)vMix Video") { "DirectShow capture device detected" } else { "Not found; detected DirectShow devices:`n$deviceOutput" })
Report-Check ($deviceOutput -match "(?i)vMix Audio") "vMix Audio" $(if ($deviceOutput -match "(?i)vMix Audio") { "DirectShow capture device detected" } else { "Not found; detected DirectShow devices:`n$deviceOutput" })

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$portPassed = ($null -eq $listener) -or $AllowPortInUse
$portDetail = if ($listener) { "TCP $Port is already listening" } else { "TCP $Port is available" }
Report-Check $portPassed "TCP $Port" $(if (-not $portPassed) { "$portDetail; stop the other listener or pass -AllowPortInUse" } else { $portDetail })

$privateFirewall = Get-NetFirewallProfile -Profile Private -ErrorAction SilentlyContinue
$rulePassed = $false
if ($privateFirewall -and $privateFirewall.Enabled -eq $false) {
    $rulePassed = $true
    $firewallDetail = "Private firewall profile is disabled by the operator"
} else {
    $rules = @(Get-NetFirewallRule -DisplayName "StreamDBC Samsung TV" -ErrorAction SilentlyContinue |
        Where-Object { $_.Enabled -eq "True" -and $_.Direction -eq "Inbound" -and $_.Action -eq "Allow" })
    foreach ($rule in $rules) {
        $profileOK = $rule.Profile.ToString() -eq "Private"
        $ports = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule -ErrorAction SilentlyContinue
        if ($profileOK -and $ports.Protocol -eq "TCP" -and ($ports.LocalPort -contains [string]$Port)) { $rulePassed = $true }
    }
    $firewallDetail = if ($rulePassed) { "Scoped inbound TCP $Port rule exists for Private" } else { "Run samsung-tv-firewall.ps1 as Administrator to add the Private-only TCP $Port rule" }
}
Report-Check $rulePassed "Firewall accessibility" $firewallDetail

$secretReady = ($env:STREMDBC_JWT_SECRET.Length -ge 32) -and -not [string]::IsNullOrWhiteSpace($env:STREMDBC_API_KEY)
Report-Check $secretReady "Management credentials" $(if ($secretReady) { "JWT secret and API key are present" } else { "Set STREMDBC_JWT_SECRET (32+ characters) and STREMDBC_API_KEY" })

try {
    New-Item -ItemType Directory -Path $OutputPath -Force -ErrorAction Stop | Out-Null
    $probe = Join-Path $OutputPath (".doctor-{0}.tmp" -f [guid]::NewGuid().ToString("N"))
    [System.IO.File]::WriteAllText($probe, "ok")
    [System.IO.File]::Delete($probe)
    Report-Check $true "HLS output" "$OutputPath is writable"
} catch {
    Report-Check $false "HLS output" ("Cannot write {0}: {1}" -f $OutputPath, $_.Exception.Message)
}

if ($script:Failures -gt 0) {
    Write-Host ("Doctor found {0} failed check(s)." -f $script:Failures) -ForegroundColor Red
    exit 1
}
Write-Host "All Samsung TV prerequisites passed." -ForegroundColor Green
exit 0
