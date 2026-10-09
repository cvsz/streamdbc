'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runTVAction } = require('../samsung-fleet');

const AV_TRANSPORT = 'urn:schemas-upnp-org:service:AVTransport:1';
const MAIN_TV = 'urn:samsung.com:service:MainTVAgent2:1';
const tv = { ip: '192.168.1.81', services: [] };

test('play-url retries only transient transport failures once and reports each phase', async () => {
  const calls = [];
  const response = await runTVAction(tv, 'play-url', 'http://192.168.1.85:8081/tv/live/index.m3u8', async (_tv, service, action, args) => {
    calls.push({ service, action, args });
    if (action === 'SetAVTransportURI' && calls.filter((call) => call.action === action).length === 1) {
      return { ok: false, statusCode: 0, error: 'temporary URI transport error' };
    }
    if (action === 'Play' && calls.filter((call) => call.action === action).length === 1) {
      return { ok: false, statusCode: 503, error: 'temporary Play transport error' };
    }
    return { ok: true, statusCode: 200 };
  });

  assert.equal(response.ok, true);
  assert.equal(response.phase, 'PLAY_ACCEPTED');
  assert.equal(response.setUri.ok, true);
  assert.deepEqual(calls.map((call) => call.action), ['SetAVTransportURI', 'SetAVTransportURI', 'Play', 'Play']);
  assert.ok(calls.every((call) => call.service === AV_TRANSPORT));
});

test('play-url does not retry a definite unsupported media response or send Play', async () => {
  const actions = [];
  const response = await runTVAction(tv, 'play-url', 'http://192.168.1.85:8081/tv/live/index.m3u8', async (_tv, _service, action) => {
    actions.push(action);
    return { ok: false, statusCode: 500, errorCode: 714, errorDescription: 'Illegal MIME-type' };
  });

  assert.equal(response.ok, false);
  assert.equal(response.phase, 'SET_URI_FAILED');
  assert.equal(actions.length, 1);
  assert.ok(actions.every((action) => action === 'SetAVTransportURI'));
});

test('open-browser sends the live player URL through RunBrowser exactly once', async () => {
  const calls = [];
  const url = 'http://192.168.1.85:8081/tv/';
  const response = await runTVAction(tv, 'open-browser', url, async (_tv, service, action, args) => {
    calls.push({ service, action, args });
    return { ok: true, statusCode: 200 };
  });

  assert.equal(response.ok, true);
  assert.deepEqual(calls, [{
    service: MAIN_TV,
    action: 'RunBrowser',
    args: { BrowserURL: url }
  }]);
});

test('open-browser rejects URLs outside the private-LAN StreamDBC TV page', async () => {
  let calls = 0;
  await assert.rejects(
    runTVAction(tv, 'open-browser', 'https://example.com/tv/', async () => {
      calls += 1;
      return { ok: true, statusCode: 200 };
    }),
    /private LAN IP, port 8081, and a \/tv\/ path/
  );
  assert.equal(calls, 0);
});

test('open-browser does not retry when the TV sends no SOAP response', async () => {
  const calls = [];
  const response = await runTVAction(tv, 'open-browser', 'http://192.168.1.85:8081/tv/', async (_tv, service, action) => {
    calls.push({ service, action });
    return { ok: false, statusCode: 0, error: 'socket hang up' };
  });

  assert.equal(response.ok, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { service: MAIN_TV, action: 'RunBrowser' });
});
