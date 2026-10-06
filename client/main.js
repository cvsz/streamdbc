const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, dialog, shell, powerSaveBlocker, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

let mainWindow = null;
let tray = null;
let playerWindow = null;
let settings = {
  serverUrl: 'http://localhost:8085',
  autoStart: false,
  notifications: true,
  minimizeToTray: true,
  serverUrlSaved: false
};

const STREAMDBC_SERVER_PORT = 1935;
let apiKey = '';

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function getCredentialPath() {
  return path.join(app.getPath('userData'), 'credentials.json');
}

function publicSettings() {
  return { ...settings, hasApiKey: Boolean(apiKey) };
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
    title: 'STREMDBC Client',
    icon: path.join(__dirname, 'assets', 'icon.png'),
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
    if (tray) {
      tray.setHighlightMode('always');
    }
  });

  mainWindow.on('hide', () => {
    if (tray) {
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

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  if (!fs.existsSync(iconPath)) {
    return;
  }

  tray = new Tray(iconPath);
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Dashboard',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Settings',
      click: () => {
        mainWindow?.webContents.send('open-settings');
      }
    },
    { type: 'separator' },
    {
      label: 'Check for Updates',
      click: () => {
        mainWindow?.webContents.send('check-updates');
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('STREMDBC Client');
  tray.setContextMenu(contextMenu);

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
              message: 'STREMDBC Client v1.0.0',
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
              message: 'STREMDBC Client v1.0.0'
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
  app.setName('STREMDBC Client');
  app.setAppUserModelId('com.stremdbc.client');

  createMainWindow();
  createTray();
  createMenu();

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
  delete next.apiKey;
  if (next.serverUrl !== undefined) next.serverUrl = normalizeServerUrl(next.serverUrl);
  settings = { ...settings, ...next };
  if (nextApiKey) saveAPIKey(nextApiKey);
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
