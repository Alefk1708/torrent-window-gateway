interface PlayerPageOptions {
  nonce: string
  title: string
  contentType: string
  browserCompatible: boolean
  streamUrl: string
  playbackUrl: string
  playbackToken: string
  /** Available transcode ladder rungs; empty when transcoding is unavailable. */
  transcodeHeights: number[]
}

export function renderPlayerPage(options: PlayerPageOptions): string {
  const canTranscode = options.transcodeHeights.length > 0
  const warning = options.browserCompatible
    ? ''
    : canTranscode
      ? '<p class="warning">Este contêiner/codec pode não ser aceito pelo navegador. Selecione uma resolução abaixo para transcodificar para MP4 (H.264).</p>'
      : '<p class="warning">Este contêiner ou codec pode não ser aceito pelo navegador. O gateway faz stream direto e a transcodificação não está disponível.</p>'
  const qualitySelect = canTranscode
    ? `<select id="quality" aria-label="Qualidade do vídeo">
      <option value="original">Original</option>
      ${options.transcodeHeights.map((height) => `<option value="${height}">${height}p</option>`).join('\n      ')}
    </select>`
    : ''
  const jsConfig = JSON.stringify({
    streamUrl: options.streamUrl,
    playbackUrl: options.playbackUrl,
    playbackToken: options.playbackToken,
    contentType: options.contentType,
    transcodeHeights: options.transcodeHeights,
  }).replace(/</g, '\\u003c')

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="referrer" content="no-referrer">
  <title>${escapeHtml(options.title)}</title>
  <style nonce="${options.nonce}">
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #080b12; color: #e8edf7; }
    main { width: min(100%, 1200px); padding: 16px; }
    .frame { overflow: hidden; border: 1px solid #293247; border-radius: 16px; background: #020306; box-shadow: 0 24px 80px #0009; }
    video { display: block; width: 100%; max-height: calc(100vh - 110px); background: #000; }
    .bar { min-height: 54px; display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: #111722; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #f4b942; box-shadow: 0 0 14px currentColor; flex: 0 0 auto; }
    .ready .dot { background: #42d392; }
    .error .dot { background: #ff5d73; }
    #status { font-size: 13px; color: #b9c4d8; overflow-wrap: anywhere; }
    #quality { margin-left: 8px; padding: 6px 8px; border: 1px solid #293247; border-radius: 8px; background: #0d1320; color: #e8edf7; font-size: 13px; flex: 0 0 auto; }
    .title { margin-left: auto; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: #79859d; }
    .warning { margin: 10px 4px 0; color: #ffc970; font-size: 12px; }
  </style>
</head>
<body>
  <main>
    <section class="frame" id="frame">
      <video id="video" controls playsinline preload="metadata"></video>
      <div class="bar">
        <span class="dot"></span>
        <span id="status">Conectando ao swarm…</span>
        ${qualitySelect}
        <span class="title">${escapeHtml(options.title)}</span>
      </div>
    </section>
    ${warning}
  </main>
  <script nonce="${options.nonce}">
    const config = ${jsConfig};
    const video = document.getElementById('video');
    const frame = document.getElementById('frame');
    const status = document.getElementById('status');
    const quality = document.getElementById('quality');
    let lastHeartbeat = 0;
    let currentHeight = null;   // null = arquivo original; número = transcodificação em andamento
    let startAt = 0;            // offset, em segundos, onde a transcodificação atual começou
    let pendingRestore = 0;     // posição a restaurar ao voltar para o modo original
    let switching = false;

    function streamUrlFor(height, start) {
      const url = new URL(config.streamUrl, location.href);
      if (height !== null) {
        url.searchParams.set('height', String(height));
        if (start > 1) url.searchParams.set('start', start.toFixed(2));
      }
      return url.toString();
    }

    function loadStream(height, start, autoplay) {
      currentHeight = height;
      startAt = start;
      switching = true;
      video.src = streamUrlFor(height, start);
      video.load();
      if (autoplay) video.play().catch(() => {});
      setState('', height === null
        ? 'Buscando os primeiros pieces…'
        : 'Iniciando transcodificação (' + height + 'p)…');
    }

    function switchQuality(height) {
      const absolute = startAt + (video.currentTime || 0);
      const autoplay = !video.paused && !video.ended;
      pendingRestore = height === null ? absolute : 0;
      loadStream(height, height === null ? 0 : absolute, autoplay);
    }

    function isBuffered(time) {
      for (let index = 0; index < video.buffered.length; index += 1) {
        if (time >= video.buffered.start(index) && time <= video.buffered.end(index) - 1) return true;
      }
      return false;
    }

    video.src = config.streamUrl;
    const setState = (kind, message) => {
      frame.classList.remove('ready', 'error');
      if (kind) frame.classList.add(kind);
      status.textContent = message;
    };

    async function heartbeat(force = false) {
      const now = Date.now();
      if (!force && now - lastHeartbeat < 8000) return;
      lastHeartbeat = now;
      try {
        const response = await fetch(config.playbackUrl, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', 'x-playback-token': config.playbackToken },
          body: JSON.stringify({
            currentTime: Number.isFinite(video.currentTime) ? startAt + video.currentTime : 0,
            duration: Number.isFinite(video.duration) && video.duration > 0
              ? (currentHeight === null ? video.duration : startAt + video.duration)
              : undefined,
            paused: video.paused
          }),
          cache: 'no-store',
          credentials: 'omit',
          keepalive: true
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          setState('error', body.message || 'A sessão de reprodução expirou.');
          return;
        }
        const body = await response.json();
        const peers = body.torrent?.peers ?? 0;
        const speed = body.torrent?.downloadSpeed ?? 0;
        const qualityTag = currentHeight === null ? '' : currentHeight + 'p · ';
        setState('ready', 'Pronto · ' + qualityTag + peers + ' peers · ' + formatRate(speed));
      } catch {
        setState('', 'Reconectando…');
      }
    }

    const formatRate = (bytes) => bytes >= 1048576
      ? (bytes / 1048576).toFixed(1) + ' MB/s'
      : Math.round(bytes / 1024) + ' KB/s';

    video.addEventListener('loadstart', () => { switching = true; });
    video.addEventListener('loadedmetadata', () => {
      switching = false;
      if (pendingRestore > 0.5 && currentHeight === null) {
        const target = pendingRestore;
        pendingRestore = 0;
        try { video.currentTime = target; } catch {}
      } else {
        pendingRestore = 0;
      }
    });
    video.addEventListener('waiting', () => setState('', currentHeight === null
      ? 'Aguardando buffer do torrent…'
      : 'Aguardando transcodificação (' + currentHeight + 'p)…'));
    video.addEventListener('canplay', () => { switching = false; void heartbeat(true); });
    video.addEventListener('playing', () => { switching = false; void heartbeat(true); });
    video.addEventListener('pause', () => void heartbeat(true));
    video.addEventListener('seeking', () => {
      if (switching) return;
      if (currentHeight === null) {
        setState('', 'Priorizando a nova posição…');
        return;
      }
      const target = video.currentTime;
      if (isBuffered(target)) return;   // seek atendido pelo buffer local
      const absolute = startAt + target;
      const autoplay = !video.paused;
      pendingRestore = 0;
      loadStream(currentHeight, absolute, autoplay);
    });
    video.addEventListener('seeked', () => void heartbeat(true));
    video.addEventListener('timeupdate', () => void heartbeat(false));
    video.addEventListener('error', () => {
      if (switching) return;
      const code = video.error?.code;
      const message = code === 4
        ? 'O navegador não suporta o contêiner/codec deste arquivo.'
        : 'Não foi possível continuar o stream. Verifique peers e formato.';
      setState('error', message);
    });
    setInterval(() => void heartbeat(true), 15000);
    void heartbeat(true);

    if (quality !== null) {
      quality.addEventListener('change', () => {
        const value = quality.value;
        switchQuality(value === 'original' ? null : Number(value));
      });
    }

    // Ao deixar a página, encerra a sessão e libera torrent/transcodificação imediatamente.
    window.addEventListener('pagehide', () => {
      try {
        fetch(config.playbackUrl + '?force=true', {
          method: 'DELETE',
          headers: { 'x-playback-token': config.playbackToken },
          keepalive: true,
          credentials: 'omit',
          cache: 'no-store'
        }).catch(() => {});
      } catch {}
    });
  </script>
</body>
</html>`
}

export function renderDocsPage(): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Torrent Window Gateway</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:900px;margin:48px auto;padding:0 20px;color:#18202d}code{background:#eef1f5;padding:2px 6px;border-radius:5px}li{margin:.45rem 0}a{color:#0969da}</style></head><body><h1>Torrent Window Gateway</h1><p>Gateway de streaming por HTTP Range para conteúdo autorizado. Endpoints administrativos usam <code>Authorization: Bearer &lt;API_KEY&gt;</code>.</p><h2>Fluxo</h2><ol><li><code>POST /api/v1/torrents</code> com magnet ou bytes de um arquivo .torrent.</li><li>Consulte <code>GET /api/v1/torrents/:id</code> até <code>state=ready</code>.</li><li><code>POST /api/v1/playbacks</code> para gerar URL temporária do player/iframe.</li></ol><h2>Referência</h2><p><a href="/openapi.yaml">OpenAPI 3.1</a> · <a href="/">Informações da API</a> · <a href="/health">Health check</a></p></body></html>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  })[character] ?? character)
}
