/* ---------------- Ambient wisp (stealth background) ---------------- */
(() => {
  const wisp = document.getElementById('wisp');
  if (!wisp || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  let wx = innerWidth * 0.5;
  let wy = innerHeight * 0.4;
  let lastMove = 0;
  let idleTimer = null;

  wisp.style.transform = `translate(${wx}px, ${wy}px)`;
  wisp.style.opacity = '0';
  requestAnimationFrame(() => {
    wisp.style.transition = 'opacity 1400ms ease';
    wisp.style.opacity = '0.8';
  });

  function glide(tx, ty, dur) {
    const cur = getComputedStyle(wisp).transform;
    const from = cur !== 'none' ? cur : 'matrix(1,0,0,1,0,0)';
    wisp.getAnimations().forEach((a) => a.cancel());
    wisp.animate(
      [
        { transform: from },
        { transform: `translate(${tx}px, ${ty}px)` },
      ],
      { duration: dur, easing: 'cubic-bezier(.25,1,.35,1)', fill: 'both' }
    );
  }

  function goHome() {
    glide(
      innerWidth * (0.08 + Math.random() * 0.84),
      innerHeight * (0.12 + Math.random() * 0.74),
      1500
    );
  }

  addEventListener('pointermove', (e) => {
    const now = performance.now();
    if (now - lastMove < 70) return;
    lastMove = now;
    clearTimeout(idleTimer);
    const ang = Math.random() * Math.PI * 2;
    const gap = 26 + Math.random() * 44;
    const tx = e.clientX + Math.cos(ang) * gap;
    const ty = e.clientY + Math.sin(ang) * gap;
    const dist = Math.hypot(tx - wx, ty - wy);
    glide(tx, ty, 220 + Math.min(680, dist * 1.1));
    wx = tx;
    wy = ty;
    idleTimer = setTimeout(goHome, 2200);
  });
  document.addEventListener('mouseleave', goHome);
})();

/* ---------------- App logic ---------------- */
const $ = (id) => document.getElementById(id);
const form = $('dl-form');
const input = $('url-input');
const goBtn = $('go-btn');
const status = $('status');
const modal = $('modal');

/* ---- Draggable, minimizable panel ---- */
const panel = $('panel');
const minimizeBtn = $('minimize-btn');
const restoreBtn = $('restore-btn');

let px = (innerWidth - panel.offsetWidth) / 2;
let py = (innerHeight - panel.offsetHeight) / 2;
let minimized = false;

function applyPanelPos() {
  panel.style.transform = `translate(${px}px, ${py}px)`;
}
applyPanelPos();

function fitPanel() {
  px = Math.max(-panel.offsetWidth * 0.25, Math.min(px, innerWidth - panel.offsetWidth * 0.75));
  py = Math.max(-panel.offsetHeight * 0.2, Math.min(py, innerHeight - panel.offsetHeight * 0.8));
  applyPanelPos();
}
addEventListener('resize', () => { if (!minimized) fitPanel(); });

let dragging = false;
let dragX = 0;
let dragY = 0;
let ox = 0;
let oy = 0;

panel.addEventListener('pointerdown', (e) => {
  if (minimized || e.target.closest('input, button, textarea, select, a')) return;
  dragging = true;
  dragX = e.clientX;
  dragY = e.clientY;
  ox = px;
  oy = py;
  panel.classList.add('dragging');
  panel.setPointerCapture(e.pointerId);
});

panel.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  px = ox + (e.clientX - dragX);
  py = oy + (e.clientY - dragY);
  clampPos();
  applyPanelPos();
});

function clampPos() {
  px = Math.max(-panel.offsetWidth * 0.25, Math.min(px, innerWidth - panel.offsetWidth * 0.75));
  py = Math.max(-panel.offsetHeight * 0.2, Math.min(py, innerHeight - panel.offsetHeight * 0.8));
}

function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  panel.classList.remove('dragging');
  if (panel.hasPointerCapture(e.pointerId)) panel.releasePointerCapture(e.pointerId);
}
panel.addEventListener('pointerup', endDrag);
panel.addEventListener('pointercancel', endDrag);

const cornerX = 14;
function cornerY() { return innerHeight - 150; }

function minimizePanel() {
  if (minimized) return;
  minimized = true;
  panel.classList.add('minimizing');
  const anim = panel.animate(
    [
      { transform: `translate(${px}px, ${py}px)`, opacity: 1 },
      { transform: `translate(${cornerX}px, ${cornerY()}px) scale(0.05)`, opacity: 0 },
    ],
    { duration: 420, easing: 'cubic-bezier(.6,0,.8,.4)', fill: 'forwards' }
  );
  anim.onfinish = () => {
    panel.style.transform = `translate(${cornerX}px, ${cornerY()}px) scale(0.05)`;
    panel.style.opacity = '0';
    panel.classList.add('hidden');
    panel.classList.remove('dragging');
    restoreBtn.classList.remove('hidden');
  };
}

function restorePanel() {
  if (!minimized) return;
  minimized = false;
  restoreBtn.classList.add('hidden');
  panel.getAnimations().forEach((a) => a.cancel());
  panel.classList.remove('hidden', 'minimizing');
  panel.style.opacity = '0';
  panel.style.transform = `translate(${cornerX}px, ${cornerY()}px) scale(0.05)`;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const anim = panel.animate(
      [
        { transform: `translate(${cornerX}px, ${cornerY()}px) scale(0.05)`, opacity: 0 },
        { transform: `translate(${px}px, ${py}px)`, opacity: 1 },
      ],
      { duration: 420, easing: 'cubic-bezier(.34,1.3,.64,1)', fill: 'forwards' }
    );
    anim.onfinish = () => {
      panel.style.transform = `translate(${px}px, ${py}px)`;
      panel.style.opacity = '1';
    };
  }));
}

minimizeBtn.addEventListener('click', minimizePanel);
restoreBtn.addEventListener('click', restorePanel);

const PROVIDER_CLASS = { youtube: 'yt', instagram: 'ig', facebook: 'fb' };
const PROVIDER_ICON = { youtube: '▶', instagram: '◼', facebook: 'ⓕ', tiktok: '♫', twitter: '𝕏' };

let currentInfo = null;
let dlToken = 0;

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = input.value.trim();
  if (!url) return;
  status.classList.add('hidden');
  status.classList.remove('ok');
  goBtn.disabled = true;
  goBtn.querySelector('.go-text').textContent = 'Fetching…';

  try {
    const res = await fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Something went wrong.');
    currentInfo = data;
    renderModal(data);
    openModal();
  } catch (err) {
    showStatus(err.message || 'Failed to fetch video info.');
  } finally {
    goBtn.disabled = false;
    goBtn.querySelector('.go-text').textContent = 'Go';
  }
});

function showStatus(msg, ok = false) {
  status.textContent = msg;
  status.classList.toggle('ok', ok);
  status.classList.remove('hidden');
}
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 5000);
}

/* ---------------- Modal ---------------- */
function openModal() { modal.classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
function closeModal() { modal.classList.add('hidden'); document.body.style.overflow = ''; }
$('modal-close').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target.classList.contains('modal-backdrop')) closeModal(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal(); });

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const tabName = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.tab === tabName));
  });
});

function fmtDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return (h ? `${h}:` : '') + `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function renderModal(d) {
  $('m-thumb').src = d.thumbnail || '';
  $('m-thumb').style.display = d.thumbnail ? '' : 'none';
  const icon = PROVIDER_ICON[d.provider] || '🎥';
  const badge = $('m-provider');
  badge.textContent = `${icon} ${d.providerName || d.provider}`;
  badge.className = `provider-badge ${PROVIDER_CLASS[d.provider] || ''}`;
  $('m-title').textContent = d.title;
  $('m-uploader').textContent = d.uploader || '';
  $('m-uploader').style.display = d.uploader ? '' : 'none';
  $('m-duration').textContent = fmtDuration(d.duration);
  $('m-duration').style.display = d.duration ? '' : 'none';

  const note = $('m-note');
  note.textContent = d.limitNote || '';
  note.classList.toggle('hidden', !d.limitNote);

  renderVideoTab(d);
  renderAudioTab(d);
}

/* ---------------- Video tab ---------------- */
function pickBestPerQuality(rows) {
  const map = new Map();
  for (const f of rows) {
    if (f.scrapeUrl || f.formatId === 'direct') { map.set(`${f.formatId}-${f.ext}`, f); continue; }
    const key = `${f.height || 0}-${f.dynamicRange || ''}`;
    const cur = map.get(key);
    const sizeA = f.size || 0;
    const sizeB = cur ? cur.size || 0 : -1;
    const better = sizeA > sizeB || (sizeA === sizeB && f.hasAudio && !cur);
    if (!cur || better) map.set(key, f);
  }
  return [...map.values()].sort((a, b) => (b.height || 0) - (a.height || 0));
}

function renderVideoTab(d) {
  const list = $('video-list');
  const rows = pickBestPerQuality([...d.progressive, ...d.video]);

  if (rows.length === 0) {
    list.innerHTML = '<p class="empty-note">No video formats found for this link.</p>';
    return;
  }

  list.innerHTML = '';
  rows.forEach((f, i) => {
    const el = document.createElement('div');
    el.className = 'vitem';
    el.style.animationDelay = `${Math.min(i * 45, 400)}ms`;

    const quality = f.height ? `${f.height}p` : (f.note === 'HLS / DASH stream' ? '🔴 STREAM' : 'Best');
    const badges = [];
    if (f.dynamicRange) badges.push('<span class="badge hdr">HDR</span>');
    if (f.hasAudio || f.scrapeUrl) badges.push('<span class="badge both">AV</span>');
    else badges.push('<span class="badge novideo">audio auto-added</span>');
    if (f.scrapeUrl) badges.push('<span class="badge novideo">⚡ scraped</span>');

    const meta = [
      f.fps && f.fps >= 60 ? `${Math.round(f.fps)}fps` : null,
      f.note || null,
      cleanCodec(f.vcodec)
    ].filter(Boolean);

    const urlAttr = f.scrapeUrl ? ` data-scrapeurl="${encodeURIComponent(f.scrapeUrl)}"` : '';
    const kind = f.scrapeUrl ? 'scraped' : (f.formatId === 'direct' ? 'direct' : 'video');

    el.innerHTML = `
      <div class="vquality">${quality}</div>
      <div class="vmeta">
        <div class="vline1">${badges.join('')} <span>${(f.ext || '').toUpperCase()}</span></div>
        <div class="vline2">${meta.join(' · ') || 'Best available quality'}</div>
      </div>
      <span class="size">${f.sizeText}</span>
      <button class="dl-btn" data-format="${f.formatId}" data-ext="${f.ext}" data-merge="${!f.hasAudio && !f.scrapeUrl}" data-kind="${kind}"${urlAttr}>⬇ Download</button>
    `;
    list.appendChild(el);
  });
}

/* ---------------- Audio tab ---------------- */
function renderAudioTab(d) {
  const hasPure = Array.isArray(d.audio) && d.audio.length > 0;
  const extractable = d.audioExtractable;

  const mp3Btn = $('mp3-btn');
  if (extractable) {
    mp3Btn.classList.remove('hidden');
    mp3Btn.dataset.format = extractable;
    mp3Btn.textContent = hasPure ? '🎧 Best audio as MP3' : '🎧 Extract audio as MP3 (from video)';
  } else {
    mp3Btn.classList.add('hidden');
  }

  const toggle = $('audio-toggle');
  const list = $('audio-list');
  const count = $('audio-count');
  count.textContent = hasPure ? `${d.audio.length}` : '0';
  list.innerHTML = '';

  if (hasPure) {
    d.audio.forEach((f, i) => {
      const el = document.createElement('div');
      el.className = 'aitem';
      el.style.animationDelay = `${Math.min(i * 35, 350)}ms`;
      const bitrate = f.abr ? `${f.abr} kbps` : f.asr ? `${Math.round(f.asr / 1000)} kHz` : 'original';
      const sizeText = /unknown/i.test(f.sizeText) ? '' : `<span class="size">${f.sizeText}</span>`;
      el.innerHTML = `
        <span class="a-badge">${bitrate}</span>
        <div class="a-meta"><b>${(f.ext || '').toUpperCase()}</b> ${f.note ? '· ' + f.note : ''}</div>
        ${sizeText}
        <button class="dl-btn" data-format="${f.formatId}" data-ext="${f.ext}" data-merge="false" data-kind="audio">⬇</button>
      `;
      list.appendChild(el);
    });
    if (d.audio.length <= 3) {
      toggle.classList.add('open');
      list.classList.add('expanded');
    } else {
      toggle.classList.remove('open');
      list.classList.remove('expanded');
    }
  } else {
    toggle.classList.remove('open');
    list.classList.remove('expanded');
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = d.bestProgressive
      ? 'This link has no standalone audio track. Use the MP3 button above to extract the audio from the video.'
      : 'No audio could be extracted from this link.';
    list.appendChild(note);
    toggle.querySelector('.count').textContent = '0';
  }
}

function cleanCodec(codec) {
  if (!codec || codec === 'none') return '';
  return codec.split('.')[0];
}

$('audio-toggle').addEventListener('click', () => {
  const t = $('audio-toggle');
  const l = $('audio-list');
  t.classList.toggle('open');
  l.classList.toggle('expanded');
});

$('mp3-btn').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  if (!btn.dataset.format) return showToast('No audio available for this link.');
  startDownload({
    url: currentInfo.webpageUrl,
    formatId: btn.dataset.format,
    ext: 'mp3',
    merge: false,
    kind: 'mp3',
    filename: `${currentInfo.title}.mp3`,
    size: currentInfo.bestAudio?.size || 0
  });
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.dl-btn[data-format]');
  if (!btn || btn.disabled) return;
  const { format, ext, merge, kind } = btn.dataset;
  const scrapeUrl = btn.dataset.scrapeurl ? decodeURIComponent(btn.dataset.scrapeurl) : null;
  if (!currentInfo) return;

  if (kind === 'direct') {
    startDownload({
      jumpUrl: currentInfo.directUrl || currentInfo.webpageUrl,
      url: currentInfo.directUrl || currentInfo.webpageUrl,
      formatId: 'direct',
      ext,
      merge: false,
      kind: 'direct',
      filename: `${currentInfo.title}.${ext}`,
      size: 0
    });
    return;
  }

  if (kind === 'scraped' && scrapeUrl) {
    startDownload({
      jumpUrl: scrapeUrl,
      url: currentInfo.webpageUrl,
      formatId: format,
      ext,
      merge: false,
      kind: 'scraped',
      filename: `${currentInfo.title}.${ext}`,
      size: 0
    });
    return;
  }

  const fmt = [...(currentInfo.video || []), ...(currentInfo.progressive || []), ...(currentInfo.audio || [])]
    .find((x) => x.formatId === format);
  startDownload({
    jumpUrl: null,
    url: currentInfo.webpageUrl,
    formatId: format,
    ext,
    merge: merge === 'true',
    kind,
    filename: `${currentInfo.title}.${ext}`,
    size: fmt?.size || 0
  });
});

/* ---------------- Download with progress ---------------- */
function setBar(pct, label, sizeText, waiting=false) {
  const bar = $('progress-bar');
  bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  bar.classList.toggle('waiting', waiting);
  $('progress-pct').textContent = label;
  $('progress-size').textContent = sizeText || '';
}

function startDownload(dl) {
  const token = ++dlToken;
  const overlay = $('progress');
  overlay.classList.remove('hidden');
  $('progress-name').textContent = dl.filename;

  dl.job = dl.job || `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  setBar(0, 'Preparing…', '', true);

  let serverPct = -1;
  let pollStopped = false;
  const pollTimer = setInterval(async () => {
    if (pollStopped || token !== dlToken) return;
    try {
      const r = await fetch(`/api/progress?id=${encodeURIComponent(dl.job)}`);
      const j = await r.json();
      if (!j.ok || token !== dlToken) return;
      if (j.error) {
        clearInterval(pollTimer); pollStopped = true;
        overlay.classList.add('hidden');
        showToast(j.error.replace(/^Error:\s*/i, ''));
        return;
      }
      serverPct = Math.max(serverPct, j.pct || 0);
      const label = j.status === 'done'
        ? 'Finalising…'
        : `${stageLabel(j.stage)}${j.pct ? ' · ' + Math.round(j.pct) + '%' : ''}`;
      setBar(serverPct, label, '', serverPct === 0);
    } catch { /* transient, keep polling */ }
  }, 350);

  const params = new URLSearchParams({
    url: dl.url,
    formatId: dl.formatId,
    ext: dl.ext,
    merge: String(dl.merge),
    kind: dl.kind,
    title: dl.filename,
    size: String(dl.size || 0),
    job: dl.job
  });
  if (dl.kind === 'scraped' && dl.jumpUrl) params.set('scrapeUrl', dl.jumpUrl);
  if (dl.kind === 'direct' && dl.jumpUrl) params.set('url', dl.jumpUrl);

  fetch(`/api/download?${params}`)
    .then(async (res) => {
      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        throw new Error(errData?.error || `Download failed (${res.status}).`);
      }
      const total = Number(res.headers.get('Content-Length')) || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      let keepPolling = serverPct >= 0 && serverPct < 100;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        const base = Math.max(0, serverPct);
        const scaleRemain = Math.max(0.01, 100 - base);
        const localPct = total ? (received / total) * scaleRemain : 0;
        if (total && Math.round(localPct) >= 1) keepPolling = false;
        setBar(base + localPct, total ? 'Transferring to you…' : 'Downloading…', total ? `${hb(received)} / ${hb(total)}` : hb(received));
      }
      if (keepPolling) { }

      const blob = new Blob(chunks);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = dl.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);

      if (token === dlToken) {
        setBar(100, 'Done!', total ? hb(total) : hb(received));
        setTimeout(() => { if (token === dlToken) overlay.classList.add('hidden'); }, 1000);
      }
    })
    .catch((err) => {
      if (token !== dlToken) return;
      overlay.classList.add('hidden');
      showToast(err.message.replace(/^Error:\s*/i, ''));
    })
    .finally(() => {
      clearInterval(pollTimer);
      pollStopped = true;
    });
}

function stageLabel(stage) {
  const map = {
    'preparing': 'Contacting host…',
    'streaming video': 'Downloading video…',
    'muxing video + audio': 'Combining video + audio…',
    'extracting audio': 'Extracting audio…',
    'streaming audio': 'Downloading audio…',
    'streaming': 'Downloading file…',
    'fetching media': 'Fetching media stream…',
    'done': 'Finalising…'
  };
  return map[stage] || 'Working…';
}

function hb(b) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

input.addEventListener('paste', () => { status.classList.add('hidden'); });