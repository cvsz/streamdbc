const dgram = require('dgram');
const http = require('http');

const SSDP_HOST = '239.255.255.250';
const SSDP_PORT = 1900;
const SERVICE = {
  av: 'urn:schemas-upnp-org:service:AVTransport:1',
  rendering: 'urn:schemas-upnp-org:service:RenderingControl:1',
  connection: 'urn:schemas-upnp-org:service:ConnectionManager:1',
  mainTv: 'urn:samsung.com:service:MainTVAgent2:1'
};

function isPrivateIPv4(value) {
  const p = String(value || '').split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168));
}

function xmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  }[c]));
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function tag(xml, name) {
  const m = String(xml || '').match(new RegExp('<(?:[^:>]+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[^:>]+:)?' + name + '>', 'i'));
  return m ? decodeXml(m[1].trim()) : '';
}

function parseSsdpHeaders(text) {
  const headers = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

function safeLegacyUrl(value, expectedIP = '') {
  let u;
  try { u = new URL(value); } catch { throw new Error('Invalid UPnP URL'); }
  if (u.protocol !== 'http:' || !isPrivateIPv4(u.hostname)) throw new Error('UPnP URL must be private-lan HTTP');
  if (expectedIP && u.hostname !== expectedIP) throw new Error('UPnP URL host does not match SSDP responder');
  const port = Number(u.port || 80);
  if (![80, 7676].includes(port)) throw new Error('Unexpected Samsung UPnP port');
  return u;
}

function getText(urlValue, expectedIP, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let u;
    try { u = safeLegacyUrl(urlValue, expectedIP); } catch (err) {
      resolve({ ok: false, statusCode: 0, body: '', error: err.message }); return;
    }
    const req = http.get(u, {
      headers: { 'User-Agent': 'StreamDBC-SamsungFleet/1.0', Accept: 'text/xml,*/*' }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (body.length < 1024 * 1024) body += chunk; });
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        statusCode: res.statusCode || 0,
        body,
        error: null
      }));
    });
    req.on('error', (err) => resolve({ ok: false, statusCode: 0, body: '', error: err.message }));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('HTTP timeout')));
  });
}

function absoluteServiceUrl(location, value) {
  if (!value) return '';
  const base = safeLegacyUrl(location);
  const resolved = new URL(value, base);
  return safeLegacyUrl(resolved.toString(), base.hostname).toString();
}

function parseServices(xml, location) {
  const services = [];
  const blocks = String(xml || '').match(/<service>[\s\S]*?<\/service>/gi) || [];
  for (const block of blocks) {
    const serviceType = tag(block, 'serviceType');
    if (!serviceType) continue;
    let controlURL = '', scpdURL = '', eventSubURL = '';
    try {
      controlURL = absoluteServiceUrl(location, tag(block, 'controlURL'));
      scpdURL = absoluteServiceUrl(location, tag(block, 'SCPDURL'));
      eventSubURL = absoluteServiceUrl(location, tag(block, 'eventSubURL'));
    } catch {
      continue;
    }
    services.push({ serviceType, controlURL, scpdURL, eventSubURL, actions: [] });
  }
  return services;
}

function parseActions(xml) {
  const out = [];
  const blocks = String(xml || '').match(/<action>[\s\S]*?<\/action>/gi) || [];
  for (const block of blocks) {
    const name = tag(block, 'name');
    if (name) out.push(name);
  }
  return [...new Set(out)];
}

async function hydrateDescription(ip, location, ssdp) {
  const desc = await getText(location, ip);
  if (!desc.ok || !desc.body) return null;
  if (!/Samsung/i.test(desc.body) && !/samsung/i.test(ssdp.server || '')) return null;

  const services = parseServices(desc.body, location);
  for (const svc of services) {
    if (!svc.scpdURL) continue;
    const scpd = await getText(svc.scpdURL, ip);
    if (scpd.ok) svc.actions = parseActions(scpd.body);
  }

  const byType = (type) => services.find((s) => s.serviceType === type);
  const deviceType = tag(desc.body, 'deviceType');
  return {
    ip,
    location,
    friendlyName: tag(desc.body, 'friendlyName') || 'Samsung TV',
    modelName: tag(desc.body, 'modelName'),
    modelDescription: tag(desc.body, 'modelDescription'),
    udn: tag(desc.body, 'UDN'),
    productCap: tag(desc.body, 'ProductCap'),
    deviceType,
    server: ssdp.server || '',
    services,
    capabilities: {
      mediaRenderer: deviceType === 'urn:schemas-upnp-org:device:MediaRenderer:1',
      avTransport: Boolean(byType(SERVICE.av)),
      renderingControl: Boolean(byType(SERVICE.rendering)),
      connectionManager: Boolean(byType(SERVICE.connection)),
      mainTVAgent2: Boolean(byType(SERVICE.mainTv)),
      setAVTransportURI: Boolean(byType(SERVICE.av)?.actions.includes('SetAVTransportURI')),
      play: Boolean(byType(SERVICE.av)?.actions.includes('Play')),
      stop: Boolean(byType(SERVICE.av)?.actions.includes('Stop')),
      pause: Boolean(byType(SERVICE.av)?.actions.includes('Pause')),
      runBrowser: Boolean(byType(SERVICE.mainTv)?.actions.includes('RunBrowser'))
    }
  };
}

function discoverSsdp(localIP, timeoutMs = 4500) {
  if (!isPrivateIPv4(localIP)) return Promise.reject(new Error('A private LAN IPv4 is required for Samsung discovery'));
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const responses = [];
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      try { socket.close(); } catch {}
      resolve(responses);
    };
    socket.on('error', (err) => {
      if (finished) return;
      finished = true;
      try { socket.close(); } catch {}
      reject(err);
    });
    socket.on('message', (msg, remote) => {
      if (!isPrivateIPv4(remote.address)) return;
      const headers = parseSsdpHeaders(msg.toString('utf8'));
      const location = headers.location || '';
      if (!location) return;
      try { safeLegacyUrl(location, remote.address); } catch { return; }
      responses.push({
        ip: remote.address,
        location,
        st: headers.st || '',
        usn: headers.usn || '',
        server: headers.server || ''
      });
    });
    socket.bind({ address: localIP, port: 0, exclusive: true }, () => {
      const searches = [
        'ssdp:all',
        'urn:schemas-upnp-org:device:MediaRenderer:1',
        'urn:samsung.com:device:MainTVServer2:1'
      ];
      for (const st of searches) {
        const payload = Buffer.from(
          'M-SEARCH * HTTP/1.1\r\n' +
          'HOST: 239.255.255.250:1900\r\n' +
          'MAN: "ssdp:discover"\r\n' +
          'MX: 2\r\n' +
          'ST: ' + st + '\r\n\r\n'
        );
        socket.send(payload, SSDP_PORT, SSDP_HOST);
      }
      setTimeout(done, timeoutMs);
    });
  });
}

async function discoverFleet(localIP, timeoutMs = 4500) {
  const responses = await discoverSsdp(localIP, timeoutMs);
  const unique = new Map();
  for (const item of responses) unique.set(item.ip + '|' + item.location, item);
  const descriptions = [];
  for (const item of unique.values()) {
    const device = await hydrateDescription(item.ip, item.location, item);
    if (device) descriptions.push(device);
  }

  const groups = new Map();
  for (const d of descriptions) {
    if (!groups.has(d.ip)) groups.set(d.ip, []);
    groups.get(d.ip).push(d);
  }

  const merged = [];
  for (const [ip, group] of groups.entries()) {
    const services = [];
    const seenServices = new Set();
    for (const d of group) {
      for (const svc of d.services || []) {
        const key = svc.serviceType + '|' + svc.controlURL;
        if (seenServices.has(key)) continue;
        seenServices.add(key);
        services.push(svc);
      }
    }
    const byType = (type) => services.find((svc) => svc.serviceType === type);
    const identity = group.find((d) => d.modelName) || group[0];
    const deviceTypes = [...new Set(group.map((d) => d.deviceType).filter(Boolean))];
    merged.push({
      ip,
      location: identity.location,
      locations: [...new Set(group.map((d) => d.location))],
      friendlyName: group.find((d) => d.friendlyName && !/^Samsung TV$/i.test(d.friendlyName))?.friendlyName || identity.friendlyName,
      modelName: identity.modelName,
      modelDescription: identity.modelDescription,
      udn: identity.udn,
      productCap: group.find((d) => d.productCap)?.productCap || identity.productCap,
      deviceType: identity.deviceType,
      deviceTypes,
      server: identity.server,
      services,
      capabilities: {
        mediaRenderer: deviceTypes.includes('urn:schemas-upnp-org:device:MediaRenderer:1'),
        avTransport: Boolean(byType(SERVICE.av)),
        renderingControl: Boolean(byType(SERVICE.rendering)),
        connectionManager: Boolean(byType(SERVICE.connection)),
        mainTVAgent2: Boolean(byType(SERVICE.mainTv)),
        setAVTransportURI: Boolean(byType(SERVICE.av)?.actions.includes('SetAVTransportURI')),
        play: Boolean(byType(SERVICE.av)?.actions.includes('Play')),
        stop: Boolean(byType(SERVICE.av)?.actions.includes('Stop')),
        pause: Boolean(byType(SERVICE.av)?.actions.includes('Pause')),
        runBrowser: Boolean(byType(SERVICE.mainTv)?.actions.includes('RunBrowser'))
      }
    });
  }

  return merged.sort((a, b) =>
    a.ip.localeCompare(b.ip, undefined, { numeric: true })
  );
}

function serviceFor(tv, type) {
  return (tv?.services || []).find((s) => s.serviceType === type) || null;
}

function soapRequest(tv, serviceType, action, args = {}, timeoutMs = 5000) {
  const svc = serviceFor(tv, serviceType);
  if (!svc?.controlURL) return Promise.resolve({ ok: false, error: 'Service control URL unavailable', statusCode: 0 });
  let u;
  try { u = safeLegacyUrl(svc.controlURL, tv.ip); } catch (err) {
    return Promise.resolve({ ok: false, error: err.message, statusCode: 0 });
  }
  const argXml = Object.entries(args).map(([key, value]) =>
    '<' + key + '>' + xmlEscape(value) + '</' + key + '>'
  ).join('');
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body><u:' + action + ' xmlns:u="' + serviceType + '">' +
    argXml + '</u:' + action + '></s:Body></s:Envelope>';

  return new Promise((resolve) => {
    const req = http.request(u, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPACTION: '"' + serviceType + '#' + action + '"',
        'User-Agent': 'DLNADOC/1.50 SEC_HHP_StreamDBC/1.0',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (responseBody.length < 512 * 1024) responseBody += chunk; });
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          statusCode: res.statusCode || 0,
          body: responseBody,
          errorCode: tag(responseBody, 'errorCode'),
          errorDescription: tag(responseBody, 'errorDescription')
        });
      });
    });
    req.on('error', (err) => resolve({ ok: false, statusCode: 0, body: '', error: err.message }));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('SOAP timeout')));
    req.write(body);
    req.end();
  });
}

async function getTVState(tv) {
  const result = { ip: tv.ip, transport: '', volume: null, muted: null, errors: [] };
  const av = serviceFor(tv, SERVICE.av);
  if (av?.actions.includes('GetTransportInfo')) {
    const r = await soapRequest(tv, SERVICE.av, 'GetTransportInfo', { InstanceID: 0 });
    if (r.ok) result.transport = tag(r.body, 'CurrentTransportState');
    else result.errors.push('transport:' + (r.errorCode || r.error || r.statusCode));
  }
  const rc = serviceFor(tv, SERVICE.rendering);
  if (rc?.actions.includes('GetVolume')) {
    const r = await soapRequest(tv, SERVICE.rendering, 'GetVolume', { InstanceID: 0, Channel: 'Master' });
    if (r.ok) result.volume = Number(tag(r.body, 'CurrentVolume'));
    else result.errors.push('volume:' + (r.errorCode || r.error || r.statusCode));
  }
  if (rc?.actions.includes('GetMute')) {
    const r = await soapRequest(tv, SERVICE.rendering, 'GetMute', { InstanceID: 0, Channel: 'Master' });
    if (r.ok) result.muted = tag(r.body, 'CurrentMute') === '1';
    else result.errors.push('mute:' + (r.errorCode || r.error || r.statusCode));
  }
  return result;
}

async function runTVAction(tv, action, value) {
  switch (action) {
    case 'play-url': {
      const u = new URL(String(value || ''));
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Media URL must be HTTP(S)');
      const set = await soapRequest(tv, SERVICE.av, 'SetAVTransportURI', {
        InstanceID: 0, CurrentURI: u.toString(), CurrentURIMetaData: ''
      });
      if (!set.ok) return set;
      return soapRequest(tv, SERVICE.av, 'Play', { InstanceID: 0, Speed: 1 });
    }
    case 'play':
      return soapRequest(tv, SERVICE.av, 'Play', { InstanceID: 0, Speed: 1 });
    case 'pause':
      return soapRequest(tv, SERVICE.av, 'Pause', { InstanceID: 0 });
    case 'stop':
      return soapRequest(tv, SERVICE.av, 'Stop', { InstanceID: 0 });
    case 'mute':
      return soapRequest(tv, SERVICE.rendering, 'SetMute', { InstanceID: 0, Channel: 'Master', DesiredMute: value ? 1 : 0 });
    case 'volume': {
      const volume = Math.max(0, Math.min(100, Number(value)));
      if (!Number.isFinite(volume)) throw new Error('Volume must be numeric');
      return soapRequest(tv, SERVICE.rendering, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: Math.round(volume) });
    }
    case 'open-browser': {
      const u = new URL(String(value || ''));
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Browser URL must be HTTP(S)');
      return soapRequest(tv, SERVICE.mainTv, 'RunBrowser', { BrowserURL: u.toString() });
    }
    default:
      throw new Error('Unsupported Samsung TV action');
  }
}

module.exports = {
  discoverFleet,
  getTVState,
  runTVAction
};
