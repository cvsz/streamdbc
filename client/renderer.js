const API = window.electronAPI;

let currentView = 'dashboard';
let settings = {};
let streams = [];
let health = null;
let refreshInterval = null;

function $(id) { return document.getElementById(id); }

function showToast(message, type = 'info') {
  const container = $('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.append(toast);
  setTimeout(() => toast.remove(), 4000);
}

async function loadSettings() {
  settings = await API.getSettings();
  applySettings();
}

function applySettings() {
  $('serverUrl').value = settings.serverUrl || '';
  $('apiKey').value = settings.apiKey || '';
  $('notifications').checked = settings.notifications !== false;
  $('minimizeToTray').checked = settings.minimizeToTray !== false;
}

async function refreshData() {
  const serverUrl = settings.serverUrl;
  if (!serverUrl) {
    showToast('Server URL not configured', 'error');
    return;
  }

  health = await API.fetchHealth(serverUrl);
  streams = await API.fetchStreams(serverUrl);

  updateDashboard();
  updateStreamTables();
  updatePlayerSelect();

  $('lastUpdate').textContent = `Updated ${new Date().toLocaleTimeString()}`;

  if (health) {
    updateServerStatus(health.status === 'healthy');
  }
}

function updateServerStatus(healthy) {
  const dot = $('statusDot');
  const text = $('statusText');
  if (healthy) {
    dot.className = 'status-dot ok';
    text.textContent = 'Connected';
  } else {
    dot.className = 'status-dot bad';
    text.textContent = 'Disconnected';
  }
}

function updateDashboard() {
  if (health) {
    $('dashStreams').textContent = health.streams ?? '—';
    $('dashLive').textContent = health.live_streams ?? '—';
    $('dashViewers').textContent = health.viewers ?? '—';
    $('dashMemory').textContent = formatBytes(health.memory_bytes) ?? '—';
    $('dashUptime').textContent = formatDuration(health.uptime_seconds) ?? '—';
  }

  if (streams) {
    const live = streams.streams?.filter(s => s.state === 'LIVE').length ?? 0;
    $('dashLive').textContent = live;
  }
}

function updateStreamTables() {
  const streamList = streams?.streams ?? [];

  const tbody = $('streamTableBody');
  tbody.replaceChildren();
  if (!streamList.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No streams registered</td></tr>';
  } else {
    streamList.forEach(stream => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(stream.name || stream.id)}</td>
        <td><code>${escapeHtml(stream.id)}</code></td>
        <td><span class="badge ${stream.state.toLowerCase()}">${stream.state}</span></td>
        <td>${stream.viewers ?? 0}</td>
        <td>${stream.created_at ? new Date(stream.created_at).toLocaleString() : '—'}</td>
        <td>
          <button class="btn btn-sm" data-action="play" data-id="${stream.id}">Play</button>
          <button class="btn btn-sm" data-action="delete" data-id="${stream.id}">Delete</button>
        </td>
      `;
      tbody.append(tr);
    });
  }

  const allTbody = $('allStreamsBody');
  allTbody.replaceChildren();
  if (!streamList.length) {
    allTbody.innerHTML = '<tr><td colspan="7" class="empty">No streams registered</td></tr>';
  } else {
    streamList.forEach(stream => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(stream.name || stream.id)}</td>
        <td><code>${escapeHtml(stream.id)}</code></td>
        <td><span class="badge ${stream.state.toLowerCase()}">${stream.state}</span></td>
        <td>${stream.bitrate ? `${Math.round(stream.bitrate / 1000)} kbps` : '—'}</td>
        <td>${stream.viewers ?? 0}</td>
        <td>${stream.created_at ? new Date(stream.created_at).toLocaleString() : '—'}</td>
        <td>
          <button class="btn btn-sm" data-action="play" data-id="${stream.id}">Play</button>
          <button class="btn btn-sm" data-action="delete" data-id="${stream.id}">Delete</button>
        </td>
      `;
      allTbody.append(tr);
    });
  }

  tbody.addEventListener('click', handleTableClick);
  allTbody.addEventListener('click', handleTableClick);
}

function handleTableClick(event) {
  const btn = event.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  if (action === 'play') {
    playStream(id);
  } else if (action === 'delete') {
    deleteStream(id);
  }
}

async function deleteStream(streamId) {
  const confirmed = await API.showError({
    title: 'Delete Stream',
    message: `Delete stream "${streamId}"? This cannot be undone.`
  }).catch(() => confirm(`Delete stream "${streamId}"?`));

  if (!confirmed) return;

  const result = await API.deleteStream({ streamId });
  if (result.error) {
    showToast(`Failed to delete: ${result.error}`, 'error');
  } else {
    showToast(`Stream "${streamId}" deleted`, 'success');
    refreshData();
  }
}

function playStream(streamId) {
  API.openPlayer(streamId);
}

function updatePlayerSelect() {
  const select = $('streamSelect');
  const current = select.value;
  select.replaceChildren();
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = 'Select a stream...';
  select.append(defaultOption);

  streams?.streams?.forEach(stream => {
    const option = document.createElement('option');
    option.value = stream.id;
    option.textContent = `${stream.name || stream.id} (${stream.state})`;
    select.append(option);
  });

  if (current && streams?.streams?.find(s => s.id === current)) {
    select.value = current;
  }
}

function updateComponents(components) {
  const grid = $('componentsGrid');
  grid.replaceChildren();
  const entries = Object.entries(components || {});
  if (!entries.length) {
    grid.innerHTML = '<div class="card">No optional components enabled.</div>';
    return;
  }
  entries.sort(([a], [b]) => a.localeCompare(b)).forEach(([name, data]) => {
    const card = document.createElement('div');
    card.className = 'card component';
    card.innerHTML = `<div class="label">${escapeHtml(name)}</div><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
    grid.append(card);
  });
}

async function createStream() {
  const streamId = $('newStreamId').value.trim();
  const name = $('newStreamName').value.trim();

  if (!streamId) {
    showToast('Stream ID is required', 'error');
    return;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(streamId)) {
    showToast('Stream ID: only letters, digits, ., _, -', 'error');
    return;
  }
  if (!name) {
    showToast('Name is required', 'error');
    return;
  }

  const result = await API.createStream({ streamId, name });
  if (result.error) {
    showToast(`Failed: ${result.error}`, 'error');
  } else {
    showToast(`Stream "${streamId}" created`, 'success');
    $('createStreamModal').classList.remove('active');
    $('newStreamId').value = '';
    $('newStreamName').value = '';
    refreshData();
  }
}

function openCreateStreamModal() {
  $('createStreamModal').classList.add('active');
  $('newStreamId').focus();
}

function openRtmpModal() {
  const streamId = $('rtmpStreamId').value.trim();
  if (!streamId) {
    showToast('Enter a stream ID first', 'error');
    return;
  }
  const serverUrl = settings.serverUrl.replace(/\/$/, '');
  $('rtmpUrl').value = `${serverUrl}:1935/${streamId}`;
  $('rtmpKey').value = streamId;
  $('rtmpModal').classList.add('active');
}

async function copyRtmpUrl() {
  const url = $('rtmpUrl').value;
  try {
    await navigator.clipboard.writeText(url);
    showToast('RTMP URL copied', 'success');
  } catch (err) {
    $('rtmpUrl').select();
    document.execCommand('copy');
    showToast('RTMP URL copied', 'success');
  }
}

async function saveSettings() {
  const newSettings = {
    serverUrl: $('serverUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    notifications: $('notifications').checked,
    minimizeToTray: $('minimizeToTray').checked
  };

  settings = await API.saveSettings(newSettings);
  applySettings();
  refreshData();
  showToast('Settings saved', 'success');
}

async function testConnection() {
  const serverUrl = $('serverUrl').value.trim();
  if (!serverUrl) {
    showToast('Enter a server URL', 'error');
    return;
  }

  const status = $('settingsStatus');
  status.textContent = 'Testing...';
  status.className = 'settings-status testing';

  try {
    const url = new URL('/health', serverUrl);
    const res = await fetch(url.toString(), {
      headers: settings.apiKey ? { 'X-API-Key': settings.apiKey } : {}
    });
    if (res.ok) {
      const data = await res.json();
      status.textContent = `Connected: ${data.status}`;
      status.className = 'settings-status success';
      showToast('Connection successful', 'success');
    } else {
      status.textContent = `HTTP ${res.status}`;
      status.className = 'settings-status error';
    }
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
    status.className = 'settings-status error';
  }
}

function switchView(viewName) {
  currentView = viewName;
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });
  document.querySelectorAll('.view').forEach(view => {
    view.classList.toggle('active', view.id === `${viewName}View`);
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let x = bytes, i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x >= 10 || i === 0 ? x.toFixed(0) : x.toFixed(1)} ${units[i]}`;
}

function formatDuration(seconds) {
  seconds = Number(seconds) || 0;
  const d = Math.floor(seconds / 86400); seconds %= 86400;
  const h = Math.floor(seconds / 3600); seconds %= 3600;
  const m = Math.floor(seconds / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function init() {
  loadSettings().then(() => {
    refreshData();
    refreshInterval = setInterval(refreshData, 5000);
  });

  $('refreshBtn').addEventListener('click', refreshData);
  $('refreshDashBtn').addEventListener('click', refreshData);
  $('settingsBtn').addEventListener('click', () => switchView('settings'));
  $('trayBtn').addEventListener('click', () => {
    API.minimizeToTray();
  });

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  $('createStreamBtn').addEventListener('click', openCreateStreamModal);
  $('createStreamBtn2').addEventListener('click', openCreateStreamModal);
  $('confirmCreateStream').addEventListener('click', createStream);
  $('cancelCreateStream').addEventListener('click', () => {
    $('createStreamModal').classList.remove('active');
  });
  $('closeModal').addEventListener('click', () => {
    $('createStreamModal').classList.remove('active');
  });

  $('saveSettingsBtn').addEventListener('click', saveSettings);
  $('testConnectionBtn').addEventListener('click', testConnection);

  $('playBtn').addEventListener('click', () => {
    const streamId = $('streamSelect').value;
    if (streamId) {
      playStream(streamId);
    } else {
      showToast('Select a stream first', 'error');
    }
  });
  $('stopBtn').addEventListener('click', () => {
    const video = $('mainPlayer');
    video.pause();
    video.src = '';
  });
  $('streamSelect').addEventListener('change', () => {
    const streamId = $('streamSelect').value;
    if (streamId) {
      playStream(streamId);
    }
  });

  $('copyRtmpBtn').addEventListener('click', copyRtmpUrl);
  $('closeRtmpBtn').addEventListener('click', () => {
    $('rtmpModal').classList.remove('active');
  });
  $('closeRtmpModal').addEventListener('click', () => {
    $('rtmpModal').classList.remove('active');
  });

  $('docsLink').addEventListener('click', (e) => {
    e.preventDefault();
    API.openExternal('https://github.com/cvsz/streamdbc/blob/main/docs/USER-MANUAL.md');
  });
  $('issuesLink').addEventListener('click', (e) => {
    e.preventDefault();
    API.openExternal('https://github.com/cvsz/streamdbc/issues');
  });

  API.onSettingsUpdated(applySettings);
  API.onHealthUpdated((h) => {
    if (h) {
      updateDashboard();
      updateServerStatus(h.status === 'healthy');
    }
  });
  API.onStreamsUpdated(() => {
    refreshData();
  });
  API.onOpenSettings(() => switchView('settings'));
  API.onCreateStream(openCreateStreamModal);
  API.onPushRtmp(openRtmpModal);
  API.onUpdateAvailable((data) => {
    showToast(`Update available: v${data.version}`, 'info');
    if (confirm(`Update to v${data.version}?\n\n${data.url}`)) {
      API.openExternal(data.url);
    }
  });
  API.onUpdateChecked(() => {
    showToast('Update check complete', 'info');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('createStreamModal').classList.remove('active');
      $('rtmpModal').classList.remove('active');
    }
  });
}

init();
