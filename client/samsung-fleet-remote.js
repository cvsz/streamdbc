'use strict';

/*
 * Samsung TV remote power control for the Windows Control Panel.
 *
 * Power OFF uses the legacy Samsung WebSocket remote protocol on port 7676 —
 * the same port every fleet TV advertises its UPnP description on:
 *   1. HTTP/1.1 Upgrade handshake to ws://<private-lan-ip>:7676/
 *   2. Registration frame {"method":"ms.remote.control",...}. A TV that has
 *      never seen this panel name pops an on-screen confirmation dialog; the
 *      panel reports REMOTE_AUTH_REQUIRED so the operator accepts it once on
 *      the target TV and presses Power Off again.
 *   3. Click frame carrying KEY_POWER.
 *   4. Post-off TCP probe of the fleet's known ports:
 *      all closed  => POWER_OFF_CONFIRMED (TV stopped answering)
 *      still open  => POWER_OFF_SENT (network standby keeps ports open)
 *
 * Power ON uses Wake-on-LAN:
 *   ARP (spawn, no shell) -> MAC -> magic packet to 255.255.255.255:9
 *   -> poll the same ports until one accepts a TCP connection
 *      (POWER_ON_CONFIRMED) or the budget expires (POWER_ON_TIMEOUT; the TV
 *      needs Wake On LAN / Power On With Mobile enabled in its settings).
 *
 * Every network path is limited to private LAN IPv4 targets, mirroring
 * the strictness of samsung-fleet.js.
 */

const crypto = require('crypto');
const dgram = require('dgram');
const net = require('net');
const { spawn } = require('child_process');

const REMOTE_WS_PORT = 7676;
const PROBE_PORTS = [80, 55000];
const HANDSHAKE_CONNECT_TIMEOUT_MS = 4000;
const REGISTRATION_TIMEOUT_MS = 6000;
const KEY_SETTLE_MS = 600;
const POST_OFF_PROBE_DELAY_MS = 3500;
const PROBE_TIMEOUT_MS = 1500;
const WOL_PACKETS = 3;
const WOL_PACKET_INTERVAL_MS = 250;
const WOL_POLL_INTERVAL_MS = 3000;
const WOL_POLL_TOTAL_MS = 45000;

function isPrivateIPv4(value) {
  const parts = String(value || '').split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168));
}

function resolveTargetIP(tv) {
  const ip = typeof tv === 'string' ? tv : tv?.ip;
  return typeof ip === 'string' ? ip.trim() : '';
}

function buildRegistrationPayload(remoteName = 'StreamDBC Control Panel') {
  return JSON.stringify({
    method: 'ms.remote.control',
    params: {
      Key: 'ms.remote.control',
      RemoteName: remoteName,
      Type: 'Windows'
    }
  });
}

function buildKeyCommandPayload(keyName) {
  if (!/^KEY_[A-Z0-9_]+$/.test(keyName)) {
    throw new Error('Invalid Samsung remote key name');
  }
  return JSON.stringify({
    method: 'ms.remote.control',
    params: {
      Cmd: 'Click',
      DataOfCmd: keyName,
      Option: 'false',
      TypeOfRemote: 'SendRemoteKey'
    }
  });
}

// Client frames must be masked per RFC 6455.
function encodeClientFrame(text) {
  const payload = Buffer.from(String(text), 'utf8');
  if (payload.length > 0xffff) throw new Error('Remote frame too large');
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = 0x81; // FIN + text opcode
  if (payload.length < 126) {
    header[1] = 0x80 | payload.length;
  } else {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload).map((byte, i) => byte ^ mask[i % 4]);
  return Buffer.concat([header, mask, masked]);
}

// Decode raw wire bytes into frames. Client frames are masked (per RFC 6455),
// the 4 mask bytes sit between the header and the payload.
function decodeServerFrames(chunk) {
  const frames = [];
  const buffer = Buffer.from(chunk);
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let lengthBytes = 0;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      lengthBytes = 2;
    } else if (length === 127) {
      break; // oversized frames never occur on this channel
    }
    const maskStart = offset + 2 + lengthBytes;
    const headerLen = 2 + lengthBytes + (masked ? 4 : 0);
    const total = headerLen + length;
    if (buffer.length - offset < total) break;
    let data = buffer.subarray(offset + headerLen, offset + total);
    if (masked) {
      const mask = buffer.subarray(maskStart, maskStart + 4);
      data = Buffer.from(data).map((byte, i) => byte ^ mask[i % 4]);
    }
    const opcode = first & 0x0f;
    if (opcode === 0x1) frames.push({ text: data.toString('utf8'), close: false });
    else if (opcode === 0x8) frames.push({ text: null, close: true });
    offset += total;
  }
  return { frames, rest: buffer.subarray(offset) };
}

class SamsungWsRemote {
  constructor(ip) {
    this.ip = ip;
    this.buffer = Buffer.alloc(0);
    this.handshake = Buffer.alloc(0);
    this.upgraded = false;
    this.closed = false;
    this.queue = [];
    this.waiters = [];
    this.socket = null;
  }

  static async connect(ip) {
    const remote = new SamsungWsRemote(isPrivateIPv4(ip) ? ip : '');
    await remote.openHandshake();
    return remote;
  }

  openHandshake() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, arg) => {
        if (settled) return;
        settled = true;
        if (this.socket) { try { this.socket.setTimeout(0); } catch {} }
        setImmediate(() => fn(arg));
      };
      const rejectAndDestroy = (err) => {
        try { this.socket?.destroy(); } catch {}
        settle(reject, err);
      };
      this.socket = net.connect(REMOTE_WS_PORT, this.ip);
      this.socket.setTimeout(HANDSHAKE_CONNECT_TIMEOUT_MS);
      this.socket.once('connect', () => {
        this.secKey = crypto.randomBytes(16).toString('base64');
        this.socket.write(
          'GET / HTTP/1.1\r\n' +
          'Host: ' + this.ip + ':' + REMOTE_WS_PORT + '\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: ' + this.secKey + '\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          'User-Agent: StreamDBC-SamsungRemote/1.0\r\n\r\n'
        );
      });
      this.socket.on('timeout', () => rejectAndDestroy(new Error('TCP connect/handshake timeout')));
      this.socket.on('error', (err) => rejectAndDestroy(err));
      this.socket.on('data', (chunk) => {
        if (!this.upgraded) {
          this.handshake = Buffer.concat([this.handshake, chunk]);
          const idx = this.handshake.indexOf('\r\n\r\n');
          if (idx === -1) {
            if (this.handshake.length > 65536) rejectAndDestroy(new Error('Samsung remote handshake oversized'));
            return;
          }
          const head = this.handshake.subarray(0, idx).toString('utf8');
          const firstLine = head.split('\r\n')[0] || '';
          if (!/^HTTP\/1\.1 101/i.test(firstLine)) {
            rejectAndDestroy(new Error('Samsung remote handshake refused (' + firstLine.slice(0, 64) + ')'));
            return;
          }
          const match = head.split('\r\n').find((line) => /^sec-websocket-accept:\s*/i.test(line));
          const accept = match ? match.replace(/^sec-websocket-accept:\s*/i, '').trim() : '';
          const expected = crypto.createHash('sha1')
            .update(this.secKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
          if (accept !== expected) {
            rejectAndDestroy(new Error('Samsung remote handshake accept key mismatch'));
            return;
          }
          this.upgraded = true;
          this.socket.removeAllListeners('data');
          this.socket.on('data', (frameChunk) => this.onFrameData(frameChunk));
          settle(resolve, this);
          const remainder = this.handshake.subarray(idx + 4);
          if (remainder.length) this.onFrameData(remainder);
          return;
        }
        this.onFrameData(chunk);
      });
      this.socket.on('close', () => this.onSocketClosed());
    });
  }

  onFrameData(chunk) {
    const merged = decodeServerFrames(Buffer.concat([this.buffer, chunk]));
    this.buffer = merged.rest;
    for (const frame of merged.frames) {
      if (frame.close) {
        this.closed = true;
        this.flushClose();
        try { this.socket.end(); } catch {}
      } else if (frame.text !== null && frame.text !== undefined) {
        this.queue.push(frame.text);
        this.flushQueue();
      }
    }
  }

  onSocketClosed() {
    this.closed = true;
    this.flushClose();
  }

  flushQueue() {
    while (this.waiters.length && this.queue.length) {
      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(this.queue.shift());
    }
  }

  flushClose() {
    while (this.waiters.length) {
      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
  }

  nextText(timeoutMs = REGISTRATION_TIMEOUT_MS) {
    return new Promise((resolve) => {
      if (this.queue.length) return resolve(this.queue.shift());
      if (this.closed) return resolve(null);
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(entry);
        if (i !== -1) this.waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      const entry = { timer, resolve };
      this.waiters.push(entry);
    });
  }

  sendText(text) {
    if (this.closed || !this.upgraded) throw new Error('Samsung remote socket is not open');
    this.socket.write(encodeClientFrame(text));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      // RFC 6455: close opcode 0x88, empty payload, no mask needed as a formality.
      this.socket.write(Buffer.from([0x88, 0x00]));
      setTimeout(() => { try { this.socket.destroy(); } catch {} }, 150);
    } catch {
      try { this.socket.destroy(); } catch {}
    }
    this.flushClose();
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probePort(ip, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.connect(port, ip);
    socket.setTimeout(timeoutMs);
    const done = (result) => {
      try { socket.destroy(); } catch {}
      resolve(result);
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function probeAnyPortOpen(ip, ports = PROBE_PORTS) {
  for (const port of ports) {
    if (await probePort(ip, port)) return true;
  }
  return false;
}

function getArpMac(ip) {
  return new Promise((resolve) => {
    if (!isPrivateIPv4(ip)) return resolve(null);
    let output = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(parseArpTable(output)[ip] || null);
    };
    let child;
    try {
      child = spawn('arp', ['-a'], { windowsHide: true });
    } catch {
      return resolve(null);
    }
    child.stdout?.on('data', (chunk) => {
      if (output.length < 262144) output += chunk.toString('utf8');
    });
    child.on('error', finish);
    child.on('close', finish);
  });
}

// Returns { ip: 'AA:BB:CC:DD:EE:FF' } normalised with ':' separators.
function parseArpTable(text) {
  const entries = {};
  const line = /^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5})\b/gim;
  let match;
  while ((match = line.exec(String(text || ''))) !== null) {
    const ip = match[1];
    const mac = match[2].split(/[:-]/).join(':').toUpperCase();
    if (!isPrivateIPv4(ip)) continue;
    // IPv4 ARP rows carry unicast (WoL-able) hardware addresses only.
    if ((parseInt(mac.slice(0, 2), 16) & 0x01) !== 0) continue;
    entries[ip] = mac;
  }
  return entries;
}

function normalizeMac(mac) {
  const pairs = String(mac || '').split(/[:-]/).map((pair) => pair.trim());
  if (pairs.length !== 6 || !pairs.every((p) => /^[0-9a-f]{2}$/i.test(p))) {
    throw new Error('Invalid MAC address');
  }
  return pairs.map((p) => p.toLowerCase()).join(':');
}

function buildMagicPacket(mac) {
  const normalized = normalizeMac(mac);
  const macBytes = normalized.split(':').map((p) => parseInt(p, 16));
  const packet = Buffer.alloc(6 + 16 * 6);
  packet.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) {
    macBytes.forEach((byte, j) => {
      packet[6 + i * 6 + j] = byte;
    });
  }
  return packet;
}

function sendMagicPacket(mac, localIPHint = '') {
  return new Promise((resolve) => {
    const packet = buildMagicPacket(mac);
    const socket = dgram.createSocket('udp4');
    let sent = 0;
    let failed = false;
    try {
      socket.bind(() => {
        try { socket.setBroadcast(true); } catch {}
        const push = () => socket.send(packet, 9, '255.255.255.255', (err) => {
          if (err) {
            failed = true;
            try { socket.close(); } catch {}
            resolve(false);
            return;
          }
          sent += 1;
          if (sent >= WOL_PACKETS) {
            try { socket.close(); } catch {}
            resolve(!failed);
          }
        });
        push();
        if (WOL_PACKETS > 1) {
          for (let n = 1; n < WOL_PACKETS; n++) setTimeout(push, n * WOL_PACKET_INTERVAL_MS);
        }
      });
    } catch {
      try { socket.close(); } catch {}
      resolve(false);
    }
  });
}

// result: { ok, phase, [detail|error] }
async function powerOffTV(tv) {
  const ip = resolveTargetIP(tv);
  if (!isPrivateIPv4(ip)) {
    return { ok: false, phase: 'NO_PRIVATE_LAN_TARGET', error: 'A private LAN IPv4 is required for Samsung remote power control.' };
  }

  let remote;
  try {
    remote = await SamsungWsRemote.connect(ip);
  } catch (err) {
    return { ok: false, phase: 'REMOTE_UNREACHABLE', error: 'Samsung remote socket ' + ip + ':7676 did not hand-shake: ' + err.message };
  }

  try {
    remote.sendText(buildRegistrationPayload());
    const ack = await remote.nextText(REGISTRATION_TIMEOUT_MS);
    if (ack && /ms\.channel\.unauthorized|"status":"decline"/i.test(ack)) {
      return {
        ok: false,
        phase: 'REMOTE_AUTH_REQUIRED',
        error: 'The TV is waiting for access confirmation. Accept the remote-control prompt once on the TV screen, then press Power Off again.'
      };
    }
    if (ack && /ms\.channel\.connect/i.test(ack)) {
      // registration confirmed
    } else if (!ack) {
      return { ok: false, phase: 'REMOTE_HANDSHAKE_TIMEOUT', error: 'No registration response from ' + ip + ':7676 within ' + REGISTRATION_TIMEOUT_MS / 1000 + 's.' };
    } else {
      return { ok: false, phase: 'REMOTE_HANDSHAKE_UNKNOWN', error: 'Unexpected remote registration response: ' + ack.slice(0, 200) };
    }

    remote.sendText(buildKeyCommandPayload('KEY_POWER'));
    await wait(KEY_SETTLE_MS);
  } catch (err) {
    return { ok: false, phase: 'POWER_OFF_SEND_FAILED', error: 'Power key not delivered: ' + err.message };
  } finally {
    try { remote.close(); } catch {}
  }

  await wait(POST_OFF_PROBE_DELAY_MS);
  const reachable = await probeAnyPortOpen(ip);
  if (reachable) {
    return {
      ok: true,
      phase: 'POWER_OFF_SENT',
      detail: 'Power key delivered; the TV still answers the LAN (network standby). Confirm the screen is dark.'
    };
  }
  return { ok: true, phase: 'POWER_OFF_CONFIRMED', detail: 'TV stopped answering the LAN ports after the power key.' };
}

async function powerOnTV(tv) {
  const ip = resolveTargetIP(tv);
  if (!isPrivateIPv4(ip)) {
    return { ok: false, phase: 'NO_PRIVATE_LAN_TARGET', error: 'A private LAN IPv4 is required for Wake-on-LAN.' };
  }
  const mac = await getArpMac(ip);
  if (!mac) {
    return {
      ok: false,
      phase: 'ARP_MISSING',
      error: 'No cached MAC for ' + ip + ' on this PC. Wake the TV once with its physical remote so Windows learns the MAC, then Power On will work over the LAN.'
    };
  }
  const sent = await sendMagicPacket(mac);
  if (!sent) {
    return { ok: false, phase: 'WOL_SEND_FAILED', error: 'Wake-on-LAN magic packets could not be transmitted to 255.255.255.255:9.' };
  }

  const deadline = Date.now() + WOL_POLL_TOTAL_MS;
  while (Date.now() < deadline) {
    await wait(WOL_POLL_INTERVAL_MS);
    if (await probeAnyPortOpen(ip)) {
      return { ok: true, phase: 'POWER_ON_CONFIRMED', detail: 'TV answered the LAN ports after Wake-on-LAN (' + mac + ').' };
    }
  }
  return {
    ok: false,
    phase: 'POWER_ON_TIMEOUT',
    error: 'Wake-on-LAN packets were sent to ' + ip + ' (' + mac + ') but the TV never answered within ' + WOL_POLL_TOTAL_MS / 1000 + 's. Enable Wake On LAN / Power On With Mobile on the TV settings, then retry.'
  };
}

module.exports = {
  REMOTE_WS_PORT,
  PROBE_PORTS,
  buildKeyCommandPayload,
  buildMagicPacket,
  buildRegistrationPayload,
  decodeServerFrames,
  encodeClientFrame,
  getArpMac,
  normalizeMac,
  parseArpTable,
  powerOffTV,
  powerOnTV,
  probeAnyPortOpen,
  sendMagicPacket
};
