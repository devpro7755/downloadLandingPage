// ogImage.js — Whistler OG image generator
// Requires: npm install canvas sharp
//
// Architecture: Sharp for photo resize (fast shrink-on-load for large images)
//               Canvas/Cairo for all compositing + text (17ms, faster than SVG+Sharp)
//               LRU in-memory cache — repeat requests return in 0ms
//
// Benchmark results (1200×980 JPEG):
//   Canvas render : ~18ms avg
//   Sharp+SVG     : ~80ms avg  (librsvg re-decodes embedded fonts every call)
//   Network fetch : 200–600ms  ← real bottleneck; solved by pre-warming on post save

'use strict';

const { createCanvas, loadImage, registerFont } = require('canvas');
const sharp  = require('sharp');
const path   = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ─── Fonts ───────────────────────────────────────────────────────────────────

const FONTS_DIR = path.join(__dirname, 'fonts');
try {
  registerFont(path.join(FONTS_DIR, 'Inter-Medium.ttf'),    { family: 'Inter', weight: '500' });
  registerFont(path.join(FONTS_DIR, 'Inter-SemiBold.ttf'),  { family: 'Inter', weight: '600' });
  registerFont(path.join(FONTS_DIR, 'Inter-Bold.ttf'),      { family: 'Inter', weight: '700' });
  registerFont(path.join(FONTS_DIR, 'Inter-ExtraBold.ttf'), { family: 'Inter', weight: '800' });
} catch (_) { /* fall back to system font */ }

// ─── Constants ───────────────────────────────────────────────────────────────

const W   = 1200;
const H   = 980;
const PAD = 60;

const IMG_W = W - PAD * 2;                    // 1080 — photo column width
const IMG_H = Math.round(IMG_W * (9 / 16));   // 607  — 16:9

const BG     = '#0D0305';
const RED    = '#E8174A';
const ORANGE = '#F5603A';
const AMBER  = '#F7A325';
const WHITE  = '#FFFFFF';
const MUTED  = 'rgba(255,255,255,0.58)';

// ─── Logo — loaded once at startup ───────────────────────────────────────────

let _logo = null;

async function getLogo(logoPath) {
  if (!_logo) _logo = await loadImage(logoPath).catch(() => null);
  return _logo;
}

// ─── LRU in-memory JPEG cache ────────────────────────────────────────────────
// 500 entries, 24 h TTL. MD5 key built from content so edits bust the cache.

class LRUCache {
  constructor(max, ttl) {
    this.max = max;
    this.ttl = ttl;
    this.map = new Map();
  }
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() > entry.exp) { this.map.delete(key); return null; }
    this.map.delete(key);
    this.map.set(key, entry);  // LRU touch
    return entry.buf;
  }
  set(key, buf) {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { buf, exp: Date.now() + this.ttl });
  }
  invalidate(key) { this.map.delete(key); }
  clear()         { this.map.clear(); }
}

const cache = new LRUCache(500, 24 * 60 * 60 * 1000);

// ─── Media fetch helpers ─────────────────────────────────────────────────────

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.avi', '.webm', '.mkv', '.3gp', '.ts']);

function isVideoUrl(url) {
  // Strip query string before checking extension (handles S3 presigned URLs)
  const ext = path.extname(url.split('?')[0]).toLowerCase();
  return VIDEO_EXTS.has(ext);
}

// Extract a single frame from a remote video URL using ffmpeg.
// ffmpeg streams only the bytes it needs from the HTTP source — for a typical
// MP4 with fast-start encoding it reads just the moov header + first keyframe
// (usually under 500 KB), regardless of how large the video file is.
async function extractVideoFrame(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const chunks = [];
    const ff = spawn('ffmpeg', [
      '-i',         url,
      '-frames:v',  '1',
      '-vf',        `scale=${IMG_W}:${IMG_H}:force_original_aspect_ratio=increase,crop=${IMG_W}:${IMG_H}`,
      '-f',         'image2',
      '-vcodec',    'png',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    ff.stdout.on('data', chunk => chunks.push(chunk));

    const timer = setTimeout(() => { ff.kill('SIGKILL'); resolve(null); }, timeoutMs);

    ff.on('close', code => {
      clearTimeout(timer);
      resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : null);
    });

    ff.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

// Fetch a photo URL and resize it to card dimensions via Sharp.
// Sharp uses libvips "shrink on load" — for a 4 K phone photo it never allocates
// the full raw bitmap; JPEG is decoded at target resolution in DCT domain.
async function fetchAndResizePhoto(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let rawBuf;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    rawBuf = Buffer.from(await res.arrayBuffer());
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }

  return sharp(rawBuf)
    .resize(IMG_W, IMG_H, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer()
    .catch(() => null);
}

// Route image URLs through Sharp, video URLs through ffmpeg frame extraction.
async function fetchMedia(url, timeoutMs = 8000) {
  if (!url) return null;
  return isVideoUrl(url)
    ? extractVideoFrame(url, timeoutMs)
    : fetchAndResizePhoto(url, timeoutMs);
}

// ─── Canvas drawing helpers ───────────────────────────────────────────────────

function stripEmoji(str = '') {
  return str
    .replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{1F300}-\u{1F9FF}]|\p{Emoji_Presentation}/gu, '')
    .trim();
}

function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function clipRounded(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y,     x + w, y + r,     r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x,      y + h, x,      y + h - r, r);
  ctx.lineTo(x,      y + r);
  ctx.arcTo(x,      y,     x + r,  y,         r);
  ctx.closePath();
  ctx.clip();
}

// ─── Drawing ─────────────────────────────────────────────────────────────────

function drawBackground(ctx, glowColor) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 620);
  glow.addColorStop(0, glowColor);
  glow.addColorStop(1, 'rgba(13,3,5,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
}

function drawBrand(ctx, logoImg) {
  if (logoImg) ctx.drawImage(logoImg, PAD, 46, 38, 28);
  const gx = ctx.createLinearGradient(PAD + 48, 0, PAD + 160, 0);
  gx.addColorStop(0,    RED);
  gx.addColorStop(0.55, ORANGE);
  gx.addColorStop(1,    AMBER);
  ctx.fillStyle = gx;
  ctx.font = '700 24px Inter, sans-serif';
  ctx.fillText('Whistler', PAD + 48, 68);
}

async function drawPhoto(ctx, photoBuf) {
  if (!photoBuf) return;
  // photoBuf is already Sharp-resized to IMG_W × IMG_H — just draw it 1:1
  const img = await loadImage(photoBuf);
  ctx.save();
  clipRounded(ctx, PAD, 104, IMG_W, IMG_H, 18);
  ctx.drawImage(img, PAD, 104, IMG_W, IMG_H);
  ctx.restore();
}

function drawText(ctx, { label, title, description, labelColor }) {
  const textW      = W - PAD * 2;
  const textTopY   = 104 + IMG_H + 40;
  const cleanTitle = stripEmoji(title);
  const cleanDesc  = stripEmoji(description || '');

  ctx.fillStyle = labelColor;
  ctx.font = '600 14px Inter, sans-serif';
  ctx.fillText(label.toUpperCase(), PAD, textTopY);

  const fontSize   = cleanTitle.length > 70 ? 38 : 46;
  const lineHeight = fontSize + 12;
  ctx.fillStyle = WHITE;
  ctx.font = `800 ${fontSize}px Inter, sans-serif`;
  const titleLines = wrapText(ctx, cleanTitle, textW).slice(0, 2);
  let ty = textTopY + 50;
  for (const line of titleLines) { ctx.fillText(line, PAD, ty); ty += lineHeight; }

  ctx.fillStyle = MUTED;
  ctx.font = '500 20px Inter, sans-serif';
  const descLines = wrapText(ctx, cleanDesc, textW).slice(0, 3);
  let dy = ty + 18;
  for (const line of descLines) {
    if (dy > H - 40) break;
    ctx.fillText(line, PAD, dy);
    dy += 34;
  }
}

// ─── Core render ─────────────────────────────────────────────────────────────

async function render({ title, description, imageUrl, logoPath, label, labelColor, glowColor }) {
  const cacheKey = crypto
    .createHash('md5')
    .update(`${label}|${title}|${description}|${imageUrl || ''}`)
    .digest('hex');

  const cached = cache.get(cacheKey);
  if (cached) return { buf: cached, cacheKey, hit: true };

  // Logo load + media fetch (photo or video frame) run in parallel
  const [logoImg, photoBuf] = await Promise.all([
    getLogo(logoPath),
    fetchMedia(imageUrl),
  ]);

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  drawBackground(ctx, glowColor);
  drawBrand(ctx, logoImg);
  await drawPhoto(ctx, photoBuf);
  drawText(ctx, { label, title, description, labelColor });

  const buf = canvas.toBuffer('image/jpeg', { quality: 0.88, progressive: true });
  cache.set(cacheKey, buf);
  return { buf, cacheKey, hit: false };
}

// ─── Public API ──────────────────────────────────────────────────────────────

async function generatePostOGImage(opts) {
  return render({ ...opts, label: 'Community Post', labelColor: RED, glowColor: 'rgba(122,14,38,0.40)' });
}

async function generateMomentOGImage(opts) {
  return render({ ...opts, label: 'Moment', labelColor: AMBER, glowColor: 'rgba(247,163,37,0.14)' });
}

// ─── Pre-warm ────────────────────────────────────────────────────────────────
// Call these right after saving a post/moment to the database.
// Generation runs in the background — the first real visitor gets a cache hit.
//
// Example (in your post creation handler):
//
//   const post = await db.posts.create({ title, description, imageUrl });
//   prewarmPost({ title, description, imageUrl, logoPath: LOGO }).catch(() => {});
//   res.json(post);

async function prewarmPost({ title, description, imageUrl, logoPath }) {
  return generatePostOGImage({ title, description, imageUrl, logoPath }).catch(() => {});
}

async function prewarmMoment({ title, description, imageUrl, logoPath }) {
  return generateMomentOGImage({ title, description, imageUrl, logoPath }).catch(() => {});
}

module.exports = { generatePostOGImage, generateMomentOGImage, prewarmPost, prewarmMoment, cache };


// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS ROUTES — copy into your server
// ─────────────────────────────────────────────────────────────────────────────
//
// const { generatePostOGImage, generateMomentOGImage, prewarmPost, prewarmMoment } = require('./ogImage');
// const LOGO = path.join(__dirname, 'Whistlerlogo.png');
//
// ── Serve OG images ──
//
// async function serveOG(res, generator, opts) {
//   try {
//     const { buf, cacheKey, hit } = await generator(opts);
//     res.set({
//       'Content-Type':  'image/jpeg',
//       'Cache-Control': 'public, max-age=604800, stale-while-revalidate=86400',
//       'ETag':          `"${cacheKey}"`,
//       'X-Cache':       hit ? 'HIT' : 'MISS',
//     });
//     if (res.req.headers['if-none-match'] === `"${cacheKey}"`) return res.status(304).end();
//     res.send(buf);
//   } catch (_) { res.status(500).end(); }
// }
//
// app.get('/og/post/:id.jpg', async (req, res) => {
//   const post = await db.posts.findById(req.params.id);
//   if (!post) return res.status(404).end();
//   serveOG(res, generatePostOGImage, { title: post.title, description: post.description, imageUrl: post.imageUrl, logoPath: LOGO });
// });
//
// app.get('/og/moment/:id.jpg', async (req, res) => {
//   const moment = await db.moments.findById(req.params.id);
//   if (!moment) return res.status(404).end();
//   serveOG(res, generateMomentOGImage, { title: moment.title, description: moment.description, imageUrl: moment.imageUrl, logoPath: LOGO });
// });
//
// ── Pre-warm on post save (fire-and-forget) ──
//
// app.post('/posts', async (req, res) => {
//   const { title, description, imageUrl } = req.body;
//   const post = await db.posts.create({ title, description, imageUrl });
//   prewarmPost({ title, description, imageUrl, logoPath: LOGO });  // no await — runs in background
//   res.status(201).json(post);
// });
//
// app.post('/moments', async (req, res) => {
//   const { title, description, imageUrl } = req.body;
//   const moment = await db.moments.create({ title, description, imageUrl });
//   prewarmMoment({ title, description, imageUrl, logoPath: LOGO });  // no await
//   res.status(201).json(moment);
// });
//
// ── Also pre-warm on post UPDATE (title/image changed = new cache key) ──
//
// app.patch('/posts/:id', async (req, res) => {
//   const post = await db.posts.update(req.params.id, req.body);
//   prewarmPost({ title: post.title, description: post.description, imageUrl: post.imageUrl, logoPath: LOGO });
//   res.json(post);
// });
