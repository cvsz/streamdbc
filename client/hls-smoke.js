'use strict';

const http = require('node:http');
const https = require('node:https');

function isLocalHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}

function getText(urlValue, timeoutMs = 3000, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(urlValue); } catch (err) {
      resolve({ statusCode: 0, body: '', error: err.message });
      return;
    }
    const transport = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
    if (!transport) {
      resolve({ statusCode: 0, body: '', error: 'Only HTTP(S) media URLs are supported' });
      return;
    }
    const request = transport.get(url, { headers: { Accept: '*/*', 'User-Agent': 'StreamDBC-HLS-Smoke/1.0' } }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          request.destroy(new Error('HLS response exceeded the size limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        statusCode: response.statusCode || 0,
        body: Buffer.concat(chunks),
        error: ''
      }));
    });
    request.once('error', (err) => resolve({ statusCode: 0, body: Buffer.alloc(0), error: err.message }));
    request.setTimeout(timeoutMs, () => request.destroy(new Error('HLS request timed out')));
  });
}

function parsePlaylist(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const sequenceLine = lines.find((line) => line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) || '';
  const mediaSequence = Number(sequenceLine.slice('#EXT-X-MEDIA-SEQUENCE:'.length));
  const segments = lines.filter((line) => !line.startsWith('#'));
  return { mediaSequence: Number.isFinite(mediaSequence) ? mediaSequence : null, segments };
}

function sameOriginSegmentUrl(value, playlistUrl) {
  let segment;
  try { segment = new URL(value, playlistUrl); } catch { throw new Error('HLS playlist contains an invalid segment URL'); }
  if (segment.origin !== playlistUrl.origin || !segment.pathname.startsWith('/tv/live/') || segment.username || segment.password) {
    throw new Error('HLS segment URL must stay on the configured local /tv/live/ origin');
  }
  return segment;
}

async function runHlsSmokeTest({ baseUrl, request = getText, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), advanceTimeoutMs = 5000 } = {}) {
  let base;
  try { base = new URL(String(baseUrl || '')); } catch { throw new Error('StreamDBC server URL is invalid'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || !isLocalHost(base.hostname)) {
    throw new Error('HLS smoke test requires the local StreamDBC server on a private LAN or loopback address');
  }
  const playlistUrl = new URL('/tv/live/index.m3u8', base);

  const readPlaylist = async () => {
    const response = await request(playlistUrl.toString(), 3000, 1024 * 1024);
    if (response.error) throw new Error(`HLS playlist request failed: ${response.error}`);
    if (response.statusCode !== 200) throw new Error(`HLS playlist returned HTTP ${response.statusCode}`);
    const body = Buffer.isBuffer(response.body) ? response.body.toString('utf8') : String(response.body || '');
    if (!body.startsWith('#EXTM3U')) throw new Error('HLS response is not a valid media playlist');
    const parsed = parsePlaylist(body);
    if (!parsed.segments.length) throw new Error('HLS playlist contains no media segments');
    return { body, ...parsed };
  };

  let playlist = await readPlaylist();
  let segmentUrl = null;
  let segmentResponse = null;
  let segmentName = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    segmentName = playlist.segments[playlist.segments.length - 1];
    segmentUrl = sameOriginSegmentUrl(segmentName, playlistUrl);
    segmentResponse = await request(segmentUrl.toString(), 3000, 8 * 1024 * 1024);
    if (segmentResponse.statusCode === 200 && !segmentResponse.error && (segmentResponse.body?.length || String(segmentResponse.body || '').length)) break;
    if (segmentResponse.statusCode !== 404 || attempt === 2) {
      throw new Error(`Latest HLS segment ${segmentName} returned HTTP ${segmentResponse.statusCode || 0}${segmentResponse.error ? `: ${segmentResponse.error}` : ''}`);
    }
    playlist = await readPlaylist();
  }

  const initialSegment = segmentName;
  const initialSequence = playlist.mediaSequence;
  const deadline = Date.now() + Math.max(0, Math.min(advanceTimeoutMs, 10000));
  let advancedPlaylist = null;
  while (Date.now() < deadline) {
    await wait(Math.min(1000, Math.max(1, deadline - Date.now())));
    const next = await readPlaylist();
    const newest = next.segments[next.segments.length - 1];
    if (newest !== initialSegment || (initialSequence !== null && next.mediaSequence !== null && next.mediaSequence > initialSequence)) {
      advancedPlaylist = next;
      break;
    }
  }
  if (!advancedPlaylist) throw new Error('HLS playlist did not advance within the bounded smoke-test window');

  return {
    ok: true,
    playlistStatus: 200,
    segmentStatus: 200,
    segment: initialSegment,
    mediaSequence: initialSequence,
    nextSegment: advancedPlaylist.segments[advancedPlaylist.segments.length - 1],
    playlistAdvanced: true
  };
}

module.exports = { parsePlaylist, runHlsSmokeTest };
