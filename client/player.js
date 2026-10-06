    const params = new URLSearchParams(window.location.search);
    const streamId = params.get('stream') || '';
    const serverUrl = params.get('server') || 'http://localhost:8085';

    document.title = `STREMDBC Player - ${streamId || 'Stream'}`;

    const elements = {
      video: document.getElementById('videoPlayer'),
      loading: document.getElementById('loading'),
      title: document.getElementById('streamTitle'),
      description: document.getElementById('streamDescription'),
      viewers: document.getElementById('viewersCount'),
      bitrate: document.getElementById('bitrateValue'),
      state: document.getElementById('stateValue'),
      backBtn: document.getElementById('backBtn')
    };

    let hls = null;
    let refreshInterval = null;

    function escapeHtml(str) {
      if (typeof str !== 'string') return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    async function loadStreamInfo() {
      if (!streamId) {
        elements.title.textContent = 'No stream selected';
        elements.loading.style.display = 'none';
        return;
      }

      try {
        const response = await fetch(`${serverUrl}/api/v1/streams/${encodeURIComponent(streamId)}`);
        if (!response.ok) throw new Error('Stream not found');
        const data = await response.json();

        elements.title.textContent = data.name || streamId;
        elements.description.textContent = `Stream ID: ${data.id} • Created: ${new Date(data.created_at).toLocaleString()}`;
        elements.viewers.textContent = data.viewers || 0;
        elements.bitrate.textContent = data.bitrate ? `${(data.bitrate / 1000000).toFixed(1)} Mbps` : '-';
        elements.state.textContent = data.state || 'UNKNOWN';

        if (data.state === 'LIVE') {
          elements.loading.style.display = 'none';
        }
      } catch (err) {
        elements.title.textContent = streamId;
        elements.description.textContent = 'Stream information unavailable';
      }
    }

    function initPlayer() {
      if (!streamId) {
        elements.loading.textContent = 'No stream selected';
        elements.loading.style.display = 'block';
        return;
      }

      const hlsUrl = `${serverUrl}/hls/${encodeURIComponent(streamId)}/index.m3u8`;
      elements.loading.style.display = 'block';

      if (window.Hls && Hls.isSupported()) {
        hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 90
        });
        hls.loadSource(hlsUrl);
        hls.attachMedia(elements.video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          elements.loading.style.display = 'none';
          elements.video.play().catch(() => {});
        });
        hls.on(Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            elements.loading.style.display = 'none';
            elements.loading.textContent = 'Failed to load stream';
          }
        });
      } else if (elements.video.canPlayType('application/vnd.apple.mpegurl')) {
        elements.video.src = hlsUrl;
        elements.video.addEventListener('loadedmetadata', () => {
          elements.loading.style.display = 'none';
          elements.video.play().catch(() => {});
        });
      } else {
        elements.loading.style.display = 'none';
        elements.loading.textContent = 'HLS playback not supported';
      }
    }

    elements.backBtn.addEventListener('click', () => window.close());

    document.addEventListener('DOMContentLoaded', async () => {
      await loadStreamInfo();
      initPlayer();
      refreshInterval = setInterval(loadStreamInfo, 5000);
    });

    window.addEventListener('beforeunload', () => {
      if (refreshInterval) clearInterval(refreshInterval);
      if (hls) hls.destroy();
    });
