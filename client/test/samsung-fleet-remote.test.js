'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  REMOTE_WS_PORT,
  buildKeyCommandPayload,
  buildMagicPacket,
  buildRegistrationPayload,
  decodeServerFrames,
  encodeClientFrame,
  normalizeMac,
  parseArpTable,
  powerOffTV,
  powerOnTV,
  probeAnyPortOpen
} = require('../samsung-fleet-remote');

test('registration payload targets the legacy ms.remote.control channel', () => {
  const payload = JSON.parse(buildRegistrationPayload());
  assert.equal(payload.method, 'ms.remote.control');
  assert.equal(payload.params.Key, 'ms.remote.control');
  assert.equal(payload.params.Type, 'Windows');
  assert.ok(payload.params.RemoteName.length > 0);
});

test('key command payload delivers a Click of KEY_POWER', () => {
  const payload = JSON.parse(buildKeyCommandPayload('KEY_POWER'));
  assert.equal(payload.method, 'ms.remote.control');
  assert.equal(payload.params.Cmd, 'Click');
  assert.equal(payload.params.DataOfCmd, 'KEY_POWER');
  assert.equal(payload.params.TypeOfRemote, 'SendRemoteKey');
  assert.throws(() => buildKeyCommandPayload('v=0\r\nKEY_POWER'), /Invalid Samsung remote key/);
});

test('magic packet repeats the MAC sixteen times after six sync bytes', () => {
  const packet = buildMagicPacket('A4-BC-A4-08-57-1B');
  assert.equal(packet.length, 102);
  for (let i = 0; i < 6; i++) assert.equal(packet[i], 0xff);
  for (let round = 0; round < 16; round++) {
    assert.deepEqual([...packet.subarray(6 + round * 6, 12 + round * 6)], [0xa4, 0xbc, 0xa4, 0x08, 0x57, 0x1b]);
  }
  assert.throws(() => buildMagicPacket('08:57:1B'), /Invalid MAC/);
});

test('normalizeMac accepts both separators and rejects malformed input', () => {
  assert.equal(normalizeMac('11-22-33-44-55-66'), '11:22:33:44:55:66');
  assert.throws(() => normalizeMac('11223344'), /Invalid MAC/);
  assert.throws(() => normalizeMac('XX-22-33-44-55-66'), /Invalid MAC/);
});

test('parseArpTable keeps unicast private LAN MACs and ignores unrelated rows', () => {
  const table = parseArpTable([
    '',
    'Interface: 192.168.1.85 --- 0x12',
    '  Internet Address        Physical Address      Type',
    '  192.168.1.81            a4-bc-a4-08-57-1b     dynamic',
    '  192.168.1.90            39-BC-A4-08-57-1B     dynamic',
    '  172.32.44.5             aa-bb-cc-dd-ee-ff     dynamic',
    '  garbage line without ip mac',
    '  192.168.1.999           aa-bb-cc-dd-ee-ff     invalid',
    ''
  ].join('\r\n'));
  assert.deepEqual(table, { '192.168.1.81': 'A4:BC:A4:08:57:1B' });
  assert.equal(table['192.168.1.90'], undefined); // multicast hardware bit is not a WoL target
  assert.equal(table['172.32.44.5'], undefined); // 172.32/12 is outside the private-LAN ranges
});

test('client frames are masked and decode back to the original text', () => {
  const raw = encodeClientFrame('{"a":1}');
  assert.equal(raw[0] & 0x0f, 0x1); // text opcode
  assert.notEqual(raw[1] & 0x80, 0); // mask bit sits in the length byte for client frames
  const { frames, rest } = decodeServerFrames(Buffer.concat([raw, raw]));
  assert.deepEqual(frames.map((f) => f.text), ['{"a":1}', '{"a":1}']);
  assert.equal(rest.length, 0);
});

test('decoded server frames resume across split buffers and report close frames', () => {
  const first = decodeServerFrames(Buffer.from([0x81, 0x42])); // text header promises 66 payload bytes, none present yet
  assert.deepEqual(first.frames, []);
  assert.equal(first.rest.length, 2);

  const partial = decodeServerFrames(Buffer.from([0x81, 0x04, 0x61, 0x62])); // 4-byte payload, only 'ab' delivered
  assert.deepEqual(partial.frames, []);
  assert.equal(partial.rest.length, 4);
  const second = decodeServerFrames(Buffer.concat([partial.rest, Buffer.from([0x63, 0x64, 0x88, 0x00])]));
  assert.deepEqual(second.frames.filter((f) => !f.close).map((f) => f.text), ['abcd']);
  assert.equal(second.frames.find((f) => f.close)?.close, true);
});

test('power control rejects non-LAN targets before any network use', async () => {
  const off = await powerOffTV({ ip: '8.8.8.8' });
  assert.equal(off.ok, false);
  assert.equal(off.phase, 'NO_PRIVATE_LAN_TARGET');
  const on = await powerOnTV('tv.example.local');
  assert.equal(on.ok, false);
  assert.equal(on.phase, 'NO_PRIVATE_LAN_TARGET');
});

test('probeAnyPortOpen on a closed loopback port reports false', async () => {
  assert.equal(await probeAnyPortOpen('127.0.0.1', [1]), false);
});

test('remote port constant matches the fleet description port', () => {
  assert.equal(REMOTE_WS_PORT, 7676);
});
