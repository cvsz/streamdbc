'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runHlsSmokeTest } = require('../hls-smoke');

function playlist(sequence, segment) {
  return `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXTINF:2,\n${segment}\n`;
}

test('HLS smoke test fetches the newest segment and confirms playlist advancement', async () => {
  let playlistReads = 0;
  const requests = [];
  const result = await runHlsSmokeTest({
    baseUrl: 'http://127.0.0.1:8081',
    wait: async () => {},
    request: async (url) => {
      requests.push(url);
      if (url.endsWith('.m3u8')) {
        playlistReads += 1;
        return { statusCode: 200, body: playlist(playlistReads, `segment_${playlistReads}.ts`) };
      }
      return { statusCode: 200, body: Buffer.from('synthetic transport stream') };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.segment, 'segment_1.ts');
  assert.equal(result.nextSegment, 'segment_2.ts');
  assert.equal(result.playlistAdvanced, true);
  assert.ok(requests.some((url) => url.endsWith('/tv/live/segment_1.ts')));
});

test('HLS smoke test refreshes a sliding playlist after the newest segment returns 404', async () => {
  let playlistReads = 0;
  const segmentRequests = [];
  const result = await runHlsSmokeTest({
    baseUrl: 'http://127.0.0.1:8081',
    wait: async () => {},
    request: async (url) => {
      if (url.endsWith('.m3u8')) {
        playlistReads += 1;
        return { statusCode: 200, body: playlist(playlistReads, `segment_${playlistReads}.ts`) };
      }
      segmentRequests.push(url);
      return { statusCode: segmentRequests.length === 1 ? 404 : 200, body: Buffer.from('ts') };
    }
  });

  assert.equal(result.segment, 'segment_2.ts');
  assert.deepEqual(segmentRequests.map((url) => url.split('/').pop()), ['segment_1.ts', 'segment_2.ts']);
  assert.equal(result.nextSegment, 'segment_3.ts');
});

test('HLS smoke test rejects public server and cross-origin segment URLs', async () => {
  await assert.rejects(runHlsSmokeTest({ baseUrl: 'https://example.com' }), /local StreamDBC server/);
  await assert.rejects(runHlsSmokeTest({
    baseUrl: 'http://127.0.0.1:8081',
    wait: async () => {},
    request: async (url) => url.endsWith('.m3u8')
      ? { statusCode: 200, body: playlist(1, 'http://203.0.113.8/file.ts') }
      : { statusCode: 200, body: 'ts' }
  }), /configured local \/tv\/live\//);
});
