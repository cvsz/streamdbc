const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, dialog, shell, powerSaveBlocker, safeStorage, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const { discoverFleet, getTVState, runTVAction } = require('./samsung-fleet');

const electronSessionRoot = path.join(os.tmpdir(), 'StreamDBC', 'electron-session');
try {
  fs.mkdirSync(electronSessionRoot, { recursive: true });
  app.setPath('sessionData', electronSessionRoot);
  app.commandLine.appendSwitch('disk-cache-dir', path.join(electronSessionRoot, 'Cache'));
} catch (err) {
  console.warn('Unable to configure writable Electron session cache:', err.message);
}

let mainWindow = null;
let tray = null;
let playerWindow = null;
let settings = {
  serverUrl: 'http://127.0.0.1:8081',
  autoStart: false,
  notifications: true,
  minimizeToTray: true,
  serverUrlSaved: false,
  workspacePath: '',
  cloudflareHostname: 'ztv.zeaz.dev',
  cloudflareAutoUpdate: false
};

const STREAMDBC_SERVER_PORT = 1935;
let apiKey = '';
let cloudflareToken = '';
let serverProcess = null;
let serverRuntimeLastError = '';
let samsungFleet = [];


function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function getCredentialPath() {
  return path.join(app.getPath('userData'), 'credentials.json');
}

function getRuntimeSecretPath() {
  return path.join(app.getPath('userData'), 'runtime-secret.json');
}

function getCloudflareCredentialPath() {
  return path.join(app.getPath('userData'), 'cloudflare-credentials.json');
}

function loadCloudflareToken() {
  try {
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(getCloudflareCredentialPath())) return '';
    const payload = JSON.parse(fs.readFileSync(getCloudflareCredentialPath(), 'utf8'));
    if (payload.version !== 1 || typeof payload.token !== 'string') return '';
    return safeStorage.decryptString(Buffer.from(payload.token, 'base64'));
  } catch {
    console.error('Failed to load encrypted Cloudflare token');
    return '';
  }
}

function saveCloudflareToken(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    try { fs.rmSync(getCloudflareCredentialPath(), { force: true }); } catch {}
    cloudflareToken = '';
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable');
  const encrypted = safeStorage.encryptString(normalized).toString('base64');
  fs.writeFileSync(getCloudflareCredentialPath(), JSON.stringify({ version: 1, token: encrypted }), { mode: 0o600 });
  cloudflareToken = normalized;
}

function getOrCreateRuntimeJWTSecret() {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows credential encryption is unavailable');
  }
  try {
    if (fs.existsSync(getRuntimeSecretPath())) {
      const payload = JSON.parse(fs.readFileSync(getRuntimeSecretPath(), 'utf8'));
      if (payload.version === 1 && typeof payload.secret === 'string') {
        return safeStorage.decryptString(Buffer.from(payload.secret, 'base64'));
      }
    }
  } catch {
    console.error('Failed to load runtime JWT secret; generating a replacement');
  }
  const secret = crypto.randomBytes(48).toString('base64url');
  const encrypted = safeStorage.encryptString(secret).toString('base64');
  fs.writeFileSync(getRuntimeSecretPath(), JSON.stringify({ version: 1, secret: encrypted }), { mode: 0o600 });
  return secret;
}

function publicSettings() {
  return { ...settings, hasApiKey: Boolean(apiKey), hasCloudflareToken: Boolean(cloudflareToken) };
}

function loadAPIKey() {
  try {
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(getCredentialPath())) return '';
    const payload = JSON.parse(fs.readFileSync(getCredentialPath(), 'utf8'));
    if (payload.version !== 1 || typeof payload.apiKey !== 'string') return '';
    return safeStorage.decryptString(Buffer.from(payload.apiKey, 'base64'));
  } catch {
    console.error('Failed to load encrypted API key');
    return '';
  }
}

function saveAPIKey(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    try { fs.rmSync(getCredentialPath(), { force: true }); } catch {}
    apiKey = '';
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable');
  const encrypted = safeStorage.encryptString(normalized).toString('base64');
  fs.writeFileSync(getCredentialPath(), JSON.stringify({ version: 1, apiKey: encrypted }), { mode: 0o600 });
  apiKey = normalized;
}

function normalizeServerUrl(value) {
  const parsed = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Server URL must be HTTP(S) without embedded credentials');
  }
  return parsed.toString().replace(/\/$/, '');
}

async function openTrustedExternal(value) {
  const parsed = new URL(String(value || ''));
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    throw new Error('External URL is not allowed');
  }
  await shell.openExternal(parsed.toString());
}

function loadSettings() {
  try {
    if (fs.existsSync(getSettingsPath())) {
      const data = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'));
      if (typeof data.apiKey === 'string' && data.apiKey) {
        apiKey = data.apiKey;
        delete data.apiKey;
        saveAPIKey(apiKey);
        fs.writeFileSync(getSettingsPath(), JSON.stringify(data, null, 2), { mode: 0o600 });
      }
      settings = { ...settings, ...data };
    }
    if (!apiKey) apiKey = loadAPIKey();
    if (!cloudflareToken) cloudflareToken = loadCloudflareToken();
  } catch {
    console.error('Failed to load settings');
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), { mode: 0o600 });
  } catch {
    console.error('Failed to save settings');
  }
}


function isPrivateIPv4(address) {
  const parts = String(address || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}

function getLanIPv4Candidates() {
  const candidates = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal || !isPrivateIPv4(entry.address)) continue;
      const virtual = /loopback|wsl|hyper-v|virtualbox|vmware|docker|tailscale|teredo|vEthernet/i.test(name);
      if (virtual) continue;
      const wifi = /wi-?fi|wireless|wlan/i.test(name);
      candidates.push({ name, address: entry.address, rank: wifi ? 0 : 1 });
    }
  }
  candidates.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return candidates;
}

function getLanIPv4() {
  return getLanIPv4Candidates()[0] || null;
}

function normalizeCloudflareHostname(value) {
  const hostname = String(value || '').trim().toLowerCase();
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) {
    throw new Error('Cloudflare hostname is invalid');
  }
  return hostname;
}

function deriveZoneName(hostname) {
  const normalized = normalizeCloudflareHostname(hostname);
  const labels = normalized.split('.');
  return labels.slice(-2).join('.');
}

function cloudflareRequest(method, route, body) {
  return new Promise((resolve) => {
    if (!cloudflareToken) {
      resolve({ ok: false, error: 'Cloudflare API token is not configured.' });
      return;
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request({
      protocol: 'https:',
      hostname: 'api.cloudflare.com',
      port: 443,
      path: `/client/v4${route}`,
      method,
      headers: {
        Authorization: `Bearer ${cloudflareToken}`,
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {})
      },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = null; }
        const success = res.statusCode >= 200 && res.statusCode < 300 && parsed?.success !== false;
        resolve({ ok: success, statusCode: res.statusCode, body: parsed, error: success ? null : (parsed?.errors?.[0]?.message || 'Cloudflare API request failed') });
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => req.destroy(new Error('Cloudflare API request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function updateCloudflareLanDNS() {
  let hostname;
  try {
    hostname = normalizeCloudflareHostname(settings.cloudflareHostname || '');
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const lan = getLanIPv4();
  if (!lan) return { ok: false, error: 'No physical private LAN IPv4 address was detected.' };
  const zoneName = deriveZoneName(hostname);

  const zones = await cloudflareRequest('GET', `/zones?name=${encodeURIComponent(zoneName)}&status=active&per_page=50`);
  if (!zones.ok) return zones;
  const zone = zones.body?.result?.find((item) => item.name === zoneName);
  if (!zone?.id) return { ok: false, error: `Cloudflare zone not found: ${zoneName}` };

  const records = await cloudflareRequest('GET', `/zones/${zone.id}/dns_records?type=A&name=${encodeURIComponent(hostname)}&per_page=100`);
  if (!records.ok) return records;
  const record = records.body?.result?.find((item) => item.type === 'A' && item.name === hostname);

  let result;
  if (record?.id) {
    if (record.content === lan.address && record.proxied === false) {
      return { ok: true, unchanged: true, hostname, address: lan.address, interface: lan.name, recordId: record.id };
    }
    result = await cloudflareRequest('PUT', `/zones/${zone.id}/dns_records/${record.id}`, {
      type: 'A',
      name: hostname,
      content: lan.address,
      ttl: 1,
      proxied: false,
      comment: 'Managed by StreamDBC Windows Control Panel'
    });
  } else {
    result = await cloudflareRequest('POST', `/zones/${zone.id}/dns_records`, {
      type: 'A',
      name: hostname,
      content: lan.address,
      ttl: 1,
      proxied: false,
      comment: 'Managed by StreamDBC Windows Control Panel'
    });
  }
  if (!result.ok) return result;
  return {
    ok: true,
    hostname,
    address: lan.address,
    interface: lan.name,
    recordId: result.body?.result?.id || record?.id || ''
  };
}

function localTVUrl(pathname = '/tv/') {
  const lan = getLanIPv4();
  const address = lan?.address || '127.0.0.1';
  return `http://${address}:8081${pathname}`;
}

function createNotification(title, body) {
  if (!settings.notifications) return;
  if (!Notification.isSupported()) return;
  try {
    const notification = new Notification({ title, body });
    notification.show();
  } catch (err) {
    console.error('Notification failed:', err);
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'StreamDBC Control Panel',
    ...(fs.existsSync(path.join(__dirname, 'assets', 'apps.ico')) ? { icon: path.join(__dirname, 'assets', 'apps.ico') } : (fs.existsSync(path.join(__dirname, 'assets', 'icon.png')) ? { icon: path.join(__dirname, 'assets', 'icon.png') } : {})),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      sandbox: true
    },
    titleBarStyle: 'native',
    autoHideMenuBar: false
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  mainWindow.on('close', (event) => {
    if (settings.minimizeToTray && !app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('show', () => {
    if (process.platform === 'darwin' && tray && typeof tray.setHighlightMode === 'function') {
      tray.setHighlightMode('always');
    }
  });

  mainWindow.on('hide', () => {
    if (process.platform === 'darwin' && tray && typeof tray.setHighlightMode === 'function') {
      tray.setHighlightMode('never');
    }
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load:', errorDescription);
  });
}

function createPlayerWindow(streamId) {
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.focus();
    return;
  }

  playerWindow = new BrowserWindow({
    width: 960,
    height: 600,
    minWidth: 640,
    minHeight: 400,
    title: `STREMDBC Player - ${streamId}`,
    parent: mainWindow,
    modal: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      sandbox: true
    }
  });

  const playerUrl = `file://${path.join(__dirname, 'player.html')}?stream=${encodeURIComponent(streamId)}&server=${encodeURIComponent(settings.serverUrl)}`;
  playerWindow.loadURL(playerUrl);
  playerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  playerWindow.on('closed', () => {
    playerWindow = null;
  });
}


function resolveServerRuntime() {
  const candidates = [];
  if (app.isPackaged) {
    candidates.push({
      source: 'bundled',
      executable: path.join(process.resourcesPath, 'server-runtime', 'stremdbc.exe'),
      config: path.join(process.resourcesPath, 'server-runtime', 'configs', 'samsung-f5500.yaml'),
      cwd: path.join(process.resourcesPath, 'server-runtime')
    });
  }
  const workspace = String(settings.workspacePath || '').trim();
  if (workspace) {
    candidates.push({
      source: 'workspace',
      executable: path.join(workspace, 'stremdbc.exe'),
      config: path.join(workspace, 'configs', 'samsung-f5500.yaml'),
      cwd: workspace
    });
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const installed = path.join(process.env.LOCALAPPDATA, 'StreamDBC');
    candidates.push({
      source: 'localappdata',
      executable: path.join(installed, 'stremdbc.exe'),
      config: workspace ? path.join(workspace, 'configs', 'samsung-f5500.yaml') : '',
      cwd: installed
    });
  }
  return candidates.find((candidate) =>
    fs.existsSync(candidate.executable) &&
    candidate.config &&
    fs.existsSync(candidate.config)
  ) || null;
}


function findOnPath(executable) {
  const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathEntries) {
    const candidate = path.join(dir, executable);
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function resolveFFmpegRuntime() {
  const candidates = [];
  if (app.isPackaged) {
    candidates.push({ source: 'bundled', path: path.join(process.resourcesPath, 'server-runtime', 'ffmpeg', 'ffmpeg.exe') });
  }
  const workspace = String(settings.workspacePath || '').trim();
  if (workspace) {
    candidates.push({ source: 'workspace-bundled', path: path.join(workspace, 'client', 'vendor', 'ffmpeg', 'ffmpeg.exe') });
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const managedRoot = path.join(process.env.LOCALAPPDATA, 'StreamDBC', 'FFmpeg');
    if (fs.existsSync(managedRoot)) {
      const dirs = fs.readdirSync(managedRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse();
      for (const dir of dirs) {
        candidates.push({ source: 'localappdata', path: path.join(managedRoot, dir, 'ffmpeg.exe') });
      }
    }
  }
  const onPath = findOnPath('ffmpeg.exe') || findOnPath('ffmpeg');
  if (onPath) candidates.push({ source: 'system-path', path: onPath });
  return candidates.find((candidate) => fs.existsSync(candidate.path)) || null;
}

function captureProcess(executable, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const limit = 256 * 1024;
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-limit); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-limit); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, exitCode: code, stdout, stderr });
    });
  });
}

async function getFFmpegInfo() {
  const resolved = resolveFFmpegRuntime();
  if (!resolved) {
    return { ok: false, source: '', path: '', version: '', h264: false, aac: false, hls: false, rtmp: false, error: 'FFmpeg not found.' };
  }
  const [versionRun, encodersRun, muxersRun, protocolsRun] = await Promise.all([
    captureProcess(resolved.path, ['-version']),
    captureProcess(resolved.path, ['-hide_banner', '-encoders']),
    captureProcess(resolved.path, ['-hide_banner', '-muxers']),
    captureProcess(resolved.path, ['-hide_banner', '-protocols'])
  ]);
  const versionText = (versionRun.stdout || versionRun.stderr || '').split(/\r?\n/)[0].trim();
  const encoders = encodersRun.stdout + '\n' + encodersRun.stderr;
  const muxers = muxersRun.stdout + '\n' + muxersRun.stderr;
  const protocols = protocolsRun.stdout + '\n' + protocolsRun.stderr;
  const result = {
    ok: versionRun.ok && /libx264/i.test(encoders) && /\baac\b/i.test(encoders) && /\bhls\b/i.test(muxers) && /(^|\s)rtmp(\s|$)/im.test(protocols),
    source: resolved.source,
    path: resolved.path,
    version: versionText,
    h264: /libx264/i.test(encoders),
    aac: /\baac\b/i.test(encoders),
    hls: /\bhls\b/i.test(muxers),
    rtmp: /(^|\s)rtmp(\s|$)/im.test(protocols)
  };
  if (!result.ok) result.error = 'FFmpeg is missing one or more required capabilities: libx264, AAC, HLS, RTMP.';
  return result;
}

async function getServerRuntimeStatus() {
  const health = await requestJson('GET', settings.serverUrl, '/health');
  const runtime = resolveServerRuntime();
  const managedPid = serverProcess && !serverProcess.killed ? serverProcess.pid : null;
  return {
    running: Boolean(health && health.ok && health.body?.status === 'healthy'),
    managedPid,
    executable: runtime?.executable || '',
    config: runtime?.config || '',
    source: runtime?.source || '',
    lastError: serverRuntimeLastError
  };
}

async function waitForServerHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await requestJson('GET', settings.serverUrl, '/health');
    if (health?.ok && health.body?.status === 'healthy') return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function startServerRuntime() {
  if (process.platform !== 'win32') return { ok: false, error: 'Server runtime control is Windows-only.' };
  const current = await getServerRuntimeStatus();
  if (current.running) return { ok: true, alreadyRunning: true, status: current };

  const runtime = resolveServerRuntime();
  if (!runtime) {
    return { ok: false, error: 'No usable stremdbc.exe + samsung-f5500.yaml runtime was found. Select the repository or install the bundled Control Panel build.' };
  }

  let jwtSecret;
  try {
    jwtSecret = process.env.STREMDBC_JWT_SECRET || getOrCreateRuntimeJWTSecret();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const runtimeApiKey = apiKey || process.env.STREMDBC_API_KEY || '';
  if (!runtimeApiKey) {
    return { ok: false, error: 'Set the API key in Settings before starting the bundled StreamDBC server.' };
  }

  serverRuntimeLastError = '';
  const ffmpeg = resolveFFmpegRuntime();
  if (!ffmpeg) return { ok: false, error: 'FFmpeg was not found. Reinstall the Control Panel or run the FFmpeg preparation step.' };
  serverProcess = spawn(runtime.executable, ['-config', runtime.config], {
    cwd: runtime.cwd,
    windowsHide: true,
    detached: false,
    stdio: 'ignore',
    env: {
      ...process.env,
      STREMDBC_JWT_SECRET: jwtSecret,
      STREMDBC_API_KEY: runtimeApiKey,
      STREMDBC_FFMPEG_PATH: ffmpeg.path,
      PATH: `${path.dirname(ffmpeg.path)}${path.delimiter}${process.env.PATH || ''}`
    }
  });
  serverProcess.once('error', (err) => {
    serverRuntimeLastError = err.message;
    serverProcess = null;
    updateTrayMenu();
  });
  serverProcess.once('exit', (code, signal) => {
    if (code && code !== 0) serverRuntimeLastError = `stremdbc.exe exited with code ${code}`;
    if (signal) serverRuntimeLastError = `stremdbc.exe exited after signal ${signal}`;
    serverProcess = null;
    updateTrayMenu();
  });

  const healthy = await waitForServerHealth();
  updateTrayMenu();
  if (!healthy) {
    return { ok: false, error: serverRuntimeLastError || 'StreamDBC server did not become healthy before timeout.' };
  }
  createNotification('StreamDBC', 'Server is running on port 8081');
  return { ok: true, status: await getServerRuntimeStatus() };
}

async function stopServerRuntime() {
  const health = await requestJson('GET', settings.serverUrl, '/health');
  if (!health?.ok) {
    if (serverProcess && !serverProcess.killed) {
      try { serverProcess.kill(); } catch {}
      serverProcess = null;
    }
    updateTrayMenu();
    return { ok: true, alreadyStopped: true, status: await getServerRuntimeStatus() };
  }

  if (serverProcess && !serverProcess.killed) {
    try {
      serverProcess.kill();
    } catch (err) {
      return { ok: false, error: err.message };
    }
    serverProcess = null;
  } else {
    const workspace = String(settings.workspacePath || '').trim();
    if (workspace) {
      const scriptPath = path.join(workspace, 'scripts', 'windows', 'samsung-tv-stop.ps1');
      if (fs.existsSync(scriptPath)) {
        await runSamsungWorkspaceTask('stop');
      }
    }
    return { ok: false, error: 'Server is running but was not launched by this Control Panel. Stop that process from its owning session or select the StreamDBC workspace.' };
  }

  updateTrayMenu();
  return { ok: true, status: await getServerRuntimeStatus() };
}

async function restartServerRuntime() {
  const status = await getServerRuntimeStatus();
  if (status.running && status.managedPid) {
    const stopped = await stopServerRuntime();
    if (!stopped.ok) return stopped;
    await new Promise((resolve) => setTimeout(resolve, 750));
  } else if (status.running) {
    return { ok: false, error: 'The running StreamDBC server is not managed by this Control Panel. Stop it first, then use Start Server.' };
  }
  return startServerRuntime();
}

function openLocalControlPanel() {
  const target = new URL('/dashboard/', settings.serverUrl).toString();
  return shell.openExternal(target);
}

function openLocalTVPage() {
  return shell.openExternal(localTVUrl('/tv/'));
}

function updateTrayMenu() {
  if (!tray) return;
  const running = Boolean(serverProcess && !serverProcess.killed);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open StreamDBC Control Panel', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: 'Open Web Dashboard', click: () => { void openLocalControlPanel(); } },
    { label: 'Open Samsung TV Page', click: () => { void openLocalTVPage(); } },
    { type: 'separator' },
    { label: running ? 'Server Running' : 'Start Server', enabled: !running, click: () => { void startServerRuntime(); } },
    { label: 'Restart Server', click: () => { void restartServerRuntime(); } },
    { label: 'Stop Server', enabled: running, click: () => { void stopServerRuntime(); } },
    { type: 'separator' },
    { label: 'Settings', click: () => { mainWindow?.show(); mainWindow?.webContents.send('open-settings'); } },
    { type: 'separator' },
    {
      label: 'Quit Control Panel',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(contextMenu);
}

function createTray() {
  const appIconPath = path.join(__dirname, 'assets', 'apps.ico');
  const pngPath = path.join(__dirname, 'assets', 'tray-icon.png');
  const svgPath = path.join(__dirname, 'assets', 'tray-icon.svg');
  let trayImage = null;
  if (fs.existsSync(appIconPath)) {
    trayImage = nativeImage.createFromPath(appIconPath);
  } else if (fs.existsSync(pngPath)) {
    trayImage = nativeImage.createFromPath(pngPath);
  } else if (fs.existsSync(svgPath)) {
    const svg = fs.readFileSync(svgPath);
    trayImage = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${svg.toString('base64')}`);
  }
  if (!trayImage || trayImage.isEmpty()) {
    const fallbackSvg = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">',
      '<rect x="2" y="5" width="28" height="22" rx="5" fill="#202633"/>',
      '<rect x="5" y="8" width="22" height="16" rx="3" fill="#667eea"/>',
      '<polygon points="13,11 13,21 22,16" fill="#ffffff"/>',
      '</svg>'
    ].join('');
    trayImage = nativeImage.createFromDataURL(
      'data:image/svg+xml;base64,' + Buffer.from(fallbackSvg).toString('base64')
    );
  }
  if (!trayImage || trayImage.isEmpty()) {
    console.error('System tray icon could not be created');
    return;
  }

  tray = new Tray(trayImage.resize({ width: 16, height: 16 }));
  tray.setToolTip('StreamDBC Server & Control Panel');
  updateTrayMenu();

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
      }
    }
  });
}

function createMenu() {
  const template = [
    {
      label: 'STREMDBC',
      submenu: [
        {
          label: 'About',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About STREMDBC Client',
              message: `StreamDBC Control Panel v${app.getVersion()}`,
              detail: 'Streaming management control plane GUI client\n\nConnects to STREMDBC server for stream management, monitoring, and playback.'
            });
          }
        },
        { type: 'separator' },
        {
          label: 'Preferences',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            mainWindow?.webContents.send('open-settings');
          }
        },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            app.isQuitting = true;
            app.quit();
          }
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Stream',
      submenu: [
        {
          label: 'Create Stream',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            mainWindow?.webContents.send('create-stream');
          }
        },
        { type: 'separator' },
        {
          label: 'Push RTMP Stream',
          click: () => {
            mainWindow?.webContents.send('push-rtmp');
          }
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Documentation',
          click: () => {
            openTrustedExternal('https://github.com/cvsz/streamdbc/blob/main/docs/USER-MANUAL.md');
          }
        },
        {
          label: 'Report Issue',
          click: () => {
            openTrustedExternal('https://github.com/cvsz/streamdbc/issues');
          }
        },
        { type: 'separator' },
        {
          label: 'About',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About',
              message: `StreamDBC Control Panel v${app.getVersion()}`
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

async function checkForUpdates() {
  if (!mainWindow) return;
  try {
    const url = 'https://api.github.com/repos/cvsz/streamdbc/releases/latest';
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const release = JSON.parse(data);
          const latestVersion = release.tag_name?.replace('v', '');
          if (latestVersion && latestVersion !== app.getVersion()) {
            mainWindow.webContents.send('update-available', {
              version: latestVersion,
              url: release.html_url
            });
          } else {
            mainWindow.webContents.send('update-checked');
          }
        } catch (err) {
          mainWindow.webContents.send('update-checked');
        }
      });
    });
    req.on('error', () => {
      mainWindow.webContents.send('update-checked');
    });
    req.setTimeout(10000, () => {
      req.destroy();
      mainWindow.webContents.send('update-checked');
    });
  } catch (err) {
    mainWindow.webContents.send('update-checked');
  }
}

async function fetchStreamInfo(serverUrl, streamId) {
  serverUrl = normalizeServerUrl(serverUrl);
  try {
    const url = new URL(`/api/v1/streams/${encodeURIComponent(streamId)}`, serverUrl);
    const req = http.get(url.toString(), {
      headers: apiKey ? { 'X-API-Key': apiKey } : {}
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          return JSON.parse(data);
        } catch (err) {
          return null;
        }
      });
    });
    req.on('error', () => null);
    req.setTimeout(5000, () => req.destroy());
  } catch (err) {
    return null;
  }
}

async function fetchStreams(serverUrl) {
  serverUrl = normalizeServerUrl(serverUrl);
  try {
    const url = new URL('/api/v1/streams', serverUrl);
    return new Promise((resolve) => {
      http.get(url.toString(), {
        headers: apiKey ? { 'X-API-Key': apiKey } : {}
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            resolve(null);
          }
        });
      }).on('error', () => resolve(null));
    });
  } catch (err) {
    return null;
  }
}

async function fetchHealth(serverUrl) {
  serverUrl = normalizeServerUrl(serverUrl);
  try {
    const url = new URL('/health', serverUrl);
    return new Promise((resolve) => {
      http.get(url.toString(), {
        headers: apiKey ? { 'X-API-Key': apiKey } : {}
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            resolve(null);
          }
        });
      }).on('error', () => resolve(null));
    });
  } catch (err) {
    return null;
  }
}

async function createStream(serverUrl, streamId, name) {
  serverUrl = normalizeServerUrl(serverUrl);
  try {
    const url = new URL('/api/v1/streams', serverUrl);
    return new Promise((resolve) => {
      const req = http.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'X-API-Key': apiKey } : {})
        }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            resolve({ error: 'Failed to parse response' });
          }
        });
      });
      req.on('error', (err) => resolve({ error: err.message }));
      req.write(JSON.stringify({ id: streamId, name }));
      req.end();
    });
  } catch (err) {
    return { error: err.message };
  }
}

async function deleteStream(serverUrl, streamId) {
  serverUrl = normalizeServerUrl(serverUrl);
  try {
    const url = new URL(`/api/v1/streams/${encodeURIComponent(streamId)}`, serverUrl);
    return new Promise((resolve) => {
      const req = http.request(url, {
        method: 'DELETE',
        headers: {
          ...(apiKey ? { 'X-API-Key': apiKey } : {})
        }
      }, (res) => {
        resolve({ success: res.statusCode === 200 || res.statusCode === 204 });
      });
      req.on('error', (err) => resolve({ error: err.message }));
      req.end();
    });
  } catch (err) {
    return { error: err.message };
  }
}

function requestJson(method, serverUrl, route, body = undefined) {
  serverUrl = normalizeServerUrl(serverUrl);
  return new Promise((resolve) => {
    const url = new URL(route, serverUrl);
    const client = url.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = client.request(url, {
      method,
      headers: {
        'Accept': 'application/json',
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': String(payload.length)
        } : {}),
        ...(apiKey ? { 'X-API-Key': apiKey } : {})
      },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let body = null;
        try { body = data ? JSON.parse(data) : {}; } catch { body = { raw: data }; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, statusCode: res.statusCode, body });
        } else {
          resolve({ ok: false, statusCode: res.statusCode, body });
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function fetchSamsungStatus(serverUrl) {
  return requestJson('GET', serverUrl, '/api/v1/tv/status');
}

async function samsungAction(serverUrl, action) {
  if (!['start', 'stop', 'restart'].includes(action)) {
    return { ok: false, error: 'Unsupported Samsung action' };
  }
  return requestJson('POST', serverUrl, `/api/v1/tv/${action}`, {});
}

function samsungPublicUrl(kind) {
  let hostname = 'ztv.zeaz.dev';
  try { hostname = normalizeCloudflareHostname(settings.cloudflareHostname || hostname); } catch {}
  const urls = {
    tv: `http://${hostname}:8081/tv/`,
    ping: `http://${hostname}:8081/tv/ping`,
    hls: `http://${hostname}:8081/tv/live/index.m3u8`,
    fallback: localTVUrl('/tv/')
  };
  return urls[kind] || null;
}

async function runSamsungWorkspaceTask(task) {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Windows builder tasks are available only on Windows.' };
  }
  const workspace = String(settings.workspacePath || '').trim();
  const bundledRoot = app.isPackaged ? path.join(process.resourcesPath, 'server-runtime') : '';
  if (!workspace && task !== 'doctor') return { ok: false, error: 'Select the StreamDBC workspace first.' };

  const allowed = {
    doctor: { file: 'samsung-tv-doctor.ps1', args: ['-Port', '8081'] },
    rebuild: { file: 'rebuild-samsung-server.ps1', args: ['-Port', '8081'] },
    start: { file: 'samsung-tv-start.ps1', args: ['-Port', '8081'] },
    stop: { file: 'samsung-tv-stop.ps1', args: ['-Port', '8081'] },
    test: { file: 'samsung-tv-test.ps1', args: ['-Port', '8081'] },
    usb: { file: 'build-samsung-f5500-usb.ps1', args: [] }
  };
  const spec = allowed[task];
  if (!spec) return { ok: false, error: 'Unsupported builder task.' };

  const taskRoot = workspace || bundledRoot;
  const scriptRoot = path.resolve(taskRoot, 'scripts', 'windows');
  const scriptPath = path.resolve(scriptRoot, spec.file);
  if (!scriptPath.startsWith(scriptRoot + path.sep) || !fs.existsSync(scriptPath)) {
    return { ok: false, error: `Required script not found: ${scriptPath}` };
  }
  const ffmpeg = resolveFFmpegRuntime();
  const taskArgs = [...spec.args];
  if (task === 'doctor' && ffmpeg) {
    taskArgs.push('-FFmpegPath', ffmpeg.path, '-RequireVMix');
  }

  let taskJWTSecret = process.env.STREMDBC_JWT_SECRET || '';
  if (task === 'doctor' && !taskJWTSecret) {
    try { taskJWTSecret = getOrCreateRuntimeJWTSecret(); } catch {}
  }
  const taskAPIKey = process.env.STREMDBC_API_KEY || apiKey || '';

  return new Promise((resolve) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      ...taskArgs
    ], {
      cwd: taskRoot,
      windowsHide: true,
      env: {
        ...process.env,
        ...(taskJWTSecret ? { STREMDBC_JWT_SECRET: taskJWTSecret } : {}),
        ...(taskAPIKey ? { STREMDBC_API_KEY: taskAPIKey } : {}),
        ...(ffmpeg ? { STREMDBC_FFMPEG_PATH: ffmpeg.path, PATH: `${path.dirname(ffmpeg.path)}${path.delimiter}${process.env.PATH || ''}` } : {})
      }
    });

    let stdout = '';
    let stderr = '';
    const limit = 128 * 1024;
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-limit);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-limit);
    });
    child.on('error', (err) => resolve({ ok: false, error: err.message, stdout, stderr }));
    child.on('close', (code) => resolve({
      ok: code === 0,
      exitCode: code,
      stdout,
      stderr,
      error: code === 0 ? null : `Task exited with code ${code}`
    }));
  });
}

async function getAuthToken(serverUrl, streamId, action) {
  serverUrl = normalizeServerUrl(serverUrl);
  try {
    const url = new URL('/api/v1/auth/token', serverUrl);
    return new Promise((resolve) => {
      const req = http.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'X-API-Key': apiKey } : {})
        }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            resolve({ error: 'Failed to parse' });
          }
        });
      });
      req.on('error', (err) => resolve({ error: err.message }));
      req.write(JSON.stringify({ stream_id: streamId, action }));
      req.end();
    });
  } catch (err) {
    return { error: err.message };
  }
}

app.whenReady().then(() => {
  loadSettings();
  app.setName('StreamDBC Control Panel');
  app.setAppUserModelId('com.stremdbc.client');

  createMainWindow();
  createTray();
  createMenu();

  if (settings.cloudflareAutoUpdate && cloudflareToken) {
    updateCloudflareLanDNS().then((result) => {
      if (!result.ok) {
        console.error('Cloudflare LAN DNS update failed:', result.error || 'unknown error');
      } else if (!result.unchanged) {
        createNotification('StreamDBC DNS', `${result.hostname} → ${result.address}`);
      }
    });
  }

  powerSaveBlocker.start('prevent-display-sleep');

  const serverUrl = settings.serverUrl;
  mainWindow.webContents.send('settings-updated', publicSettings());

  setInterval(async () => {
    if (mainWindow && mainWindow.isVisible()) {
      const health = await fetchHealth(serverUrl);
      mainWindow.webContents.send('health-updated', health);
      const streams = await fetchStreams(serverUrl);
      mainWindow.webContents.send('streams-updated', streams);
    }
  }, 5000);

  mainWindow.webContents.send('settings-updated', publicSettings());
});

app.on('before-quit', () => {
  saveSettings();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (tray) {
      tray.destroy();
    }
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

ipcMain.handle('get-settings', () => publicSettings());

ipcMain.handle('save-settings', (event, newSettings) => {
  const next = { ...newSettings };
  const nextApiKey = typeof next.apiKey === 'string' ? next.apiKey.trim() : '';
  const nextCloudflareToken = typeof next.cloudflareToken === 'string' ? next.cloudflareToken.trim() : '';
  delete next.apiKey;
  delete next.cloudflareToken;
  if (next.serverUrl !== undefined) next.serverUrl = normalizeServerUrl(next.serverUrl);
  settings = { ...settings, ...next };
  if (nextApiKey) saveAPIKey(nextApiKey);
  if (nextCloudflareToken) saveCloudflareToken(nextCloudflareToken);
  saveSettings();
  return publicSettings();
});

ipcMain.handle('fetch-health', async (event, serverUrl) => {
  return await fetchHealth(serverUrl || settings.serverUrl);
});

ipcMain.handle('fetch-streams', async (event, serverUrl) => {
  return await fetchStreams(serverUrl || settings.serverUrl);
});

ipcMain.handle('create-stream', async (event, { serverUrl, streamId, name }) => {
  return await createStream(serverUrl || settings.serverUrl, streamId, name);
});

ipcMain.handle('delete-stream', async (event, { serverUrl, streamId }) => {
  return await deleteStream(serverUrl || settings.serverUrl, streamId);
});

ipcMain.handle('select-workspace', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const workspacePath = path.resolve(result.filePaths[0]);
  const expected = path.join(workspacePath, 'scripts', 'windows', 'rebuild-samsung-server.ps1');
  if (!fs.existsSync(expected)) {
    return { canceled: false, error: 'Selected folder is not a StreamDBC workspace.' };
  }
  settings.workspacePath = workspacePath;
  saveSettings();
  return { canceled: false, workspacePath };
});

ipcMain.handle('fetch-samsung-status', async (event, serverUrl) => {
  return await fetchSamsungStatus(serverUrl || settings.serverUrl);
});

ipcMain.handle('get-server-runtime-status', async () => {
  return await getServerRuntimeStatus();
});

ipcMain.handle('get-ffmpeg-info', async () => {
  return await getFFmpegInfo();
});

ipcMain.handle('server-runtime-action', async (event, action) => {
  if (action === 'start') return await startServerRuntime();
  if (action === 'stop') return await stopServerRuntime();
  if (action === 'restart') return await restartServerRuntime();
  return { ok: false, error: 'Unsupported server runtime action.' };
});

ipcMain.handle('open-local-dashboard', async () => {
  await openLocalControlPanel();
  return true;
});

ipcMain.handle('open-local-tv', async () => {
  await openLocalTVPage();
  return true;
});

ipcMain.handle('get-lan-ip', () => {
  const lan = getLanIPv4();
  return lan ? { ok: true, ...lan, tvUrl: localTVUrl('/tv/') } : { ok: false, error: 'No LAN IPv4 detected.' };
});

ipcMain.handle('update-cloudflare-dns', async () => {
  return await updateCloudflareLanDNS();
});

ipcMain.handle('samsung-fleet-discover', async () => {
  const candidates = getLanIPv4Candidates();
  if (!candidates.length) {
    return { ok: false, error: 'No physical private LAN IPv4 address was detected.', tvs: [] };
  }

  const merged = new Map();
  const diagnostics = [];
  for (const lan of candidates) {
    try {
      const discovered = await discoverFleet(lan.address);
      diagnostics.push({ interface: lan.name, localIP: lan.address, count: discovered.length });
      for (const tv of discovered) {
        if (!merged.has(tv.ip)) merged.set(tv.ip, tv);
      }
    } catch (err) {
      diagnostics.push({ interface: lan.name, localIP: lan.address, count: 0, error: err.message });
    }
  }

  samsungFleet = [...merged.values()].sort((a, b) =>
    a.ip.localeCompare(b.ip, undefined, { numeric: true })
  );

  const preferred = candidates.find((lan) => lan.address.startsWith('192.168.1.')) || candidates[0];
  return {
    ok: true,
    localIP: preferred.address,
    interface: preferred.name,
    tvs: samsungFleet,
    diagnostics
  };
});

ipcMain.handle('samsung-fleet-list', async () => ({
  ok: true,
  tvs: samsungFleet
}));

ipcMain.handle('samsung-fleet-status', async () => {
  const states = [];
  for (const tv of samsungFleet) {
    try {
      states.push(await getTVState(tv));
    } catch (err) {
      states.push({ ip: tv.ip, transport: '', volume: null, muted: null, errors: [err.message] });
    }
  }
  return { ok: true, states };
});

ipcMain.handle('samsung-fleet-action', async (event, data) => {
  const ip = String(data?.ip || '').trim();
  const tv = samsungFleet.find((item) => item.ip === ip);
  if (!tv) return { ok: false, error: 'TV is not in the current discovered Samsung fleet.' };
  try {
    const result = await runTVAction(tv, data?.action, data?.value);
    return { ...result, state: await getTVState(tv) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('samsung-fleet-action-all', async (event, data) => {
  const results = [];
  for (const tv of samsungFleet) {
    try {
      const result = await runTVAction(tv, data?.action, data?.value);
      results.push({ ip: tv.ip, ...result });
    } catch (err) {
      results.push({ ip: tv.ip, ok: false, error: err.message });
    }
  }
  return { ok: results.length > 0 && results.every((item) => item.ok), results };
});

ipcMain.handle('samsung-action', async (event, { serverUrl, action }) => {
  return await samsungAction(serverUrl || settings.serverUrl, action);
});

ipcMain.handle('run-samsung-task', async (event, task) => {
  return await runSamsungWorkspaceTask(task);
});

ipcMain.handle('open-samsung-url', async (event, kind) => {
  const target = samsungPublicUrl(kind);
  if (!target) throw new Error('Unsupported Samsung URL');
  await shell.openExternal(target);
  return true;
});

ipcMain.handle('get-auth-token', async (event, { serverUrl, streamId, action }) => {
  return await getAuthToken(serverUrl || settings.serverUrl, streamId, action);
});

ipcMain.handle('open-player', (event, streamId) => {
  createPlayerWindow(streamId);
});

ipcMain.handle('check-updates', () => {
  checkForUpdates();
});

ipcMain.handle('show-notification', (event, { title, body }) => {
  createNotification(title, body);
});

ipcMain.handle('select-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Video', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  return result;
});

ipcMain.handle('show-error', async (event, { title, message }) => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: String(title || 'Confirm'),
    message: String(message || 'Continue?'),
    buttons: ['Delete', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  });
  return result.response === 0;
});

ipcMain.handle('open-external', async (event, url) => {
  await openTrustedExternal(url);
  return true;
});

ipcMain.on('minimize-to-tray', () => {
  if (mainWindow) {
    mainWindow.hide();
  }
});
