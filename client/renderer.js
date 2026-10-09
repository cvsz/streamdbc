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
    notifications: $('notifications').checked
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
  $('fleetKnownCount').textContent = String(samsungFleet.filter((tv) => tv.known).length);
  $('fleetOnlineCount').textContent = String(samsungFleet.filter((tv) => tv.online).length);
  $('fleetAvCount').textContent = String(samsungFleet.filter((tv) => tv.capabilities?.avTransport).length);
  $('fleetRcCount').textContent = String(samsungFleet.filter((tv) => tv.capabilities?.renderingControl).length);
  $('fleetPlaying').textContent = String(
    samsungFleet.filter((tv) => samsungFleetState.get(tv.ip)?.transport === 'PLAYING').length
  );

  if (!samsungFleet.length) {
    body.innerHTML = '<tr><td colspan="11" class="empty">No Samsung TVs discovered.</td></tr>';
    return;
  }

  body.innerHTML = samsungFleet.map((tv) => {
    const state = samsungFleetState.get(tv.ip) || {};
    const volume = Number.isFinite(state.volume) ? state.volume : 20;
    const muted = state.muted === true;
    const canPlay = tv.online && tv.capabilities?.setAVTransportURI && tv.capabilities?.play;
    const canSwitchHdmi = tv.known && tv.online && tv.capabilities?.getSourceList &&
      tv.capabilities?.setMainTVSource && tv.capabilities?.getCurrentExternalSource;
    const lastError = state.errors?.join('; ') || tv.probeError || '';
    return `<tr data-tv-ip="${escapeHtml(tv.ip)}">
      <td><strong>${escapeHtml(tv.friendlyName || 'Samsung TV')}</strong></td>
      <td><code>${escapeHtml(tv.ip)}</code></td>
      <td>${escapeHtml(tv.modelName || '—')}</td>
      <td>${tv.online ? 'ONLINE' : 'OFFLINE / UNREACHABLE'}</td>
      <td>${tv.capabilitiesKnown ? (tv.capabilities?.avTransport ? 'AVAILABLE' : 'NOT FOUND') : 'UNKNOWN'}</td>
      <td>${escapeHtml(state.transport || 'UNKNOWN')}</td>
      <td>${escapeHtml(state.source || '—')}</td>
      <td>${escapeHtml(lastError || '—')}</td>
      <td><input class="fleet-volume" type="number" min="0" max="100" value="${volume}" style="width:72px"></td>
      <td>${muted ? 'Muted' : 'On'}</td>
      <td><div class="actions">
        <button class="btn btn-sm btn-primary" data-fleet-action="play-url" ${canPlay ? '' : 'disabled'}>Play URL</button>
        <button class="btn btn-sm" data-fleet-action="switch-hdmi" ${canSwitchHdmi ? '' : 'disabled'}>HDMI</button>
        <button class="btn btn-sm" data-fleet-action="stop" ${tv.online && tv.capabilities?.stop ? '' : 'disabled'}>Stop</button>
        <button class="btn btn-sm" data-fleet-action="volume" ${tv.online && tv.capabilities?.renderingControl ? '' : 'disabled'}>Set Vol</button>
        <button class="btn btn-sm" data-fleet-action="${muted ? 'unmute' : 'mute'}" ${tv.online && tv.capabilities?.renderingControl ? '' : 'disabled'}>${muted ? 'Unmute' : 'Mute'}</button>
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
      $('fleetMediaUrl').value = `http://${result.localIP}:8081/tv/test.mp4`;
    }
    renderSamsungFleet();
    const output = $('builderOutput');
    if (output) {
      const lines = ['Samsung fleet discovery:', `Known TVs: ${samsungFleet.filter((tv) => tv.known).length}; online: ${samsungFleet.filter((tv) => tv.online).length}`];
      for (const diagnostic of result.diagnostics || []) {
        lines.push(`${diagnostic.interface} ${diagnostic.localIP}: M-SEARCH ${diagnostic.mSearchSent ? 'sent' : 'failed'}, responses ${diagnostic.responses || 0}, hydrated ${diagnostic.hydrated || 0}${diagnostic.descriptionFailures ? `, description failures ${diagnostic.descriptionFailures}` : ''}${diagnostic.error ? `, error ${diagnostic.error}` : ''}`);
      }
      for (const tv of samsungFleet.filter((item) => item.known)) {
        const hdmiActions = tv.capabilities?.getSourceList && tv.capabilities?.setMainTVSource && tv.capabilities?.getCurrentExternalSource;
        lines.push(`${tv.friendlyName} ${tv.ip}: ${tv.online ? 'ONLINE' : 'OFFLINE / UNREACHABLE'}; open ports ${tv.openPorts?.join(', ') || 'none'}; AVTransport ${tv.capabilitiesKnown ? (tv.capabilities?.avTransport ? 'verified' : 'not found') : 'unknown'}; HDMI source API ${tv.capabilitiesKnown ? (hdmiActions ? 'verified' : 'not found') : 'unknown'}`);
      }
      output.textContent += (output.textContent ? '\n' : '') + lines.join('\n') + '\n';
    }
    const online = samsungFleet.filter((tv) => tv.online).length;
    showToast(`Samsung fleet: ${online}/${samsungFleet.filter((tv) => tv.known).length} known TVs online`, online ? 'success' : 'error');
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
  if (action === 'switch-hdmi') {
    showToast(`${ip}: switched to ${result.source?.type || 'HDMI'} and confirmed`, 'success');
  }
  return true;
}

async function runSamsungFleetAll(action, value) {
  if (!samsungFleet.length) {
    showToast('Discover Samsung TVs first', 'error');
    return;
  }
  const result = await API.samsungFleetActionAll({ action, value });
  const failed = (result?.results || []).filter((item) => !item.ok);
  if (action === 'switch-hdmi') {
    const confirmed = (result?.results || []).filter((item) => item.ok).length;
    const total = (result?.results || []).length;
    showToast(`HDMI confirmed on ${confirmed}/${total} TV(s)`, total > 0 && confirmed === total ? 'success' : 'error');
  } else if (failed.length) {
    showToast(`${failed.length} TV action(s) failed`, 'error');
  } else {
    showToast(`Applied ${action} to ${(result?.results || []).length} TV(s)`, 'success');
  }
  if (action === 'switch-hdmi') {
    const output = $('builderOutput');
    if (output) {
      const lines = (result?.results || []).map((item) =>
        `${item.ip}: ${item.ok ? `HDMI confirmed (${item.source?.type || 'HDMI'})` : `HDMI switch failed; ${item.errorDescription || item.error || item.phase || 'unverified'}`}`
      );
      output.textContent += (output.textContent ? '\n' : '') + lines.join('\n') + '\n';
    }
  }
  await refreshSamsungFleetState();
}

async function handleSamsungFleetControlClick(event) {
  const button = event.target.closest('button[data-fleet-action]');
  const row = button?.closest('tr[data-tv-ip]');
  if (!button || !row) return;

  let action = button.dataset.fleetAction;
  let value;
  if (action === 'play-url') value = $('fleetMediaUrl')?.value.trim() || '';
  if (action === 'volume') value = Number(row.querySelector('.fleet-volume')?.value);
  if (action === 'mute') value = true;
  if (action === 'unmute') {
    action = 'mute';
    value = false;
  }

  button.disabled = true;
  try {
    await runSamsungFleetAction(row.dataset.tvIp, action, value);
  } catch (error) {
    showToast(error?.message || 'Samsung TV action failed', 'error');
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

async function stopSamsungWall() {
  const button = $('samsungStopWallBtn');
  if (button) button.disabled = true;
  const output = $('builderOutput');
  const log = (message) => {
    if (output) output.textContent += (output.textContent.endsWith('\n') ? '' : '\n') + message + '\n';
  };
  try {
    log('Stopping TV Wall...');
    const result = await API.stopTVWall();
    for (const tv of result?.tvResults || []) {
      log(`${tv.ip}: ${tv.skipped ? 'SKIPPED' : tv.ok ? 'STOPPED' : 'STOP FAILED'}${tv.error ? ` — ${tv.error}` : ''}`);
    }
    const gatewayStopped = result?.gateway?.ok || result?.gateway?.statusCode === 409;
    log(`Samsung gateway: ${gatewayStopped ? 'STOPPED' : 'STOP FAILED'}${result?.gateway?.error ? ` — ${result.gateway.error}` : ''}`);
    log(result?.ok ? 'TV Wall stopped.' : 'TV Wall stopped with per-device errors.');
    showToast(result?.ok ? 'TV Wall stopped' : 'TV Wall stopped with errors', result?.ok ? 'success' : 'error');
  } catch (err) {
    log(`STOP TV WALL FAILED: ${err.message}`);
    showToast(err.message, 'error');
  } finally {
    if (button) button.disabled = false;
    await refreshSamsungStatus();
  }
}

async function testSamsungHls() {
  const button = $('samsungHlsTestBtn');
  if (button) button.disabled = true;
  try {
    const result = await API.samsungHlsTest();
    if (!result?.ok) throw new Error(result?.error || 'HLS smoke test failed');
    const message = `HLS READY: playlist HTTP ${result.playlistStatus}; newest segment ${result.segment} HTTP ${result.segmentStatus}; playlist advanced to ${result.nextSegment}.`;
    const output = $('builderOutput');
    if (output) output.textContent += (output.textContent.endsWith('\n') ? '' : '\n') + message + '\n';
    showToast('HLS playlist and segment are ready and advancing', 'success');
    return result;
  } catch (err) {
    const output = $('builderOutput');
    if (output) output.textContent += (output.textContent.endsWith('\n') ? '' : '\n') + `HLS NOT READY: ${err.message}\n`;
    showToast(err.message, 'error');
    return { ok: false, error: err.message };
  } finally {
    if (button) button.disabled = false;
  }
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

    log('3/6 Testing the live HLS playlist and newest segment...');
    const hls = await API.samsungHlsTest();
    if (!hls?.ok) throw new Error(hls?.error || 'Live HLS smoke test failed');
    log(`HLS READY: ${hls.segment} returned HTTP ${hls.segmentStatus}; playlist advanced to ${hls.nextSegment}.`);

    log('4/6 Discovering Samsung TVs...');
    const discovered = await API.samsungFleetDiscover();
    if (!discovered?.ok) throw new Error(discovered?.error || 'Samsung discovery failed');
    samsungFleet = discovered.tvs || [];
    samsungFleetState = new Map();
    renderSamsungFleet();
    for (const diagnostic of discovered.diagnostics || []) {
      log(`${diagnostic.interface} ${diagnostic.localIP}: M-SEARCH ${diagnostic.mSearchSent ? 'sent' : 'failed'}, responses ${diagnostic.responses || 0}, hydrated ${diagnostic.hydrated || 0}${diagnostic.error ? `, error ${diagnostic.error}` : ''}`);
    }
    for (const tv of samsungFleet.filter((item) => item.known)) {
      const hdmiActions = tv.capabilities?.getSourceList && tv.capabilities?.setMainTVSource && tv.capabilities?.getCurrentExternalSource;
      log(`${tv.friendlyName} ${tv.ip}: ${tv.online ? 'ONLINE' : 'OFFLINE / UNREACHABLE'}; open ports ${tv.openPorts?.join(', ') || 'none'}; AVTransport ${tv.capabilitiesKnown ? (tv.capabilities?.avTransport ? 'verified' : 'not found') : 'unknown'}; RunBrowser ${tv.capabilitiesKnown ? (tv.capabilities?.runBrowser ? 'verified' : 'not found') : 'unknown'}; HDMI source API ${tv.capabilitiesKnown ? (hdmiActions ? 'verified' : 'not found') : 'unknown'}`);
    }

    if (!discovered.localIP) throw new Error(discovered.warning || 'No physical private LAN IPv4 address was detected');

    const mediaUrl = `http://${discovered.localIP}:8081/tv/test.mp4`;
    const browserUrl = `http://${discovered.localIP}:8081/tv/`;
    if ($('fleetMediaUrl')) $('fleetMediaUrl').value = mediaUrl;
    const canPlayMedia = (tv) => tv.capabilities?.setAVTransportURI && tv.capabilities?.play;
    const candidates = samsungFleet.filter((tv) => tv.online && (canPlayMedia(tv) || tv.capabilities?.runBrowser));
    const unavailable = samsungFleet.filter((tv) => !tv.online || (!canPlayMedia(tv) && !tv.capabilities?.runBrowser));
    for (const tv of unavailable) {
      const reason = !tv.online ? 'OFFLINE' : 'AVTransport and RunBrowser capabilities not verified';
      log(`${tv.friendlyName || tv.ip}: ${reason}; playback commands skipped.`);
    }
    if (!candidates.length) throw new Error('No online TV has a verified AVTransport or RunBrowser capability. See per-TV diagnostics above.');

    log(`5/6 Testing MP4 before opening live browser pages on ${candidates.length} verified online TV(s), one at a time...`);
    let mp4Attempted = 0;
    let mp4Accepted = 0;
    let mp4Playing = 0;
    let mp4Failed = 0;
    let browserAttempted = 0;
    let browserAccepted = 0;
    let browserNoResponse = 0;
    let browserFailed = 0;
    for (const tv of candidates) {
      if (canPlayMedia(tv)) {
        mp4Attempted += 1;
        let mp4Result, mp4IpcError = '';
        try {
          mp4Result = await API.samsungFleetAction({ ip: tv.ip, action: 'play-url', value: mediaUrl });
        } catch (err) {
          mp4IpcError = err?.message || 'IPC request failed';
          mp4Result = { ok: false, error: mp4IpcError };
        }
        if (mp4Result?.ok) {
          mp4Accepted += 1;
          const transport = String(mp4Result.state?.transport || '').toUpperCase();
          if (transport === 'PLAYING') mp4Playing += 1;
          log(`${tv.friendlyName} ${tv.ip}: MP4 URI/Play ACCEPTED; initial AVTransport state ${transport || 'unknown'}.`);
        } else {
          mp4Failed += 1;
          const reason = mp4Result?.errorDescription || mp4Result?.errorCode || mp4Result?.error || `HTTP ${mp4Result?.statusCode || 'no response'}`;
          log(`${tv.friendlyName} ${tv.ip}: MP4 test FAILED; ${reason}.`);
        }
      } else {
        log(`${tv.friendlyName} ${tv.ip}: MP4 test skipped; AVTransport capability not verified.`);
      }

      if (!tv.capabilities?.runBrowser) {
        log(`${tv.friendlyName} ${tv.ip}: live browser launch skipped; RunBrowser capability not verified.`);
        continue;
      }

      browserAttempted += 1;
      let browserResult, browserIpcError = '';
      try {
        browserResult = await API.samsungFleetAction({ ip: tv.ip, action: 'open-browser', value: browserUrl });
      } catch (err) {
        browserIpcError = err?.message || 'IPC request failed';
        browserResult = { ok: false, error: browserIpcError };
      }
      if (browserResult?.ok) {
        browserAccepted += 1;
        log(`${tv.friendlyName} ${tv.ip}: RunBrowser ACCEPTED after MP4 test; confirm live video on the physical screen.`);
      } else if (browserResult?.statusCode === 0 && !browserIpcError) {
        browserNoResponse += 1;
        log(`${tv.friendlyName} ${tv.ip}: RunBrowser returned no SOAP response; outcome is unknown. No retry sent; verify the physical screen.`);
      } else {
        browserFailed += 1;
        const reason = browserResult?.errorDescription || browserResult?.errorCode || browserResult?.error || `HTTP ${browserResult?.statusCode || 'no response'}`;
        log(`${tv.friendlyName} ${tv.ip}: RunBrowser FAILED after MP4 test; ${reason}. Other TVs will continue independently.`);
      }
    }

    log('6/6 Browser playback needs physical video/audio confirmation; AVTransport does not report browser playback state.');
    log(`MP4 TEST: ${mp4Attempted} attempted; ${mp4Accepted} URI/Play accepted; ${mp4Playing} initial PLAYING states; ${mp4Failed} failed.`);
    log(`LIVE BROWSER: ${browserAttempted} attempted; ${browserAccepted} acknowledged; ${browserNoResponse} returned no SOAP response; ${browserFailed} explicit failures.`);
    const browserCommandObserved = browserAccepted > 0 || browserNoResponse > 0;
    showToast(browserCommandObserved ? `Samsung Mode: ${browserAccepted} acknowledged, ${browserNoResponse} without reply; check TV screens` : 'Samsung Mode: no live browser command was acknowledged', browserCommandObserved ? 'info' : 'error');
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
  $('samsungStopWallBtn')?.addEventListener('click', stopSamsungWall);
  $('samsungHlsTestBtn')?.addEventListener('click', testSamsungHls);
  $('fleetDiscoverBtn')?.addEventListener('click', discoverSamsungFleet);
  $('fleetRefreshBtn')?.addEventListener('click', refreshSamsungFleetState);
  $('fleetPlayAllBtn')?.addEventListener('click', () => {
    const mediaUrl = $('fleetMediaUrl')?.value.trim() || '';
    if (!mediaUrl) {
      showToast('Enter a media URL first', 'error');
      return;
    }
    runSamsungFleetAll('play-url', mediaUrl);
  });
  $('fleetSwitchHdmiAllBtn')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await runSamsungFleetAll('switch-hdmi');
    } finally {
      button.disabled = false;
    }
  });
  $('fleetStopAllBtn')?.addEventListener('click', () => runSamsungFleetAll('stop'));
  $('fleetMuteAllBtn')?.addEventListener('click', () => runSamsungFleetAll('mute', true));
  $('fleetUnmuteAllBtn')?.addEventListener('click', () => runSamsungFleetAll('mute', false));
  $('samsungFleetBody')?.addEventListener('click', handleSamsungFleetControlClick);
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
