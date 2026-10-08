'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runTVAction } = require('../samsung-fleet');

const AV_TRANSPORT = 'urn:schemas-upnp-org:service:AVTransport:1';
const tv = { ip: '192.168.1.81', services: [] };

test('play-url retries URI and Play commands within fixed bounds and reports each phase', async () => {
  const calls = [];
  const response = await runTVAction(tv, 'play-url', 'http://192.168.1.85:8081/tv/live/index.m3u8', async (_tv, service, action, args) => {
    calls.push({ service, action, args });
    if (action === 'SetAVTransportURI' && calls.filter((call) => call.action === action).length === 1) {
      return { ok: false, statusCode: 500, errorDescription: 'temporary URI error' };
    }
    if (action === 'Play' && calls.filter((call) => call.action === action).length < 3) {
      return { ok: false, statusCode: 500, errorDescription: 'temporary Play error' };
    }
    return { ok: true, statusCode: 200 };
  });

  assert.equal(response.ok, true);
  assert.equal(response.phase, 'PLAY_ACCEPTED');
  assert.equal(response.setUri.ok, true);
  assert.deepEqual(calls.map((call) => call.action), ['SetAVTransportURI', 'SetAVTransportURI', 'Play', 'Play', 'Play']);
  assert.ok(calls.every((call) => call.service === AV_TRANSPORT));
});

test('play-url does not send Play when SetAVTransportURI fails after its bounded retry', async () => {
  const actions = [];
  const response = await runTVAction(tv, 'play-url', 'http://192.168.1.85:8081/tv/live/index.m3u8', async (_tv, _service, action) => {
    actions.push(action);
    return { ok: false, statusCode: 500, errorDescription: 'URI rejected' };
  });

  assert.equal(response.ok, false);
  assert.equal(response.phase, 'SET_URI_FAILED');
  assert.equal(actions.length, 2);
  assert.ok(actions.every((action) => action === 'SetAVTransportURI'));
});
