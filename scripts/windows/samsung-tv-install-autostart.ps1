[CmdletBinding()] param(
  [int]$Port = 8081,
  [string]$TaskName = "StreamDBC Samsung TV"
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).ProviderPath
$runScript = Join-Path $PSScriptRoot 'samsung-tv-run-8081.ps1'

# Persist current session creds to user env so autostart survives reboot.
if ($env:STREMDBC_JWT_SECRET.Length -lt 32) { throw 'Set $env:STREMDBC_JWT_SECRET first (32+ chars).' }
if ([string]::IsNullOrWhiteSpace($env:STREMDBC_API_KEY)) { throw 'Set $env:STREMDBC_API_KEY first.' }
setx STREMDBC_JWT_SECRET $env:STREMDBC_JWT_SECRET | Out-Null
setx STREMDBC_API_KEY $env:STREMDBC_API_KEY | Out-Null

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $runScript) -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = 'PT60S'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Start StreamDBC Samsung F5500 HLS on port $Port after logon." -Force | Out-Null
Write-Host "Autostart installed: $TaskName (logon + 60s, port $Port)." -ForegroundColor Green
Write-Host "Ensure vMix opens at logon and External Output is started; StreamDBC cannot press vMix External by itself."
Write-Host "Remove: Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
