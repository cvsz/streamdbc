'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ALLOWED_TV_PORTS,
  KNOWN_FLEET,
  applyProbeResults,
  mergeKnownAndDiscovered,
  probeKnownTV,
  validateLanMediaUrl
} = require('../samsung-fleet-inventory');

test('zero SSDP results still produce all configured TVs without inventing capabilities', () => {
  const fleet = mergeKnownAndDiscovered([]);

  assert.deepEqual(fleet.map((tv) => tv.ip), KNOWN_FLEET.map((tv) => tv.ip));
  assert.equal(fleet.length, 5);
  assert.ok(fleet.every((tv) => tv.known && tv.discoverySource === 'known-fleet'));
  assert.ok(fleet.every((tv) => tv.online === false && tv.capabilitiesKnown === false));
  assert.ok(fleet.every((tv) => Object.values(tv.capabilities).every((value) => value === false)));
});

test('known SSDP devices enrich the fallback and unrelated validated SSDP devices remain included', () => {
  const fleet = mergeKnownAndDiscovered([
    {
      ip: '192.168.1.81',
      friendlyName: 'Samsung TV',
      modelName: 'UA40F5500',
      location: 'http://192.168.1.81:7676/desc.xml',
      services: [],
      capabilities: { avTransport: true, setAVTransportURI: true, play: true }
    },
    {
      ip: '192.168.1.50',
      friendlyName: 'Other Samsung',
      location: 'http://192.168.1.50:7676/desc.xml',
      services: [],
      capabilities: { avTransport: true }
    },
    {
      ip: '203.0.113.7',
      friendlyName: 'Untrusted external device',
      services: []
    }
  ]);
  const known = fleet.find((tv) => tv.ip === '192.168.1.81');
  const discovered = fleet.find((tv) => tv.ip === '192.168.1.50');

  assert.equal(known.known, true);
  assert.equal(known.discoverySource, 'ssdp');
  assert.equal(known.friendlyName, 'TV-81');
  assert.equal(known.capabilitiesKnown, true);
  assert.equal(discovered.known, false);
  assert.equal(discovered.online, true);
  assert.equal(fleet.some((tv) => tv.ip === '203.0.113.7'), false);
});

test('same-session UPnP descriptors are reused only for their known TV and allowlisted URLs', () => {
  const valid = {
    ip: '192.168.1.81',
    friendlyName: 'TV-81 hydrated',
    location: 'http://192.168.1.81:7676/desc.xml',
    services: [{ serviceType: 'av', controlURL: 'http://192.168.1.81:7676/av' }],
    capabilities: { avTransport: true }
  };
  const fleet = mergeKnownAndDiscovered([], [
    valid,
    { ...valid, ip: '192.168.1.82', location: 'http://192.168.1.81:7676/desc.xml' },
    { ...valid, location: 'http://192.168.1.81:1234/desc.xml' }
  ]);
  const reused = fleet.find((tv) => tv.ip === '192.168.1.81');
  const untouched = fleet.find((tv) => tv.ip === '192.168.1.82');

  assert.equal(reused.discoverySource, 'session-cache');
  assert.equal(reused.capabilitiesKnown, true);
  assert.equal(untouched.discoverySource, 'known-fleet');
  assert.equal(untouched.services.length, 0);
});

test('known-TV port probes stay on the exact fleet and use at most three allowlisted ports at once', async () => {
  let active = 0;
  let peak = 0;
  const checked = [];
  const result = await probeKnownTV('192.168.1.81', async (ip, port, timeoutMs) => {
    assert.equal(ip, '192.168.1.81');
    assert.equal(timeoutMs, 750);
    checked.push(port);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return port === 80 || port === 7676;
  });

  assert.deepEqual(checked.sort((a, b) => a - b), [...ALLOWED_TV_PORTS].sort((a, b) => a - b));
  assert.ok(peak <= 3);
  assert.deepEqual(result.openPorts, [80, 7676]);
  assert.equal(result.online, true);
  await assert.rejects(probeKnownTV('192.168.1.200', async () => true), /known Samsung fleet/);
});

test('probe results mark only known devices online when an allowed port responds', () => {
  const fleet = mergeKnownAndDiscovered([]);
  const updated = applyProbeResults(fleet, [
    { ip: '192.168.1.81', online: true, openPorts: [80], error: '' },
    { ip: '192.168.1.82', online: false, openPorts: [], error: '' }
  ]);

  assert.equal(updated.find((tv) => tv.ip === '192.168.1.81').online, true);
  assert.equal(updated.find((tv) => tv.ip === '192.168.1.81').openPorts[0], 80);
  assert.equal(updated.find((tv) => tv.ip === '192.168.1.82').online, false);
  assert.equal(updated.find((tv) => tv.ip === '192.168.1.89').online, false);
});

test('media URLs are restricted to the detected PC LAN address and StreamDBC TV paths', () => {
  assert.equal(
    validateLanMediaUrl('http://192.168.1.85:8081/tv/live/index.m3u8', ['192.168.1.85']),
    'http://192.168.1.85:8081/tv/live/index.m3u8'
  );
  assert.throws(() => validateLanMediaUrl('http://127.0.0.1:8081/tv/live/index.m3u8', ['192.168.1.85']), /PC LAN IPv4/);
  assert.throws(() => validateLanMediaUrl('http://203.0.113.8:8081/tv/test.mp4', ['192.168.1.85']), /PC LAN IPv4/);
  assert.throws(() => validateLanMediaUrl('http://192.168.1.85:7676/tv/test.mp4', ['192.168.1.85']), /PC LAN IPv4/);
});
