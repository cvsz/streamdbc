[CmdletBinding()]
param([int]$Port = 8080)

$baseUrl = "http://127.0.0.1:$Port"
function Require-Status {
    param([string]$Uri, [string]$Name)
    $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 10
    if ([int]$response.StatusCode -ne 200) { throw "$Name returned HTTP $($response.StatusCode)" }
    Write-Host "PASS $Name (HTTP $($response.StatusCode))" -ForegroundColor Green
    return $response
}

$null = Require-Status "$baseUrl/health" "health"
$null = Require-Status "$baseUrl/tv" "TV page"
$null = Require-Status "$baseUrl/tv/basic" "basic TV page"
$status = Require-Status "$baseUrl/api/v1/tv/status" "TV status"
$statusBody = $status.Content | ConvertFrom-Json
if ($statusBody.state -ne "live" -or -not $statusBody.playlist_ready) { throw "TV gateway is not live: $($status.Content)" }

$playlist = Require-Status "$baseUrl/tv/live/index.m3u8" "HLS playlist"
if ($playlist.Headers["Content-Type"] -notmatch "application/vnd.apple.mpegurl") { throw "Unexpected playlist content type: $($playlist.Headers['Content-Type'])" }
$segmentMatch = [regex]::Match($playlist.Content, "(?m)^segment_[0-9]{6,}\.ts$")
if (-not $segmentMatch.Success) { throw "Playlist does not contain an MPEG-TS segment URI." }
$segment = Require-Status ("$baseUrl/tv/live/{0}" -f $segmentMatch.Value) "HLS segment"
if ($segment.Headers["Content-Type"] -notmatch "video/mp2t") { throw "Unexpected segment content type: $($segment.Headers['Content-Type'])" }

$initialPlaylist = $playlist.Content
$updated = $false
for ($attempt = 0; $attempt -lt 12; $attempt++) {
    Start-Sleep -Seconds 1
    $next = Invoke-WebRequest -Uri "$baseUrl/tv/live/index.m3u8" -UseBasicParsing -TimeoutSec 10
    if ($next.Content -ne $initialPlaylist) { $updated = $true; break }
}
if (-not $updated) { throw "HLS playlist did not update within 12 seconds." }
Write-Host "PASS playlist updates" -ForegroundColor Green
Write-Host "Samsung TV HTTP checks passed. This does not replace physical TV playback or soak testing." -ForegroundColor Green
