[CmdletBinding()]
param([int]$Port = 8080)

if ([string]::IsNullOrWhiteSpace($env:STREMDBC_API_KEY)) {
    throw "Set STREMDBC_API_KEY before stopping the authenticated Samsung TV gateway."
}

$headers = @{ "X-API-Key" = $env:STREMDBC_API_KEY }
$uri = "http://127.0.0.1:$Port/api/v1/tv/stop"
try {
    $result = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -ContentType "application/json" -Body "{}" -TimeoutSec 15
    Write-Host "Samsung TV gateway stopped. StreamDBC HTTP management remains available." -ForegroundColor Green
} catch {
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 409) {
        Write-Host "Samsung TV gateway is already stopped." -ForegroundColor Yellow
    } else {
        throw "Could not stop the Samsung TV gateway: $($_.Exception.Message)"
    }
}
