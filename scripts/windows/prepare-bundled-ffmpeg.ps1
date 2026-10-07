[CmdletBinding()]
param(
    [string]$Destination = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..\..\client")).ProviderPath "vendor\ffmpeg")
)

$ErrorActionPreference = "Stop"
$tag = "autobuild-2026-10-05-13-07"
$asset = "ffmpeg-n9.0.2-22-g46d8f462ee-win64-gpl-9.0.zip"
$sha256 = "1385d57bd30c009fca25655f056680317dc9db3724cf082443bf8830223877cf"
$url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$tag/$asset"

$ffmpegExe = Join-Path $Destination "ffmpeg.exe"
$ffprobeExe = Join-Path $Destination "ffprobe.exe"
if ((Test-Path $ffmpegExe -PathType Leaf) -and (Test-Path $ffprobeExe -PathType Leaf)) {
    Write-Host "Bundled FFmpeg already staged: $Destination" -ForegroundColor Green
    exit 0
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("streamdbc-ffmpeg-" + [guid]::NewGuid().ToString("N"))
$zip = Join-Path $tempRoot $asset
$extract = Join-Path $tempRoot "extract"
New-Item -ItemType Directory -Path $tempRoot,$extract,$Destination -Force | Out-Null

try {
    Write-Host "Downloading verified FFmpeg x64 GPL build..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
    if ($actual -ne $sha256) { throw "FFmpeg SHA256 mismatch: $actual" }

    Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
    $foundFFmpeg = Get-ChildItem -Path $extract -Filter ffmpeg.exe -Recurse -File | Select-Object -First 1
    $foundFFprobe = Get-ChildItem -Path $extract -Filter ffprobe.exe -Recurse -File | Select-Object -First 1
    if (-not $foundFFmpeg -or -not $foundFFprobe) { throw "FFmpeg archive missing ffmpeg.exe or ffprobe.exe" }

    Copy-Item $foundFFmpeg.FullName $ffmpegExe -Force
    Copy-Item $foundFFprobe.FullName $ffprobeExe -Force

    $version = (& $ffmpegExe -version 2>&1 | Select-Object -First 1 | Out-String).Trim()
    $encoders = (& $ffmpegExe -hide_banner -encoders 2>&1 | Out-String)
    $muxers = (& $ffmpegExe -hide_banner -muxers 2>&1 | Out-String)
    $protocols = (& $ffmpegExe -hide_banner -protocols 2>&1 | Out-String)
    foreach ($required in @("libx264","aac")) {
        if ($encoders -notmatch [regex]::Escape($required)) { throw "Required encoder missing: $required" }
    }
    if ($muxers -notmatch "(?m)\s+hls\s") { throw "Required HLS muxer missing" }
    if ($protocols -notmatch "(?m)^\s*rtmp\s*$") { throw "Required RTMP protocol missing" }

    Set-Content -LiteralPath (Join-Path $Destination "VERSION.txt") -Value $version -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $Destination "SOURCE.txt") -Value @(
        "Source: BtbN/FFmpeg-Builds"
        "Release: $tag"
        "Asset: $asset"
        "SHA256: $sha256"
        "License/build flavor: GPL"
    ) -Encoding UTF8
    Write-Host "FFmpeg ready: $version" -ForegroundColor Green
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
