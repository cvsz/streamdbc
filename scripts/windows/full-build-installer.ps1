[CmdletBinding()]
param(
    [switch]$SkipTests,
    [switch]$NoClean
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ClientDir = Join-Path $RepoRoot 'client'
$DistDir = Join-Path $ClientDir 'dist'

function Assert-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found in PATH: $Name"
    }
}

function Invoke-Step([string]$Name, [scriptblock]$Action) {
    Write-Host ""
    Write-Host "=== $Name ===" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
}

Assert-Command node
Assert-Command npm
Assert-Command go

if (-not $NoClean -and (Test-Path $DistDir)) {
    Remove-Item $DistDir -Recurse -Force
}

Push-Location $ClientDir
try {
    # electron-builder's optional proxy-support chain includes sprintf-js.
    # Upstream has no fixed release for CVE-2026-97058, so package.json pins a
    # local bounded-precision fork and build:win runs its precision guard.
    Invoke-Step 'Install locked Node dependencies' { npm ci }

    if (-not $SkipTests) {
        Push-Location $RepoRoot
        try {
            Invoke-Step 'Go unit tests' { go test ./... }
        }
        finally {
            Pop-Location
        }

        Invoke-Step 'NPM security audit' { npm audit --audit-level=moderate }
        Invoke-Step 'JavaScript syntax checks' {
            node --check main.js
            node --check preload.js
            node --check samsung-fleet.js
            node --check renderer.js
            node --check player.js
            node --check scripts/generate-windows-icon.js
            node --check scripts/prepare-server-runtime.js
            node --check scripts/vendor-hls.js
        }
    }

    Invoke-Step 'Build NSIS installer and portable application' { npm run build:win }

    $Required = @(
        (Join-Path $ClientDir 'assets\apps.ico'),
        (Join-Path $ClientDir 'server-runtime\stremdbc.exe'),
        (Join-Path $ClientDir 'server-runtime\ffmpeg\ffmpeg.exe'),
        (Join-Path $ClientDir 'server-runtime\ffmpeg\ffprobe.exe'),
        (Join-Path $ClientDir 'server-runtime\configs\samsung-f5500.yaml')
    )
    foreach ($Path in $Required) {
        if (-not (Test-Path $Path)) {
            throw "Required build output missing: $Path"
        }
    }

    $Installers = @(Get-ChildItem $DistDir -File -Filter '*.exe' | Sort-Object Name)
    if ($Installers.Count -lt 2) {
        throw "Expected NSIS + portable EXE artifacts, found $($Installers.Count)"
    }

    $Package = Get-Content (Join-Path $ClientDir 'package.json') -Raw | ConvertFrom-Json
    $Commit = ''
    try {
        $Commit = (& git -C $RepoRoot rev-parse HEAD 2>$null).Trim()
    } catch {}

    $Artifacts = foreach ($File in $Installers) {
        $Hash = Get-FileHash $File.FullName -Algorithm SHA256
        [pscustomobject]@{
            file   = $File.Name
            bytes  = $File.Length
            sha256 = $Hash.Hash.ToLowerInvariant()
        }
    }

    $Manifest = [ordered]@{
        product    = 'StreamDBC Control Panel'
        version    = $Package.version
        built_at   = (Get-Date).ToUniversalTime().ToString('o')
        git_commit = $Commit
        artifacts  = @($Artifacts)
    }

    $ManifestPath = Join-Path $DistDir 'build-manifest.json'
    $Manifest | ConvertTo-Json -Depth 6 | Set-Content $ManifestPath -Encoding UTF8

    $SumsPath = Join-Path $DistDir 'SHA256SUMS.txt'
    @($Artifacts | ForEach-Object { "$($_.sha256)  $($_.file)" }) |
        Set-Content $SumsPath -Encoding ascii

    Write-Host ""
    Write-Host '=== BUILD COMPLETE ===' -ForegroundColor Green
    Write-Host "Output: $DistDir"
    $Artifacts | Format-Table -AutoSize
    Write-Host "Manifest: $ManifestPath"
    Write-Host "Checksums: $SumsPath"
}
finally {
    Pop-Location
}
