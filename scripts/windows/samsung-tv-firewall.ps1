[CmdletBinding()]
param(
    [switch]$Remove,
    [int]$Port = 8080
)

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this helper from an elevated PowerShell window."
}

$ruleName = "StreamDBC Samsung TV"
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($Remove) {
    if ($existing) { $existing | Remove-NetFirewallRule }
    Write-Host "Removed the $ruleName firewall rule (if present)."
    exit 0
}

if ($existing) {
    $existing | Remove-NetFirewallRule
}
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
Write-Host "Added an inbound TCP $Port rule for the Private network profile only."
Write-Host "Removal: .\samsung-tv-firewall.ps1 -Remove"
