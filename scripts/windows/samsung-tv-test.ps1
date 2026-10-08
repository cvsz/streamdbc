[CmdletBinding()]
param([int]$Port = 8081)

$baseUrl = "http://127.0.0.1:$Port"
function Require-Status {
    param([string]$Uri, [string]$Name)
    try {
        $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
    } catch {
        $statusCode = $null
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }
        if ($statusCode) {
            throw "$Name returned HTTP $statusCode"
        }
        throw "$Name request failed: $($_.Exception.Message)"
    }
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
# Invoke-WebRequest may return byte array for non-text content types; decode to string
$playlistStr = if ($playlist.Content -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($playlist.Content) } else { $playlist.Content }
$segmentMatches = [regex]::Matches($playlistStr, "(?m)^segment_[0-9]{6,}\.ts\r?$")
if ($segmentMatches.Count -eq 0) { throw "Playlist does not contain an MPEG-TS segment URI." }

# Live HLS uses a sliding window and delete_segments. The oldest entry can be
# removed between fetching the playlist and fetching the segment, so prefer
# the newest advertised segment and refresh/retry briefly on a 404 race.
$segment = $null
$segmentName = $null
for ($attempt = 0; $attempt -lt 4 -and $null -eq $segment; $attempt++) {
    if ($attempt -gt 0) {
        Start-Sleep -Milliseconds 500
        $playlist = Require-Status "$baseUrl/tv/live/index.m3u8" "HLS playlist retry"
        $playlistStr = if ($playlist.Content -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($playlist.Content) } else { $playlist.Content }
        $segmentMatches = [regex]::Matches($playlistStr, "(?m)^segment_[0-9]{6,}\.ts\r?$")
        if ($segmentMatches.Count -eq 0) { continue }
    }

    $segmentName = $segmentMatches[$segmentMatches.Count - 1].Value.Trim()
    try {
        $segment = Invoke-WebRequest -Uri ("$baseUrl/tv/live/{0}" -f $segmentName) -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
    } catch {
        $statusCode = $null
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }
        if ($statusCode -ne 404) { throw }
        $segment = $null
    }
}
if ($null -eq $segment) { throw "HLS segment could not be fetched from the live playlist after retries." }
if ([int]$segment.StatusCode -ne 200) { throw "HLS segment returned HTTP $($segment.StatusCode)" }
Write-Host "PASS HLS segment $segmentName (HTTP $($segment.StatusCode))" -ForegroundColor Green
if ($segment.Headers["Content-Type"] -notmatch "video/mp2t") { throw "Unexpected segment content type: $($segment.Headers['Content-Type'])" }

$initialPlaylist = $playlistStr
$updated = $false
for ($attempt = 0; $attempt -lt 12; $attempt++) {
    Start-Sleep -Seconds 1
    $next = Invoke-WebRequest -Uri "$baseUrl/tv/live/index.m3u8" -UseBasicParsing -TimeoutSec 10
    $nextStr = if ($next.Content -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($next.Content) } else { $next.Content }
    if ($nextStr -ne $initialPlaylist) { $updated = $true; break }
}
if (-not $updated) { throw "HLS playlist did not update within 12 seconds." }
Write-Host "PASS playlist updates" -ForegroundColor Green
Write-Host "Samsung TV HTTP checks passed. This does not replace physical TV playback or soak testing." -ForegroundColor Green
