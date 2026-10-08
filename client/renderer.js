const API = window.electronAPI;

let currentView = 'dashboard';
let settings = {};
let streams = [];
let health = null;
let refreshInterval = null;
let samsungFleet = [];
let samsungFleetState = new Map();

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
  $('apiKey').value = '';
  $('apiKey').placeholder = settings.hasApiKey ? 'Stored securely — enter to replace' : 'Your API key';
  $('notifications').checked = settings.notifications !== false;
  $('minimizeToTray').checked = settings.minimizeToTray !== false;
  if ($('cloudflareHostname')) $('cloudflareHostname').value = settings.cloudflareHostname || 'ztv.zeaz.dev';
  if ($('cloudflareToken')) {
    $('cloudflareToken').value = '';
    $('cloudflareToken').placeholder = settings.hasCloudflareToken ? 'Stored securely — enter to replace' : 'Cloudflare API token';
  }
  if ($('cloudflareAutoUpdate')) $('cloudflareAutoUpdate').checked = settings.cloudflareAutoUpdate === true;
  if ($('workspacePath')) $('workspacePath').textContent = settings.workspacePath || 'Not selected';
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
    cloudflareHostname: $('cloudflareHostname')?.value.trim() || 'ztv.zeaz.dev',
    cloudflareToken: $('cloudflareToken')?.value.trim() || '',
    cloudflareAutoUpdate: $('cloudflareAutoUpdate')?.checked === true,
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

async function refreshSamsungStatus() {
  const target = settings.serverUrl || 'http://127.0.0.1:8081';
  const result = await API.fetchSamsungStatus(target);
  if (!result || !result.ok) {
    $('tvState').textContent = 'OFFLINE';
    $('tvPlaylist').textContent = '—';
    $('tvProfile').textContent = '—';
    return;
  }
  const body = result.body || {};
  $('tvState').textContent = String(body.state || 'unknown').toUpperCase();
  $('tvPlaylist').textContent = body.playlist_ready ? 'READY' : 'WAIT';
  $('tvProfile').textContent = body.profile || '—';
}

async function refreshLanAndDNSStatus() {
  const lan = await API.getLanIP();
  if ($('lanAddress')) $('lanAddress').textContent = lan?.ok ? lan.address : 'Unavailable';
  if ($('lanInterface')) $('lanInterface').textContent = lan?.ok ? lan.name : '—';
  if ($('lanTvUrl')) $('lanTvUrl').textContent = lan?.ok ? lan.tvUrl : '—';
}

async function updateCloudflareDNS() {
  const output = $('builderOutput');
  output.textContent = 'Updating Cloudflare DNS from local LAN address...\n';
  const result = await API.updateCloudflareDNS();
  output.textContent += JSON.stringify(result, null, 2);
  if (result?.ok) {
    showToast(result.unchanged ? 'Cloudflare DNS already matches LAN IP' : `Cloudflare DNS updated: ${result.hostname} → ${result.address}`, 'success');
  } else {
    showToast(`Cloudflare DNS update failed: ${result?.error || 'unknown error'}`, 'error');
  }
  await refreshLanAndDNSStatus();
}

async function refreshFFmpegInfo() {
  const info = await API.getFFmpegInfo();
  if ($('ffmpegStatus')) $('ffmpegStatus').textContent = info?.ok ? 'READY' : 'NOT READY';
  if ($('ffmpegSource')) $('ffmpegSource').textContent = info?.source || '—';
  if ($('ffmpegVersion')) $('ffmpegVersion').textContent = info?.version || '—';
  if ($('ffmpegPath')) $('ffmpegPath').textContent = info?.path || 'Not found';
  if ($('ffmpegCapabilities')) {
    $('ffmpegCapabilities').textContent = [
      `H264:${info?.h264 ? 'yes' : 'no'}`,
      `AAC:${info?.aac ? 'yes' : 'no'}`,
      `HLS:${info?.hls ? 'yes' : 'no'}`,
      `RTMP:${info?.rtmp ? 'yes' : 'no'}`
    ].join(' · ');
  }
  return info;
}

async function runInstallerDoctor() {
  $('builderOutput').textContent = 'Running installer Doctor...\n';
  const result = await API.runSamsungTask('doctor');
  const output = [result?.stdout, result?.stderr, result?.error].filter(Boolean).join('\n');
  $('builderOutput').textContent += output || JSON.stringify(result, null, 2);
  showToast(result?.ok ? 'Doctor passed' : 'Doctor failed', result?.ok ? 'success' : 'error');
  await refreshFFmpegInfo();
}

async function refreshServerRuntimeStatus() {
  const status = await API.getServerRuntimeStatus();
  const state = $('runtimeState');
  const source = $('runtimeSource');
  const pid = $('runtimePid');
  const exe = $('runtimeExecutable');
  if (state) {
    state.textContent = status?.running ? 'RUNNING' : 'STOPPED';
    state.className = status?.running ? 'value small-value ok-text' : 'value small-value';
  }
  if (source) source.textContent = status?.source || '—';
  if (pid) pid.textContent = status?.managedPid || '—';
  if (exe) exe.textContent = status?.executable || 'Not found';
  if (status?.lastError) $('builderOutput').textContent = `Server error: ${status.lastError}`;
}

async function runServerRuntimeAction(action) {
  $('builderOutput').textContent = `Running server action: ${action}...\n`;
  const result = await API.serverRuntimeAction(action);
  $('builderOutput').textContent += JSON.stringify(result, null, 2);
  showToast(result?.ok ? `Server ${action} completed` : `Server ${action} failed`, result?.ok ? 'success' : 'error');
  await refreshServerRuntimeStatus();
  await refreshSamsungStatus();
  await refreshData();
}

async function runTvAction(action) {
  $('builderOutput').textContent = `Running TV action: ${action}...\n`;
  const result = await API.samsungAction({ serverUrl: settings.serverUrl, action });
  $('builderOutput').textContent += JSON.stringify(result, null, 2);
  showToast(result?.ok ? `TV ${action} completed` : `TV ${action} failed`, result?.ok ? 'success' : 'error');
  await refreshSamsungStatus();
}

async function runBuilderTask(task) {
  $('builderOutput').textContent = `Running builder task: ${task}...\n`;
  const result = await API.runSamsungTask(task);
  const output = [result?.stdout, result?.stderr, result?.error].filter(Boolean).join('\n');
  $('builderOutput').textContent += output || JSON.stringify(result, null, 2);
  showToast(result?.ok ? `${task} completed` : `${task} failed`, result?.ok ? 'success' : 'error');
  await refreshSamsungStatus();
}

async function selectWorkspace() {
  const result = await API.selectWorkspace();
  if (result?.workspacePath) {
    settings.workspacePath = result.workspacePath;
    $('workspacePath').textContent = result.workspacePath;
    showToast('StreamDBC workspace selected', 'success');
  } else if (result?.error) {
    showToast(result.error, 'error');
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

function renderSamsungFleet() {
  const body = $('samsungFleetBody');
  if (!body) return;
  $('fleetCount').textContent = String(samsungFleet.length);
  $('fleetAvCount').textContent = String(samsungFleet.filter((tv) => tv.capabilities?.avTransport).length);
  $('fleetRcCount').textContent = String(samsungFleet.filter((tv) => tv.capabilities?.renderingControl).length);
  $('fleetPlaying').textContent = String(
    samsungFleet.filter((tv) => samsungFleetState.get(tv.ip)?.transport === 'PLAYING').length
  );

  if (!samsungFleet.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">No Samsung TVs discovered.</td></tr>';
    return;
  }

  body.innerHTML = samsungFleet.map((tv) => {
    const state = samsungFleetState.get(tv.ip) || {};
    const volume = Number.isFinite(state.volume) ? state.volume : 20;
    const muted = state.muted === true;
    const canPlay = tv.capabilities?.setAVTransportURI && tv.capabilities?.play;
    return `<tr data-tv-ip="${escapeHtml(tv.ip)}">
      <td><strong>${escapeHtml(tv.friendlyName || 'Samsung TV')}</strong></td>
      <td><code>${escapeHtml(tv.ip)}</code></td>
      <td>${escapeHtml(tv.modelName || '—')}</td>
      <td>${escapeHtml(state.transport || 'UNKNOWN')}</td>
      <td><input class="fleet-volume" type="number" min="0" max="100" value="${volume}" style="width:72px"></td>
      <td>${muted ? 'Muted' : 'On'}</td>
      <td><div class="actions">
        <button class="btn btn-sm btn-primary" data-fleet-action="play-url" ${canPlay ? '' : 'disabled'}>Play URL</button>
        <button class="btn btn-sm" data-fleet-action="stop" ${tv.capabilities?.stop ? '' : 'disabled'}>Stop</button>
        <button class="btn btn-sm" data-fleet-action="volume" ${tv.capabilities?.renderingControl ? '' : 'disabled'}>Set Vol</button>
        <button class="btn btn-sm" data-fleet-action="${muted ? 'unmute' : 'mute'}" ${tv.capabilities?.renderingControl ? '' : 'disabled'}>${muted ? 'Unmute' : 'Mute'}</button>
      </div></td>
    </tr>`;
  }).join('');
}

async function discoverSamsungFleet() {
  const button = $('fleetDiscoverBtn');
  if (button) button.disabled = true;
  try {
    const result = await API.samsungFleetDiscover();
    if (!result?.ok) throw new Error(result?.error || 'Samsung discovery failed');
    samsungFleet = result.tvs || [];
    samsungFleetState = new Map();
    if ($('fleetMediaUrl') && !$('fleetMediaUrl').value && result.localIP) {
      $('fleetMediaUrl').value = `http://${result.localIP}:8081/tv/live/index.m3u8`;
    }
    renderSamsungFleet();
    showToast(`Discovered ${samsungFleet.length} Samsung TV(s)`, 'success');
    await refreshSamsungFleetState();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

async function refreshSamsungFleetState() {
  if (!samsungFleet.length) return;
  const result = await API.samsungFleetStatus();
  if (!result?.ok) {
    showToast(result?.error || 'Failed to refresh Samsung TV state', 'error');
    return;
  }
  for (const state of result.states || []) samsungFleetState.set(state.ip, state);
  renderSamsungFleet();
}

async function runSamsungFleetAction(ip, action, value) {
  const result = await API.samsungFleetAction({ ip, action, value });
  if (!result?.ok) {
    const detail = result?.errorDescription || result?.errorCode || result?.error || result?.statusCode || 'Action failed';
    showToast(`${ip}: ${detail}`, 'error');
    return false;
  }
  if (result.state) samsungFleetState.set(ip, result.state);
  renderSamsungFleet();
  return true;
}

async function runSamsungFleetAll(action, value) {
  if (!samsungFleet.length) {
    showToast('Discover Samsung TVs first', 'error');
    return;
  }
  const result = await API.samsungFleetActionAll({ action, value });
  const failed = (result?.results || []).filter((item) => !item.ok);
  if (failed.length) {
    showToast(`${failed.length} TV action(s) failed`, 'error');
  } else {
    showToast(`Applied ${action} to ${(result?.results || []).length} TV(s)`, 'success');
  }
  await refreshSamsungFleetState();
}

async function startSamsungMode() {
  const button = $('samsungModeBtn');
  if (button) button.disabled = true;
  const output = $('builderOutput');
  const log = (message) => {
    if (output) output.textContent += (output.textContent.endsWith('\n') ? '' : '\n') + message + '\n';
  };

  try {
    if (output) output.textContent = 'Starting Samsung Mode...\n';

    const server = await API.getServerRuntimeStatus();
    if (!server?.running) {
      log('1/6 Starting StreamDBC server...');
      const started = await API.serverRuntimeAction('start');
      if (!started?.ok) throw new Error(started?.error || 'Unable to start StreamDBC server');
    } else {
      log('1/6 StreamDBC server already running.');
    }

    log('2/6 Checking Samsung gateway...');
    let gateway = await API.fetchSamsungStatus(settings.serverUrl);
    if (!gateway?.ok) throw new Error(gateway?.error || 'Unable to read Samsung gateway status');
    if (String(gateway.body?.state || '').toLowerCase() !== 'live') {
      const startedGateway = await API.samsungAction({ serverUrl: settings.serverUrl, action: 'start' });
      if (!startedGateway?.ok && startedGateway?.statusCode !== 409) {
        throw new Error(startedGateway?.body?.error || startedGateway?.error || 'Unable to start Samsung gateway');
      }
    }

    log('3/6 Waiting for live HLS playlist...');
    let ready = false;
    for (let i = 0; i < 30; i++) {
      gateway = await API.fetchSamsungStatus(settings.serverUrl);
      if (gateway?.ok && String(gateway.body?.state || '').toLowerCase() === 'live' && gateway.body?.playlist_ready === true) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error('Samsung HLS playlist did not become ready');

    log('4/6 Discovering Samsung TVs...');
    const discovered = await API.samsungFleetDiscover();
    if (!discovered?.ok) throw new Error(discovered?.error || 'Samsung discovery failed');
    samsungFleet = discovered.tvs || [];
    samsungFleetState = new Map();
    if (!samsungFleet.length) {
      const detail = (discovered.diagnostics || []).map((d) =>
        `${d.interface || 'LAN'} ${d.localIP || ''}: ${d.count || 0}`
      ).join(', ');
      throw new Error(`No Samsung TVs discovered${detail ? ' (' + detail + ')' : ''}`);
    }
    renderSamsungFleet();

    const mediaUrl = `http://${discovered.localIP}:8081/tv/live/index.m3u8`;
    if ($('fleetMediaUrl')) $('fleetMediaUrl').value = mediaUrl;
    log(`5/6 Sending ${mediaUrl} to ${samsungFleet.length} TV(s)...`);

    const play = await API.samsungFleetActionAll({ action: 'play-url', value: mediaUrl });
    const failed = (play?.results || []).filter((item) => !item.ok);
    if (failed.length) {
      const detail = failed.map((item) => `${item.ip}: ${item.errorDescription || item.errorCode || item.error || item.statusCode || 'failed'}`).join('; ');
      throw new Error(`Playback command failed on ${failed.length} TV(s): ${detail}`);
    }

    log('6/6 Verifying AVTransport PLAYING...');
    let states = [];
    for (let attempt = 0; attempt < 12; attempt++) {
      const status = await API.samsungFleetStatus();
      states = status?.states || [];
      for (const state of states) samsungFleetState.set(state.ip, state);
      renderSamsungFleet();
      if (states.length === samsungFleet.length && states.every((state) => state.transport === 'PLAYING')) break;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }

    const notPlaying = states.filter((state) => state.transport !== 'PLAYING');
    if (notPlaying.length) {
      const detail = notPlaying.map((state) => `${state.ip}=${state.transport || 'UNKNOWN'}`).join(', ');
      throw new Error(`TV playback not confirmed: ${detail}`);
    }

    log(`READY: ${states.length}/${states.length} TVs confirmed PLAYING.`);
    showToast(`Samsung Mode ready: ${states.length} TV(s) PLAYING`, 'success');
  } catch (err) {
    log(`FAILED: ${err.message}`);
    showToast(err.message, 'error');
  } finally {
    if (button) button.disabled = false;
    await refreshSamsungStatus();
    await refreshServerRuntimeStatus();
  }
}

function init() {
  loadSettings().then(() => {
    refreshData();
    refreshInterval = setInterval(refreshData, 5000);
    refreshSamsungStatus();
    refreshServerRuntimeStatus();
    refreshLanAndDNSStatus();
    refreshFFmpegInfo();
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

  $('samsungModeBtn').addEventListener('click', startSamsungMode);
  $('samsungRefreshBtn').addEventListener('click', async () => {
    await refreshSamsungStatus();
    await refreshServerRuntimeStatus();
  });
  document.querySelectorAll('[data-server-action]').forEach(btn => {
    btn.addEventListener('click', () => runServerRuntimeAction(btn.dataset.serverAction));
  });
  $('openLocalDashboardBtn').addEventListener('click', () => API.openLocalDashboard());
  $('openLocalTVBtn').addEventListener('click', () => API.openLocalTV());
  $('updateCloudflareDnsBtn').addEventListener('click', updateCloudflareDNS);
  $('refreshLanBtn').addEventListener('click', refreshLanAndDNSStatus);
  $('refreshFFmpegBtn').addEventListener('click', refreshFFmpegInfo);
  $('installerDoctorBtn').addEventListener('click', runInstallerDoctor);
  $('selectWorkspaceBtn').addEventListener('click', selectWorkspace);
  $('clearBuilderOutputBtn').addEventListener('click', () => { $('builderOutput').textContent = 'Ready.'; });
  document.querySelectorAll('[data-tv-action]').forEach(btn => {
    btn.addEventListener('click', () => runTvAction(btn.dataset.tvAction));
  });
  document.querySelectorAll('[data-builder-task]').forEach(btn => {
    btn.addEventListener('click', () => runBuilderTask(btn.dataset.builderTask));
  });
  document.querySelectorAll('[data-tv-url]').forEach(btn => {
    btn.addEventListener('click', () => API.openSamsungUrl(btn.dataset.tvUrl));
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
