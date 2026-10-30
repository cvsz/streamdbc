[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 8081,
    [string]$TaskName = 'StreamDBC Samsung TV'
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).ProviderPath
$runScript = Join-Path $PSScriptRoot 'samsung-tv-run-8081.ps1'

if ($env:STREMDBC_JWT_SECRET.Length -lt 32) { throw 'Set STREMDBC_JWT_SECRET (32+ characters) in this session first.' }
if ([string]::IsNullOrWhiteSpace($env:STREMDBC_API_KEY)) { throw 'Set STREMDBC_API_KEY in this session first.' }

# DPAPI encrypts these values for this Windows user; do not write secrets into
# the task command line or persist them as plaintext user environment variables.
$directory = Join-Path $env:LOCALAPPDATA 'StreamDBC'
$credentialsFile = Join-Path $directory 'tv-credentials.dat'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$secret = ConvertFrom-SecureString (ConvertTo-SecureString $env:STREMDBC_JWT_SECRET -AsPlainText -Force)
$key = ConvertFrom-SecureString (ConvertTo-SecureString $env:STREMDBC_API_KEY -AsPlainText -Force)
[IO.File]::WriteAllLines($credentialsFile, [string[]]@($secret, $key))

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -STA -ExecutionPolicy Bypass -File "{0}" -Port {1} -NoGui' -f $runScript, $Port) -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = 'PT60S'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Start StreamDBC Samsung F5500 HLS on port $Port after logon." -Force | Out-Null
Write-Host "Autostart installed: $TaskName (same Windows user, logon + 60s, port $Port)." -ForegroundColor Green
Write-Host 'vMix must be running with External Output enabled for video.'
Write-Host "Remove task: Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
