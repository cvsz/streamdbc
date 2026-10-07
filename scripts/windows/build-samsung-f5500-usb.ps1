[CmdletBinding()]
param(
    [string]$OutputDirectory = "dist\samsung-f5500-usb",
    [string]$SignaturePath = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).ProviderPath
$projectDir = Join-Path $repoRoot "client\samsung-f5500-legacy"

if (-not [System.IO.Path]::IsPathRooted($OutputDirectory)) {
    $OutputDirectory = Join-Path $repoRoot $OutputDirectory
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)

foreach ($required in @("index.html", "config.xml", "widget.info")) {
    $path = Join-Path $projectDir $required
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Missing Samsung Legacy project file: $path"
    }
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

$sourceZip = Join-Path $OutputDirectory "StreamDBC-TV-Legacy-Source.zip"
if (Test-Path -LiteralPath $sourceZip) {
    Remove-Item -LiteralPath $sourceZip -Force
}

$items = @(
    (Join-Path $projectDir "index.html"),
    (Join-Path $projectDir "config.xml"),
    (Join-Path $projectDir "widget.info")
)
Compress-Archive -LiteralPath $items -DestinationPath $sourceZip -CompressionLevel Optimal

Write-Host "Prepared Samsung Legacy source archive:" -ForegroundColor Green
Write-Host "  $sourceZip"
Write-Host ""
Write-Host "IMPORTANT: UA40F5500 is a 2013 Legacy/Orsay TV." -ForegroundColor Yellow
Write-Host "Tizen Studio cannot create its install package."
Write-Host "Import/package this project with Samsung TV SDK for Legacy Platform (SDK 4.5 generation)."
Write-Host ""

if (-not [string]::IsNullOrWhiteSpace($SignaturePath)) {
    $resolvedSig = (Resolve-Path -LiteralPath $SignaturePath).ProviderPath
    $sigName = [System.IO.Path]::GetFileName($resolvedSig)
    Copy-Item -LiteralPath $resolvedSig -Destination (Join-Path $OutputDirectory $sigName) -Force
    Write-Host "Copied supplied TV signature into USB staging root:" -ForegroundColor Green
    Write-Host "  $(Join-Path $OutputDirectory $sigName)"
} else {
    Write-Host "No .sig supplied. USB staging is not installable on the physical TV yet." -ForegroundColor Yellow
    Write-Host "Get the TV DUID from Store > More Apps, then press Fast Forward, 2, 8, 9, 2."
    Write-Host "Request the .sig from Samsung Apps TV Seller Office support."
}

Write-Host ""
Write-Host "Target URL: http://192.168.1.100:8081/tv/" -ForegroundColor Cyan
