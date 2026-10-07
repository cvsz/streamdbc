# Shared helpers for the Samsung TV scripts.
# Dot-source this file; it defines functions only and runs nothing on its own.

# Interface aliases that never carry a TV-reachable address. Hyper-V, WSL,
# Docker, VirtualBox and loopback adapters use private RFC1918 space that the
# television cannot route to, so they must not be reported as the LAN address.
$script:SamsungTVVirtualAdapterPattern = "Loopback|WSL|Hyper-V|VirtualBox|VMware|Virtual|Docker|Tailscale|Loopback Pseudo|Teredo"

# Get-SamsungTVLanAddress returns the IPv4 address on the interface most likely
# to be shared with the television. Wi-Fi wins over Ethernet, because a 2013
# Samsung TV can only join the Wi-Fi network. Virtual adapters are excluded, and
# a default gateway is required so an isolated virtual NIC cannot be chosen.
function Get-SamsungTVLanAddress {
    $candidates = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue |
        Where-Object { $_.IPv4Address -and $null -ne $_.NetAdapter } |
        Where-Object { $_.InterfaceAlias -notmatch $script:SamsungTVVirtualAdapterPattern } |
        Where-Object { $null -ne $_.IPv4DefaultGateway })

    if ($candidates.Count -eq 0) { return $null }

    $ranked = $candidates | Sort-Object -Property `
        @{ Expression = { if ($_.NetAdapter.InterfaceDescription -match "Wireless|Wi-Fi|802\.11") { 0 } else { 1 } } }, `
        @{ Expression = { if ($_.InterfaceAlias -match "Wi-Fi|Wireless|WLAN") { 0 } else { 1 } } }

    $best = $ranked | Select-Object -First 1
    return [pscustomobject]@{
        IPAddress      = $best.IPv4Address.IPAddress
        InterfaceAlias = $best.InterfaceAlias
        Description    = $best.NetAdapter.InterfaceDescription
    }
}

# Get-SamsungTVFFmpegPath resolves an FFmpeg executable for the doctor and the
# start script. An explicit path wins; otherwise a StreamDBC-managed build under
# %LOCALAPPDATA% is preferred over whatever happens to be on PATH, because the
# gateway needs dshow plus libx264 and a minimal PATH build often lacks them.
function Get-SamsungTVFFmpegPath {
    param([string]$Requested)

    if (-not [string]::IsNullOrWhiteSpace($Requested) -and
        $Requested -ne "ffmpeg" -and
        (Test-Path -LiteralPath $Requested -PathType Leaf)) {
        return (Resolve-Path -LiteralPath $Requested).Path
    }

    # Installed Control Panel runtime: resources\server-runtime\scripts\windows
    $runtimeRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
    $bundledRuntime = Join-Path $runtimeRoot "ffmpeg\ffmpeg.exe"
    if (Test-Path -LiteralPath $bundledRuntime -PathType Leaf) {
        return (Resolve-Path -LiteralPath $bundledRuntime).Path
    }

    # Repository/local package staging: client\vendor\ffmpeg
    $repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
    $repoBundled = Join-Path $repoRoot "client\vendor\ffmpeg\ffmpeg.exe"
    if (Test-Path -LiteralPath $repoBundled -PathType Leaf) {
        return (Resolve-Path -LiteralPath $repoBundled).Path
    }

    # Backward-compatible managed installation.
    $managedRoot = Join-Path $env:LOCALAPPDATA "StreamDBC\FFmpeg"
    if (Test-Path -LiteralPath $managedRoot -PathType Container) {
        $managed = Get-ChildItem -LiteralPath $managedRoot -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName "ffmpeg.exe" } |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
            Select-Object -First 1
        if ($managed) { return $managed }
    }

    # Final fallback only.
    $onPath = Get-Command -Name "ffmpeg" -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    return $null
}
