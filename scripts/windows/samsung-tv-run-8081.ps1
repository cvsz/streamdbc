[CmdletBinding()] param([int]$Port=8081)
$ErrorActionPreference='Stop'
$repoRoot=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).ProviderPath
$cfg=Join-Path $repoRoot 'configs\samsung-f5500.yaml'

# Point yaml at 8081 (8080 is bound on this PC).
$raw = Get-Content -LiteralPath $cfg -Raw
$raw = $raw -replace 'http_port:\s*8080', ('http_port: {0}' -f $Port)
Set-Content -LiteralPath $cfg -Value $raw -NoNewline

if ($env:STREMDBC_JWT_SECRET.Length -lt 32){ $env:STREMDBC_JWT_SECRET=((New-Guid).Guid+(New-Guid).Guid) }
if ([string]::IsNullOrWhiteSpace($env:STREMDBC_API_KEY)){ $env:STREMDBC_API_KEY=((New-Guid).Guid+(New-Guid).Guid) }

& (Join-Path $PSScriptRoot 'samsung-tv-doctor.ps1') -Port $Port -AllowPortInUse
if ($LASTEXITCODE -ne 0){ throw 'doctor failed' }
& (Join-Path $PSScriptRoot 'samsung-tv-start.ps1') -Port $Port
& (Join-Path $PSScriptRoot 'samsung-tv-test.ps1') -Port $Port
