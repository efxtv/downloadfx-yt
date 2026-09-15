import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { get as httpsGet } from 'node:https';
import { get as httpGet } from 'node:http';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

/* ================================================================
   PATHS & CONSTANTS
================================================================ */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIP_YTDLP = path.join(__dirname, '.venv', 'bin', 'yt-dlp');
const YTDLP = existsSync(PIP_YTDLP) ? PIP_YTDLP : path.join(__dirname, 'bin', 'yt-dlp');
const FFMPEG = path.join(__dirname, 'bin', 'ffmpeg');
const MAX_SCRIPT_MS = 300000;
const IMPERSONATE = existsSync(path.join(__dirname, '.venv', 'lib')) ? ['--impersonate', 'chrome'] : [];
const NODE_PATH = process.execPath;
const YT_CLIENTS = 'web_embedded,mweb,android';
const BGUTIL_PORT = 4416;
const BGUTIL_DIR = path.join(__dirname, 'bgutil-provider');
const VISITOR_TTL_MS = 30 * 60 * 1000;

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const MEDIA_EXTS = /\.(mp4|m4a|webm|ogg|opus|mp3|wav|flac|aac|mkv|avi|mov|ts|m3u8|m3u|mpd|vtt|srt)(\?.*)?$/i;
const STREAM_EXTS = /\.(m3u8|m3u|mpd)(\?.*)?$/i;
const OG_VIDEO_RE = /<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']([^"']+)["']/gi;
const OG_AUDIO_RE = /<meta[^>]+property=["']og:audio(?::url)?["'][^>]+content=["']([^"']+)["']/gi;
const TWITTER_PLAYER_RE = /<meta[^>]+(?:name|property)=["']twitter:player(?::stream)?["'][^>]+content=["']([^"']+)["']/gi;
const VIDEO_SRC_RE = /<video[^>]*\ssrc=["']([^"']+)["']/gi;
const SOURCE_SRC_RE = /<source[^>]*\ssrc=["']([^"']+)["']/gi;
const AUDIO_SRC_RE = /<audio[^>]*\ssrc=["']([^"']+)["']/gi;
const M3U8_IN_PAGE_RE = /(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/gi;
const MP4_IN_PAGE_RE = /(https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*)/gi;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ================================================================
   UTILITIES
================================================================ */
function sanitizeFilename(name) {
  return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) || 'download';
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '~size unknown';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, b = bytes;
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function extFromUrl(url) {
  try {
    const p = new URL(url).pathname.split('/').pop() || '';
    const m = p.match(/\.([a-z0-9]{2,6})$/i);
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

function extToMime(ext) {
  const map = { mp4:'video/mp4', webm:'video/webm', mkv:'video/x-matroska', m4a:'audio/mp4', mp3:'audio/mpeg', ogg:'audio/ogg', wav:'audio/wav', flac:'audio/flac', aac:'audio/aac', ts:'video/mp2t', avi:'video/x-msvideo', mov:'video/quicktime' };
  return map[(ext||'').toLowerCase()] || null;
}

/* ================================================================
   HTTP FETCH (with redirects + User-Agent)
================================================================ */
function httpFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? httpsGet : httpGet;
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: opts.method || 'GET',
      headers: { 'User-Agent': opts.userAgent || BROWSER_UA, ...(opts.headers || {}) },
      timeout: opts.timeout || 15000
    };
    const req = mod(reqOpts, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
        return resolve(httpFetch(loc, opts));
      }
      resolve({ status: res.statusCode, headers: res.headers, body: res });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchPageBody(url) {
  const res = await httpFetch(url, { timeout: 12000 });
  if (res.status < 200 || res.status >= 400) return null;
  const ct = (res.headers['content-type'] || '').toLowerCase();
  if (ct.includes('text/html') === false && !ct.includes('application/xhtml')) return null;
  return await collectStream(res.body);
}

function collectStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (d) => { chunks.push(d); if (chunks.join('').length > 4_000_000) stream.destroy(); });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

/* ================================================================
   yt-dlp runner
================================================================ */
function ytdlp(args) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP, args, { timeout: MAX_SCRIPT_MS, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr).trim().split('\n').slice(0, 12).join(' | ');
        reject(new Error(`yt-dlp failed: ${detail || err.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/* ================================================================
   YouTube anti-bot unlock (zero-credential)
   1. BgUtils POT provider (bgutil-provider/) — mints PO tokens
   2. Fresh visitor_data from youtube.com (cached 30 min)
   3. Node JS challenge solver for the `n` signature
=============================================================== */
let visitorCache = { data: null, ts: 0 };

function extractVisitorData(html) {
  let m = html.match(/"visitorData":"([A-Za-z0-9._%+\-=]+)"/);
  if (!m) m = html.match(/VISITOR_DATA["']?\s*[:=]\s*["']([A-Za-z0-9._%+\-=]+)["']/);
  if (m && !m[1].startsWith('Cg%')) return m[1];
  return null;
}

async function getVisitorData() {
  if (visitorCache.data && Date.now() - visitorCache.ts < VISITOR_TTL_MS) return visitorCache.data;
  try {
    const res = await httpFetch('https://www.youtube.com/', { timeout: 15000 });
    if (res.status >= 200 && res.status < 400) {
      const body = await collectStream(res.body);
      const vd = extractVisitorData(body);
      if (vd) { visitorCache = { data: vd, ts: Date.now() }; return vd; }
    }
  } catch { /* keep stale/absent */ }
  return visitorCache.data || null;
}

function bgutilListening() {
  return new Promise((resolve) => {
    const sock = net.connect(BGUTIL_PORT, '127.0.0.1');
    const done = (ok) => { try { sock.destroy(); } catch {} resolve(ok); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(800, () => done(false));
  });
}

let bgutilReady = false;

async function ensureBgutilProvider() {
  if (bgutilReady) return true;
  if (await bgutilListening()) { bgutilReady = true; return true; }
  const main = path.join(BGUTIL_DIR, 'build', 'main.js');
  if (!existsSync(main)) return false;
  try {
    const proc = spawn(NODE_PATH, [main], { cwd: BGUTIL_DIR, stdio: 'ignore', detached: true });
    proc.unref();
  } catch { return false; }
  for (let i = 0; i < 20; i++) {
    if (await bgutilListening()) { bgutilReady = true; return true; }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function youtubeExtractArgs(vd) {
  return `youtube:player_client=${YT_CLIENTS}${vd ? `;visitor_data=${vd}` : ''}`;
}

async function getUnlockArgs() {
  await ensureBgutilProvider();
  const vd = await getVisitorData();
  return { extract: youtubeExtractArgs(vd), runtimes: ['--js-runtimes', `node:${NODE_PATH}`] };
}

/* ================================================================
   STRATEGY 1: Direct file URL detection
================================================================ */
function detectDirectUrl(url) {
  const ext = extFromUrl(url);
  if (!ext || !MEDIA_EXTS.test('.' + ext)) return null;
  return {
    ok: true,
    provider: 'direct',
    providerName: 'Direct link',
    isKnownProvider: true,
    title: sanitizeFilename((new URL(url).pathname.split('/').pop() || 'download').replace(/\.[^.]+$/, '')),
    thumbnail: null,
    uploader: null,
    uploaderUrl: null,
    duration: null,
    webpageUrl: url,
    audio: [],
    video: [],
    progressive: [{
      formatId: 'direct',
      ext,
      height: 0, width: 0, fps: null,
      vcodec: 'unknown', acodec: 'unknown',
      tbr: 0, size: null, sizeText: '~size unknown',
      note: `Direct ${ext.toUpperCase()} file`,
      hasAudio: true, dynamicRange: null, container: ext
    }],
    bestAudio: null,
    bestVideo: null,
    bestProgressive: null,
    canMerge: false,
    audioExtractable: null,
    directUrl: url,
    directExt: ext
  };
}

/* ================================================================
   STRATEGY 2: yt-dlp extraction
=============================================================== */
function ytdlpAuthArgs() {
  const extra = [];
  const cookies = path.join(__dirname, 'cookies.txt');
  if (existsSync(cookies)) extra.push('--cookies', cookies);
  if (process.env.YTDLP_PROXY) extra.push('--proxy', process.env.YTDLP_PROXY);
  return extra;
}

function buildYtResult(data, url) {
  const { duration, audio, video, progressive, bestAudio, bestVideo, bestProgressive, canMerge } = classifyFormats(data);
  if (audio.length === 0 && video.length === 0 && progressive.length === 0) return null;

  const extractor = (data.extractor_key || '').toLowerCase();
  const supported = ['youtube', 'instagram', 'facebook', 'twitter', 'tiktok', 'vimeo', 'twitch', 'soundcloud', 'dailymotion'];

  return {
    ok: true,
    provider: extractor,
    providerName: data.extractor || extractor,
    isKnownProvider: supported.includes(extractor) || extractor === '',
    title: data.title || 'Untitled',
    thumbnail: data.thumbnail || null,
    uploader: data.uploader || data.channel || null,
    uploaderUrl: data.uploader_url || data.channel_url || null,
    duration: duration ? Math.round(duration) : null,
    webpageUrl: data.webpage_url || url,
    audio, video, progressive, bestAudio, bestVideo, bestProgressive, canMerge,
    audioExtractable: bestAudio ? bestAudio.formatId : (bestProgressive ? bestProgressive.formatId : null)
  };
}

async function tryYtdlp(url) {
  const { extract, runtimes } = await getUnlockArgs();

  let raw = null;
  try {
    raw = await ytdlp(['-J', '--no-playlist', '--no-warnings', '--socket-timeout', '30', ...runtimes, ...IMPERSONATE, ...ytdlpAuthArgs(), '--extractor-args', extract, url]);
  } catch (err) {
    const msg = (err.message || '').replace(/^yt-dlp failed:\s*/, '');
    return { result: null, reason: msg.includes('Unsupported URL') ? 'unsupported' : msg.slice(0, 250) };
  }

  let data;
  try { data = JSON.parse(raw); } catch { return { result: null, reason: 'yt-dlp returned invalid data for this link.' }; }

  const built = buildYtResult(data, url);
  if (!built) {
    const realFormats = (data.formats || []).filter(f => f.protocol !== 'mhtml' && (f.vcodec || 'none').toLowerCase() !== 'none');
    const onlyImages = (data.formats || []).some(f => f.protocol === 'mhtml') && realFormats.length === 0;
    return {
      result: null,
      reason: onlyImages
        ? 'YouTube returned only storyboard images for this link (the video may still be processing or is restricted). Try again in a few minutes or supply a cookies.txt for the bot check.'
        : 'No playable formats found for this link.'
    };
  }

  const maxH = Math.max(0, ...built.video.concat(built.progressive).map(f => f.height || 0));
  if (built.provider === 'youtube' && maxH < 720) {
    built.limitNote = '⚠ YouTube is restricting this video\u2019s quality (bot detection). Best available quality is shown.';
  }
  return { result: built, reason: null };
}

/* ================================================================
   STRATEGY 3: HTML page scraping
================================================================ */
async function scrapeForMedia(url) {
  let html;
  try {
    html = await fetchPageBody(url);
  } catch { return null; }
  if (!html) return null;

  const found = new Map();

  const grab = (re) => {
    let m;
    while ((m = re.exec(html)) !== null) {
      let href = m[1];
      try {
        if (href.startsWith('//')) href = 'https:' + href;
        else if (href.startsWith('/')) href = new URL(href, url).href;
        else if (!href.startsWith('http')) href = new URL(href, url).href;
        const ext = extFromUrl(href);
        if (ext && MEDIA_EXTS.test('.' + ext)) found.set(href, ext);
      } catch { /* skip invalid URLs */ }
    }
  };

  // OpenGraph + Twitter tags
  [OG_VIDEO_RE, OG_AUDIO_RE, TWITTER_PLAYER_RE].forEach(grab);

  // <video> and <source> src attributes
  [VIDEO_SRC_RE, SOURCE_SRC_RE, AUDIO_SRC_RE].forEach(grab);

  // Inline m3u8 and mp4 URLs in page source
  grab(M3U8_IN_PAGE_RE);
  grab(MP4_IN_PAGE_RE);

  if (found.size === 0) return null;

  // Dedupe, prefer m3u8 (streaming) and mp4
  const entries = [...found.entries()].sort((a, b) => {
    const streamScore = STREAM_EXTS.test('.' + b[1]) ? 1 : 0;
    const streamScoreA = STREAM_EXTS.test('.' + a[1]) ? 1 : 0;
    return streamScore - streamScoreA;
  });

  const title = scrapeTitle(html) || new URL(url).hostname;
  const items = entries.map(([href, ext], i) => ({
    formatId: `scrape-${i}`,
    ext,
    height: 0, width: 0, fps: null,
    vcodec: 'unknown', acodec: 'unknown',
    tbr: 0, size: null, sizeText: STREAM_EXTS.test('.' + ext) ? 'stream' : '~size unknown',
    note: STREAM_EXTS.test('.' + ext) ? 'HLS / DASH stream' : `Scraped from page`,
    hasAudio: true, dynamicRange: null, container: ext,
    scrapeUrl: href
  }));

  return {
    ok: true,
    provider: 'scraped',
    providerName: 'Scraped from page',
    isKnownProvider: false,
    title,
    thumbnail: scrapeThumbnail(html, url),
    uploader: null,
    uploaderUrl: null,
    duration: null,
    webpageUrl: url,
    audio: [],
    video: [],
    progressive: items,
    bestAudio: null,
    bestVideo: null,
    bestProgressive: items[0] || null,
    canMerge: false,
    audioExtractable: null,
    scraped: true
  };
}

function scrapeTitle(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return og[1];
  const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return t ? t[1].trim() : null;
}

function scrapeThumbnail(html, pageUrl) {
  const og = html.match(/<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i);
  if (og) {
    let href = og[1];
    if (href.startsWith('//')) href = 'https:' + href;
    else if (href.startsWith('/')) try { href = new URL(href, pageUrl).href; } catch {}
    return href;
  }
  return null;
}

/* ================================================================
   Multi-strategy resolver
================================================================ */
async function resolveUrl(url) {
  // Strategy 1: direct file URL
  const direct = detectDirectUrl(url);
  if (direct) return direct;

  // Strategy 2: yt-dlp
  const ytd = await tryYtdlp(url);
  if (ytd.result) return ytd.result;

  // Strategy 3: scrape HTML for media sources
  const scraped = await scrapeForMedia(url);
  if (scraped) return scraped;

  // Nothing worked — surface the real reason when we have one
  const reason = ytd.reason && ytd.reason !== 'unsupported'
    ? ` The host said: "${ytd.reason}".`
    : ' The site may be private, region-locked, login-protected, or blocking automated access.';
  return { ok: false, error: `Could not find any downloadable media on this link.${reason} Try a different link or provide a direct URL to a video/audio file.` };
}

/* ================================================================
   Format classification (yt-dlp formats)
================================================================ */
function estimateSize(fmt, duration) {
  const kbps = fmt.tbr || fmt.abr || fmt.vbr || 0;
  if (duration && kbps) return Math.round(kbps * 1000 * duration / 8);
  return fmt.filesize || fmt.filesize_approx || null;
}

function classifyFormats(data) {
  const duration = Number(data.duration) || null;
  const audio = [], video = [], progressive = [];

  const rawFormats = data.formats || [];
  const baseIds = new Set(rawFormats.map(f => String(f.format_id).replace(/-drc$/, '')));
  const formats = rawFormats.filter(f => {
    const id = String(f.format_id);
    return id.endsWith('-drc') ? !baseIds.has(id.replace(/-drc$/, '')) : true;
  });

  for (const f of formats) {
    const vcodec = (f.vcodec || 'none').toLowerCase();
    const acodec = (f.acodec || 'none').toLowerCase();
    if (vcodec === 'none' && acodec !== 'none') {
      audio.push({ formatId: String(f.format_id), ext: f.ext || 'audio', abr: f.abr ? Math.round(f.abr) : Math.round(f.tbr || 0), size: estimateSize(f, duration), sizeText: fmtBytes(estimateSize(f, duration)), note: (f.format_note || '').replace(/^audio only\s*/, '') || 'audio', asr: f.asr || null, container: f.ext });
    } else if (vcodec !== 'none') {
      const hasAudio = acodec !== 'none';
      const item = { formatId: String(f.format_id), ext: f.ext || 'video', height: f.height || 0, width: f.width || 0, fps: f.fps || null, vcodec: f.vcodec || '', acodec: f.acodec || '', tbr: f.tbr ? Math.round(f.tbr) : 0, size: estimateSize(f, duration), sizeText: fmtBytes(estimateSize(f, duration)), note: (f.format_note || '').replace(/^video only\s*/, '') || '', hasAudio, dynamicRange: f.dynamic_range === 'HDR' ? 'HDR' : null, container: f.ext };
      if (hasAudio) progressive.push(item); else video.push(item);
    }
  }

  const qr = (a, b) => (b.dynamicRange !== a.dynamicRange ? (b.dynamicRange ? 1 : -1) : (b.height !== a.height ? (b.height || 0) - (a.height || 0) : (b.width !== a.width ? (b.width || 0) - (a.width || 0) : (b.tbr || 0) - (a.tbr || 0))));
  progressive.sort(qr); video.sort(qr); audio.sort((a, b) => (a.abr || 0) - (b.abr || 0));

  return {
    duration, audio, video, progressive,
    bestAudio: audio[audio.length - 1] || null,
    bestVideo: video[0] || null,
    bestProgressive: progressive[0] || null,
    canMerge: video.length > 0 && audio.length > 0
  };
}

/* ================================================================
   Download jobs with progress
================================================================ */
const jobs = new Map();

async function dirBytes(dir) {
  try {
    let total = 0;
    for (const f of await readdir(dir)) { const s = await stat(path.join(dir, f)).catch(() => null); if (s) total += s.size; }
    return total;
  } catch { return 0; }
}

function pollJobBytes(job, dir) {
  return setInterval(async () => { if (job.done) return; job.written = await dirBytes(dir); }, 250);
}

async function cleanupJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.done = true;
  clearInterval(job.timer);
  await rm(job.dir, { recursive: true, force: true }).catch(() => {});
  jobs.delete(jobId);
}

/* ----------------------------------------------------------------
   Orphan temp-file sweeper
   Removes any leftover downloadfx-* temp dirs (e.g. after a crash,
   server restart, or an aborted client connection).
---------------------------------------------------------------- */
const ORPHAN_MAX_AGE_MS = 30 * 60 * 1000;

async function sweepOrphans() {
  const now = Date.now();
  try {
    const entries = await readdir(tmpdir());
    for (const name of entries) {
      if (!name.startsWith('downloadfx-')) continue;
      const full = path.join(tmpdir(), name);
      try {
        const st = await stat(full);
        if (!st.isDirectory()) continue;
        if (now - st.mtimeMs > ORPHAN_MAX_AGE_MS) {
          await rm(full, { recursive: true, force: true });
          console.log(`[sweeper] removed orphaned temp dir ${name}`);
        }
      } catch { /* unreadable — skip */ }
    }

    for (const [id, job] of jobs) {
      if (job.done && (now - (job.ts || 0) > ORPHAN_MAX_AGE_MS)) jobs.delete(id);
    }
  } catch { /* noop */ }
}

sweepOrphans();
setInterval(sweepOrphans, 10 * 60 * 1000).unref();

/* ================================================================
   STREAM: Direct URL download (no yt-dlp)
================================================================ */
async function streamDirect(url, job, res, title, ext) {
  job.stage = 'streaming';
  const tmpPath = path.join(job.dir, `file.${ext}`);

  try {
    const response = await httpFetch(url, { timeout: 60000 });
    if (response.status < 200 || response.status >= 400) throw new Error(`HTTP ${response.status}`);

    const total = Number(response.headers['content-length']) || 0;
    job.total = total || job.total;

    const stream = response.body;
    const ws = (await import('node:fs')).createWriteStream(tmpPath);
    let written = 0;

    await new Promise((resolve, reject) => {
      stream.on('data', (chunk) => { written += chunk.length; job.written = written; });
      stream.pipe(ws);
      stream.on('end', resolve);
      stream.on('error', reject);
      ws.on('error', reject);
    });
  } catch (err) {
    await cleanupJob(job.id);
    return res.status(500).json({ error: `Direct download failed: ${err.message}` });
  }

  job.stage = 'done';
  job.done = true;
  clearInterval(job.timer);

  const outTitle = `${title}.${ext}`;
  res.download(tmpPath, outTitle, async () => { await cleanupJob(job.id); });
}

/* ================================================================
   STREAM: Scraped URL download (yt-dlp with format URL)
================================================================ */
async function streamScraped(scrapeUrl, job, res, title, ext) {
  job.stage = 'fetching media';
  const tmpPath = path.join(job.dir, `file.${ext}`);

  // Try yt-dlp first on the scraped URL (handles m3u8/dash well)
  try {
    const args = ['-f', 'best', '--no-playlist', '--no-warnings', '--socket-timeout', '30', '--ffmpeg-location', FFMPEG, ...IMPERSONATE, '-o', tmpPath, scrapeUrl];
    const proc = spawn(YTDLP, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const errs = [];
    proc.stderr.on('data', d => { if (errs.length < 6) errs.push(String(d).trim()); });

    await new Promise((resolve, reject) => {
      proc.on('error', reject);
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(errs.join(' | ') || `exit ${code}`)));
    });

    job.stage = 'done'; job.done = true; clearInterval(job.timer);
    res.download(tmpPath, `${title}.${ext}`, async () => { await cleanupJob(job.id); });
  } catch {
    // Fallback: direct HTTP stream
    await streamDirect(scrapeUrl, job, res, title, ext);
  }
}

/* ================================================================
   STREAM: yt-dlp based download (existing logic, enhanced)
================================================================ */
async function streamYtdlp(url, formatId, job, res, title, ext, kind, merge) {
  const { extract, runtimes } = await getUnlockArgs();
  let args;
  if (kind === 'mp3') {
    job.stage = 'extracting audio';
    args = ['-f', `${formatId}/bestaudio/best`, '-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', `${path.join(job.dir, 'file')}.%(ext)s`, url];
  } else if (kind === 'audio') {
    job.stage = 'streaming audio';
    args = ['-f', `${formatId}/bestaudio/best`, '-o', path.join(job.dir, `file.${ext}`), url];
  } else if (merge) {
    job.stage = 'muxing video + audio';
    args = ['-f', `${formatId}+bestaudio[ext=m4a]/bestaudio/bestvideo+bestaudio/best`, '--merge-output-format', ext.startsWith('mp4') ? 'mp4' : ext, '-o', path.join(job.dir, `file.${ext}`), url];
  } else {
    job.stage = 'streaming video';
    args = ['-f', `${formatId}/best[ext=mp4]/best`, '-o', path.join(job.dir, `file.${ext}`), url];
  }

  const proc = spawn(YTDLP, ['--no-warnings', '--no-playlist', '--socket-timeout', '30', '--ffmpeg-location', FFMPEG, ...IMPERSONATE, ...ytdlpAuthArgs(), ...runtimes, '--extractor-args', extract, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  const errs = [];
  proc.stderr.on('data', d => { if (errs.length < 6) errs.push(String(d).trim()); });

  await new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(errs.join(' | ') || `exit ${code}`)));
  });

  let finalPath = path.join(job.dir, `file.${ext}`);
  try { await stat(finalPath); } catch {
    const files = await readdir(job.dir);
    const match = files.find(f => /^file\./.test(f));
    finalPath = match ? path.join(job.dir, match) : finalPath;
  }

  job.stage = 'done'; job.done = true; clearInterval(job.timer);
  res.download(finalPath, `${title}.${ext}`, async () => { await cleanupJob(job.id); });
}

/* ================================================================
   ROUTES
================================================================ */
app.post('/api/info', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Please enter a URL.' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'URL must start with http:// or https://' });

  try {
    const result = await resolveUrl(url);
    if (!result.ok) return res.status(422).json({ error: result.error });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Something went wrong resolving this URL.' });
  }
});

app.get('/api/progress', (req, res) => {
  const job = jobs.get(String(req.query.id || ''));
  if (!job) return res.json({ ok: false });
  const pct = job.total > 0 ? Math.min(99, Math.round((job.written / job.total) * 100)) : 0;
  res.json({ ok: true, status: job.done ? 'done' : 'working', written: job.written, total: job.total, pct, stage: job.stage, error: job.error || null });
});

app.get('/api/download', async (req, res) => {
  const url = String(req.query.url || '').trim();
  const formatId = String(req.query.formatId || '').trim();
  const title = sanitizeFilename(String(req.query.title || 'download'));
  const ext = String(req.query.ext || 'mp4').replace(/[^a-z0-9]/gi, '');
  const kind = String(req.query.kind || 'video');
  const jobId = String(req.query.job || `j${randomBytes(6).toString('hex')}`).slice(0, 64);

  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Missing url.' });

  const jobDir = await mkdtemp(path.join(tmpdir(), 'downloadfx-'));
  const safeExt = ext || 'mp4';

  if (jobs.has(jobId)) await cleanupJob(jobId);
  const job = { id: jobId, dir: jobDir, total: Math.max(0, Number(req.query.size) || 0), written: 0, stage: 'preparing', done: false, error: null, timer: null, ts: Date.now() };
  job.timer = pollJobBytes(job, jobDir);
  jobs.set(jobId, job);

  try {
    // Direct file download (no formatId needed)
    if (formatId === 'direct') {
      return await streamDirect(url, job, res, title, safeExt);
    }

    // Scraped source download
    if (formatId && formatId.startsWith('scrape-') && req.query.scrapeUrl) {
      return await streamScraped(req.query.scrapeUrl, job, res, title, safeExt);
    }

    // yt-dlp based download
    await streamYtdlp(url, formatId, job, res, title, safeExt, kind, String(req.query.merge) === 'true');
  } catch (err) {
    job.error = err.message;
    await cleanupJob(jobId);
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3100;
app.listen(PORT, async () => {
  console.log(`DownloadFX running → http://localhost:${PORT}`);
  console.log(`yt-dlp: ${YTDLP} (${existsSync(PIP_YTDLP) ? 'pip+impersonation' : 'standalone'})`);

  const pot = await ensureBgutilProvider();
  console.log(`PO token provider: ${pot ? `running (bgutil :${BGUTIL_PORT})` : 'unavailable (gated YouTube videos may be capped to low quality)'}`);

  const vd = await getVisitorData();
  console.log(`YouTube visitor data: ${vd ? `ok (${vd.slice(0, 10)}…)` : 'unavailable'}`);
});