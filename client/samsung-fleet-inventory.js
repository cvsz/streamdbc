'use strict';

const net = require('node:net');

const KNOWN_FLEET = Object.freeze([
  { name: 'TV-81', ip: '192.168.1.81', mac: 'BC:8C:CD:32:B7:56' },
  { name: 'TV-82', ip: '192.168.1.82', mac: 'BC:8C:CD:33:ED:61' },
  { name: 'TV-89', ip: '192.168.1.89', mac: 'BC:8C:CD:2C:CD:05' },
  { name: 'TV-90', ip: '192.168.1.90', mac: 'BC:8C:CD:33:ED:36' },
  { name: 'TV-91', ip: '192.168.1.91', mac: 'BC:8C:CD:3D:FF:38' }
].map((tv) => Object.freeze(tv)));

const ALLOWED_TV_PORTS = Object.freeze([80, 443, 4443, 6000, 7676, 52345, 55000, 55001]);
const ALLOWED_PORT_SET = new Set(ALLOWED_TV_PORTS);
const CAPABILITY_NAMES = Object.freeze([
  'mediaRenderer', 'avTransport', 'renderingControl', 'connectionManager', 'mainTVAgent2',
  'setAVTransportURI', 'play', 'stop', 'pause', 'runBrowser',
  'getSourceList', 'getCurrentExternalSource', 'setMainTVSource'
]);

function isPrivateIPv4(value) {
  const parts = String(value || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}

function safeDeviceUrl(value, expectedIP) {
  if (!value) return false;
  try {
    const url = new URL(value);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username && !url.password &&
      url.hostname === expectedIP && isPrivateIPv4(url.hostname) &&
      ALLOWED_PORT_SET.has(port);
  } catch {
    return false;
  }
}

function safeDescriptor(device, expectedIP = '') {
  if (!device || !isPrivateIPv4(device.ip) || (expectedIP && device.ip !== expectedIP)) return false;
  if (!safeDeviceUrl(device.location, device.ip)) return false;
  for (const location of device.locations || []) {
    if (!safeDeviceUrl(location, device.ip)) return false;
  }
  for (const service of device.services || []) {
    for (const key of ['controlURL', 'scpdURL', 'eventSubURL']) {
      if (service[key] && !safeDeviceUrl(service[key], device.ip)) return false;
    }
  }
  return true;
}

function normalizedCapabilities(value) {
  return Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, value?.[name] === true]));
}

function normalizedServices(services = []) {
  return (Array.isArray(services) ? services : []).map((service) => ({
    ...service,
    actions: Array.isArray(service.actions) ? [...new Set(service.actions.filter((item) => typeof item === 'string'))] : []
  }));
}

function validateLanMediaUrl(value, localIPs) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error('Media URL is invalid'); }
  const hosts = new Set((Array.isArray(localIPs) ? localIPs : []).filter(isPrivateIPv4));
  if (url.protocol !== 'http:' || url.username || url.password || !hosts.has(url.hostname) || Number(url.port || 80) !== 8081 || !url.pathname.startsWith('/tv/')) {
    throw new Error('TV URL must use this PC LAN IPv4, port 8081, and a /tv/ path');
  }
  return url.toString();
}

function knownFallback(known, cached = null) {
  return {
    ...(cached || {}),
    ip: known.ip,
    friendlyName: known.name,
    modelName: cached?.modelName || 'UA40F5500',
    mac: known.mac,
    known: true,
    online: false,
    openPorts: [],
    discoverySource: cached ? 'session-cache' : 'known-fleet',
    capabilitiesKnown: Boolean(cached),
    capabilities: normalizedCapabilities(cached?.capabilities),
    services: cached ? normalizedServices(cached.services) : []
  };
}

function mergeKnownAndDiscovered(discovered = [], previous = []) {
  const discoveredByIP = new Map();
  for (const device of Array.isArray(discovered) ? discovered : []) {
    if (safeDescriptor(device)) discoveredByIP.set(device.ip, device);
  }

  const previousByIP = new Map();
  for (const device of Array.isArray(previous) ? previous : []) {
    if (safeDescriptor(device) && KNOWN_FLEET.some((known) => known.ip === device.ip)) {
      previousByIP.set(device.ip, device);
    }
  }

  const fleet = KNOWN_FLEET.map((known) => {
    const descriptor = discoveredByIP.get(known.ip);
    if (descriptor) {
      const sessionCache = descriptor.discoverySource === 'session-cache';
      return {
        ...knownFallback(known),
        ...descriptor,
        ip: known.ip,
        friendlyName: known.name,
        modelName: descriptor.modelName || 'UA40F5500',
        mac: known.mac,
        known: true,
        online: true,
        openPorts: [],
        discoverySource: descriptor.discoverySource === 'session-cache' ? 'session-cache' : 'ssdp',
        capabilitiesKnown: true,
        capabilities: normalizedCapabilities(descriptor.capabilities),
        services: normalizedServices(descriptor.services)
      };
    }
    const cached = previousByIP.get(known.ip);
    return knownFallback(known, cached || null);
  });

  const knownIPs = new Set(KNOWN_FLEET.map((tv) => tv.ip));
  const additional = [...discoveredByIP.values()]
    .filter((device) => !knownIPs.has(device.ip))
    .map((device) => ({
      ...device,
      known: false,
      online: true,
      openPorts: [],
      discoverySource: 'ssdp',
      capabilitiesKnown: true,
      capabilities: normalizedCapabilities(device.capabilities),
      services: normalizedServices(device.services)
    }))
    .sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));

  return [...fleet, ...additional];
}

function checkTCPPort(ip, port, timeoutMs = 750) {
  return new Promise((resolve) => {
    if (!isPrivateIPv4(ip) || !ALLOWED_PORT_SET.has(port)) return resolve(false);
    const socket = net.createConnection({ host: ip, port });
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function probeKnownTV(ip, probePort = checkTCPPort) {
  if (!KNOWN_FLEET.some((tv) => tv.ip === ip)) {
    throw new Error('IP is not in the known Samsung fleet');
  }

  const openPorts = [];
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < ALLOWED_TV_PORTS.length) {
      const port = ALLOWED_TV_PORTS[nextIndex++];
      try {
        const open = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 750);
          Promise.resolve()
            .then(() => probePort(ip, port, 750))
            .then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(false); });
        });
        if (open === true) openPorts.push(port);
      } catch {}
    }
  };

  await Promise.all(Array.from({ length: Math.min(3, ALLOWED_TV_PORTS.length) }, worker));
  openPorts.sort((a, b) => a - b);
  return { ip, openPorts, online: openPorts.length > 0, error: '' };
}

async function probeKnownFleet(probePort = checkTCPPort) {
  const results = [];
  for (const tv of KNOWN_FLEET) results.push(await probeKnownTV(tv.ip, probePort));
  return results;
}

function applyProbeResults(fleet, results = []) {
  const resultByIP = new Map((Array.isArray(results) ? results : [])
    .filter((result) => KNOWN_FLEET.some((tv) => tv.ip === result.ip))
    .map((result) => [result.ip, result]));
  return (Array.isArray(fleet) ? fleet : []).map((tv) => {
    const result = resultByIP.get(tv.ip);
    if (!result || !tv.known) return tv;
    return {
      ...tv,
      online: result.online === true || tv.online === true,
      openPorts: [...new Set((result.openPorts || []).filter((port) => ALLOWED_PORT_SET.has(port)))].sort((a, b) => a - b),
      probeError: String(result.error || '')
    };
  });
}

module.exports = {
  ALLOWED_TV_PORTS,
  KNOWN_FLEET,
  applyProbeResults,
  checkTCPPort,
  mergeKnownAndDiscovered,
  probeKnownFleet,
  probeKnownTV,
  safeDescriptor,
  validateLanMediaUrl
};
