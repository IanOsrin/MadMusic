import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import http2 from 'node:http2';
import path from 'node:path';
import fs from 'node:fs/promises';
import compression from 'compression';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';

// Import routes
import accessRouter from './routes/access.js';
import paymentsRouter from './routes/payments.js';
import playlistsRouter from './routes/playlists.js';
import catalogRouter from './routes/catalog.js';
import libraryRouter from './routes/library.js';
import streamRouter from './routes/stream.js';
import adminRouter from './routes/admin.js';
import downloadRouter from './routes/download.js';
import ringtoneRouter from './routes/ringtone.js';
import telkomRouter from './routes/telkom.js';

import { validateAccessToken } from './lib/auth.js';
import { normalizeShareId } from './lib/format.js';
import { sanitizePlaylistForShare } from './lib/playlist.js';
import { buildShareUrl } from './lib/http.js';
import { tokenValidationCache } from './cache.js';
import { ensureToken, closeFmPool } from './fm-client.js';
import { loadAccessTokens } from './lib/token-store.js';
import { loadPlaylistByShareId } from './lib/playlist-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection', err);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err);
});

function parseTrustProxy(value) {
  if (value === undefined || value === null) return 'loopback';
  if (typeof value === 'boolean' || typeof value === 'number' || Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (/^\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    return Number.isNaN(num) ? false : num;
  }
  if (trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

const trustProxySetting = parseTrustProxy(process.env.TRUST_PROXY);
app.set('trust proxy', trustProxySetting);

// Force HTTPS in production
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    if (proto !== 'https') {
      console.warn(`[SECURITY] Redirecting HTTP request to HTTPS: ${req.method} ${req.path}`);
      return res.redirect(301, `https://${req.get('host')}${req.url}`);
    }
    next();
  });

  app.use((req, res, next) => {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
}

// Security headers (applied to every response)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",   // inline scripts used in app.html; cdnjs for ringtone lamejs encoder
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",  // googleapis for Google Fonts CSS
      "img-src 'self' https: data: blob:",    // https: for S3 artwork URLs; blob: for canvas; data: for inline
      "media-src 'self' https: blob:",       // https: for direct S3 audio URLs; blob: for streamed audio
      "connect-src 'self' http://localhost:8765 http://127.0.0.1:8765",
      "font-src 'self' https:",              // https: for Google Fonts (fonts.gstatic.com)
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ')
  );
  next();
});

// CORS configuration
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim()).filter(Boolean)
  : false;

app.use(cors({
  origin: corsOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Access-Token', 'X-No-Compression']
}));

// Compression
app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// Response time logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path.startsWith('/api/') || duration > 100) {
      const cached = res.getHeader('X-Cache-Hit') === 'true' ? '[CACHED]' : '';
      console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms ${cached}`);
    }
  });
  next();
});

// Capture raw body for Paystack webhook (must be before express.json)
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '50mb' }));


// Rate limiting configuration
const isDevelopment = (process.env.NODE_ENV === 'development' || process.env.HOST === 'localhost' || process.env.HOST === '127.0.0.1');

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopment ? 1000 : 100,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});

const expensiveLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: isDevelopment ? 500 : 20,
  message: { error: 'Rate limit exceeded for this endpoint' }
});

const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many payment requests, please try again later' }
});

// Apply general rate limiting to all API routes
app.use('/api/', apiLimiter);

// Apply stricter rate limits to expensive and payment-sensitive endpoints
app.use(['/api/explore', '/api/trending', '/api/featured-albums', '/api/missing-audio-songs'], expensiveLimiter);
app.use(['/api/payments/initialize', '/api/payments/subscribe', '/api/payments/trial', '/api/ringtone/initiate'], paymentLimiter);

// Add Cache-Control headers
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    if (process.env.NODE_ENV === 'development') {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      res.setHeader('Cache-Control', 'private, no-store');
    }
  } else if (req.path === '/' || req.path.endsWith('.html')) {
    // HTML must never be cached — in any environment — so deploys take effect immediately
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// Token validation cache and middleware
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

app.use('/api/', async (req, res, next) => {
  const skipPaths = [
    '/access/validate', '/wake', '/container', '/random-songs', '/public-playlists',
    '/search', '/album', '/trending', '/explore', '/featured-albums', '/missing-audio-songs',
    '/g100-albums', '/g100-playlists', '/genres',
    '/auth', '/payments/initialize', '/payments/subscribe', '/payments/trial', '/payments/callback',
    '/payments/webhook', '/payments/plans', '/payments/subscription-plan',
    '/access/stream-events', '/access/logout', '/health',
    '/tokens/resync', '/tokens/unsynced', '/tokens/clear-trials',
    '/telkom/subscription', '/telkom/billing',
    '/download/',
    '/ringtone/',
    '/audio-proxy',
    '/audio-lab/'
  ];

  if (skipPaths.some(path => req.path === path || req.path.startsWith(path))) {
    return next();
  }

  const accessToken = req.headers['x-access-token'] || req.body?.accessToken;

  if (!accessToken) {
    return res.status(403).json({
      ok: false,
      error: 'Access token required',
      requiresAccessToken: true
    });
  }

  const cacheKey = accessToken.trim().toUpperCase();
  const cached = tokenValidationCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    req.accessToken = cached.data;
    return next();
  }

  const validation = await validateAccessToken(accessToken);

  if (!validation.valid) {
    const STALE_GRACE_MS = 24 * 60 * 60 * 1000;
    if (cached?.data && (Date.now() - cached.expiresAt) < STALE_GRACE_MS) {
      console.warn(`[MASS] FM validation failed (${validation.reason}), using stale cache for token ${cacheKey.slice(0, 8)}…`);
      req.accessToken = cached.data;
      return next();
    }
    return res.status(403).json({
      ok: false,
      error: 'Invalid or expired access token',
      reason: validation.reason,
      requiresAccessToken: true
    });
  }

  const tokenData = {
    code:            accessToken,
    type:            validation.type,
    expirationDate:  validation.expirationDate,
    email:           validation.email || null,
    audioLabEnabled: validation.audioLabEnabled || false,
    recordId:        validation.recordId || null
  };

  tokenValidationCache.set(cacheKey, { data: tokenData, expiresAt: Date.now() + TOKEN_CACHE_TTL_MS });

  req.accessToken = tokenData;
  next();
});

// Serve static files EARLY
const PUBLIC_DIR = path.join(__dirname, 'public');
const REGEX_STATIC_FILES = /\.(jpe?g|png|gif|svg|webp|ico|woff2?|ttf|eot|mp3|mp4|webm)$/i;

// ── Deploy-time cache buster ────────────────────────────────────────────────
// A unique stamp generated once per server start.  Render restarts on every
// deploy, so this automatically invalidates all browser-cached JS/CSS without
// any manual version-bumping.
const DEPLOY_STAMP = Date.now().toString(36); // e.g. "lzxabcd"

/**
 * Read an HTML file from disk and replace every `?v=<anything>` query string
 * on JS/CSS asset references with `?v=<DEPLOY_STAMP>`.
 * In production the result is cached in memory (one read per boot).
 * In development the file is read fresh on every request so edits are
 * visible immediately without restarting the server.
 */
const _htmlCache = new Map();
const DEV_MODE = process.env.NODE_ENV !== 'production';
async function loadHtml(filename) {
  if (!DEV_MODE && _htmlCache.has(filename)) return _htmlCache.get(filename);
  const raw = await fs.readFile(path.join(PUBLIC_DIR, filename), 'utf8');
  const stamped = raw.replace(
    /((?:src|href)="\/(?:js|css)\/[^"]+)\?v=[^"&]*/g,
    `$1?v=${DEPLOY_STAMP}`
  );
  if (!DEV_MODE) _htmlCache.set(filename, stamped);
  return stamped;
}

function sendHtml(res, filename) {
  return loadHtml(filename)
    .then(html => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    })
    .catch(err => {
      console.error(`[MASS] sendHtml failed for ${filename}:`, err.message);
      if (!res.headersSent) res.status(500).send('Server error loading page');
    });
}
// ───────────────────────────────────────────────────────────────────────────

app.use(express.static(PUBLIC_DIR, {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.includes('.min.') || /\.[a-f0-9]{8,}\./i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (REGEX_STATIC_FILES.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      // In dev: no caching so edits show immediately.
      // In production: 1 hour with revalidation (deploy stamp handles busting).
      res.setHeader('Cache-Control', DEV_MODE
        ? 'no-store'
        : 'public, max-age=3600, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
  etag: true,
  lastModified: true
}));

// Jukebox image endpoint
app.get('/img/jukebox.webp', async (req, res, next) => {
  try {
    const JUKEBOX_IMAGE_PATH = path.join(PUBLIC_DIR, 'img', 'jukebox.png');
    await fs.access(JUKEBOX_IMAGE_PATH);
    res.type('image/png');
    res.sendFile(JUKEBOX_IMAGE_PATH);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENAMETOOLONG')) return next();
    next(err);
  }
});

// ========= ROUTE MOUNTS =========
app.use('/api/access', accessRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/telkom', telkomRouter);
app.use('/api/download', downloadRouter);
app.use('/api/ringtone', ringtoneRouter);
app.use('/api/playlists', playlistsRouter);
app.use('/api/library', libraryRouter);
app.use('/api', catalogRouter);
app.use('/api', streamRouter);
app.use('/api', adminRouter);

// Shared playlist routes (not under /api/playlists)
app.get('/api/shared-playlists/:shareId', async (req, res) => {
  try {
    const shareId = normalizeShareId(req.params?.shareId);
    if (!shareId) {
      res.status(400).json({ ok: false, error: 'Share ID required' });
      return;
    }

    const playlist = await loadPlaylistByShareId(shareId);
    if (!playlist) {
      res.status(404).json({ ok: false, error: 'Playlist not found' });
      return;
    }

    const payload = sanitizePlaylistForShare(playlist);
    const shareUrl = buildShareUrl(req, shareId);

    res.json({ ok: true, playlist: payload, shareUrl });
  } catch (err) {
    console.error('[MASS] Fetch shared playlist failed:', err);
    res.status(500).json({ ok: false, error: 'Unable to load playlist' });
  }
});

// Static site routes — all primary views served from merged app.html
// sendHtml() serves a pre-processed in-memory copy with deploy-stamped asset URLs
app.get('/',         (_req, res) => sendHtml(res, 'app.html'));
app.get('/modern',   (_req, res) => sendHtml(res, 'app.html'));
app.get('/albums',   (_req, res) => sendHtml(res, 'app.html'));
app.get('/classic',  (_req, res) => sendHtml(res, 'app.html'));
app.get('/jukebox',  (_req, res) => sendHtml(res, 'app.html'));
app.get('/library',  (_req, res) => sendHtml(res, 'app.html')); // library.html never existed — unified app handles this view
// Redirect legacy standalone pages to unified app
app.get('/home',     (_req, res) => res.redirect(301, '/'));
app.get('/mobile',   (_req, res) => sendHtml(res, 'mobile.html'));
app.get('/m',        (_req, res) => sendHtml(res, 'mobile.html'));
app.get('/ringtone', (_req, res) => sendHtml(res, 'ringtone.html'));
app.get('/audio-lab',(_req, res) => sendHtml(res, 'audio-lab.html'));

// ── Audio Lab key validation ──────────────────────────────────────────────────
// Requires a valid streaming access token so we can link the entitlement to
// the user's FileMaker record. Once activated, audioLabEnabled comes back
// automatically on every subsequent /api/access/validate call.
app.post('/api/audio-lab/validate-key', async (req, res) => {
  const { key } = req.body || {};
  const validKey = process.env.AUDIO_LAB_KEY || 'abc123';
  if (!key) return res.status(400).json({ ok: false, error: 'No key provided' });
  if (key.trim() !== validKey) return res.status(403).json({ ok: false, error: 'Invalid key' });

  // Write Audio_Lab_Enabled = 1 to the FM token record
  try {
    const tokenCode = (req.headers['x-access-token'] || '').trim().toUpperCase();
    if (tokenCode && req.accessToken?.recordId) {
      const { fmUpdateRecord } = await import('./fm-client.js');
      const layout = process.env.FM_TOKENS_LAYOUT || 'API_Access_Tokens';
      await fmUpdateRecord(layout, req.accessToken.recordId, { Audio_Lab_Enabled: 1 });
      console.log(`[AudioLab] Enabled for token ${tokenCode.slice(0, 8)}…`);
    }
  } catch (err) {
    // Non-fatal — key is still valid, FM write just failed
    console.warn('[AudioLab] Could not write to FM:', err.message);
  }

  return res.json({ ok: true, audioLabEnabled: true });
});

// ── Audio Lab proxy ── fetches a remote audio URL server-side to bypass CORS ──
app.get('/api/audio-proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url param' });
  try {
    const target = new URL(url); // throws if invalid
    // Only allow https: scheme to prevent SSRF against internal services
    if (target.protocol !== 'https:') return res.status(400).json({ error: 'Only https URLs allowed' });
    const upstream = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!upstream.ok) return res.status(upstream.status).json({ error: `Upstream ${upstream.status}` });
    const ct = upstream.headers.get('content-type') || 'audio/mpeg';
    const cl = upstream.headers.get('content-length');
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (cl) res.setHeader('Content-Length', cl);
    // Buffer the body — MP3s are typically 3–15 MB, well within safe limits.
    // Avoids WritableStream availability issues across Node.js versions.
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.destroy();
  }
});

// ── Replicate proxy ── forwards requests to api.replicate.com server-side ──────
// The browser passes its Replicate API key in X-Replicate-Key header.
// We forward to Replicate so the browser never hits api.replicate.com directly
// (avoids CSP / CORS issues). No key is stored on this server.

// Start a prediction — audio sent as base64 MP3 data URL (encoded client-side to keep size small).
app.post('/api/audio-lab/replicate/predictions', async (req, res) => {
  const replicateKey = req.headers['x-replicate-key'] || process.env.REPLICATE_API_KEY;
  if (!replicateKey) return res.status(400).json({ error: 'No Replicate API key provided' });

  try {
    const upstream = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${replicateKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('[Replicate] Proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Step 3: Poll prediction status.
app.get('/api/audio-lab/replicate/predictions/:id', async (req, res) => {
  const replicateKey = req.headers['x-replicate-key'] || process.env.REPLICATE_API_KEY;
  if (!replicateKey) return res.status(400).json({ error: 'No Replicate API key provided' });

  try {
    const upstream = await fetch(`https://api.replicate.com/v1/predictions/${req.params.id}`, {
      headers: { 'Authorization': `Token ${replicateKey}` }
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('[Replicate] Poll error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========= STARTUP =========
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const HTTP2_ENABLED = process.env.HTTP2_ENABLED === 'true';
const HTTP2_CERT_PATH = process.env.HTTP2_CERT_PATH || '';
const HTTP2_KEY_PATH = process.env.HTTP2_KEY_PATH || '';
const FM_HOST = process.env.FM_HOST;
const FM_DB = process.env.FM_DB;
const FM_USER = process.env.FM_USER;
const FM_PASS = process.env.FM_PASS;

if (FM_HOST && FM_DB && FM_USER && FM_PASS) {
  try {
    await ensureToken();
    console.log('[MASS] FileMaker token primed');
  } catch (err) {
    console.warn('[MASS] Initial FileMaker login failed:', err?.message || err);
  }
} else {
  console.warn('[MASS] Skipping initial FileMaker login; missing FM environment variables');
}

try {
  await loadAccessTokens();
  console.log('[MASS] Access tokens loaded successfully');
} catch (err) {
  console.warn('[MASS] Failed to load access tokens:', err);
}

// Pre-warm connections
async function warmConnections() {
  console.log('[MASS] Warming FileMaker connections...');
  try {
    await ensureToken();
    console.log('[MASS] FileMaker connection warmed successfully');
  } catch (err) {
    console.warn('[MASS] Connection warm-up failed:', err.message);
  }
}

function logServerReady(protocolLabel = 'HTTP/1.1') {
  const scheme = protocolLabel.includes('HTTP/2') ? 'https' : 'http';
  console.log(`[MASS] listening on ${scheme}://${HOST}:${PORT} (${protocolLabel})`);
  console.log(`[MASS] Rate limits: ${isDevelopment ? 'DEVELOPMENT (relaxed)' : 'PRODUCTION (strict)'}`);
  if (isDevelopment) {
    console.log('[MASS] - API: 1000 req/15min, Explore: 500 req/5min');
  }
}

await warmConnections();

let server = null;
let serverStarted = false;

if (HTTP2_ENABLED) {
  if (HTTP2_CERT_PATH && HTTP2_KEY_PATH) {
    try {
      const [key, cert] = await Promise.all([
        fs.readFile(HTTP2_KEY_PATH),
        fs.readFile(HTTP2_CERT_PATH)
      ]);
      server = http2.createSecureServer({ key, cert, allowHTTP1: true }, app);
      server.listen(PORT, HOST, () => logServerReady('HTTP/2 (ALPN fallback enabled)'));
      serverStarted = true;
    } catch (err) {
      console.warn('[MASS] Failed to start HTTP/2 server, falling back to HTTP/1.1:', err?.message || err);
    }
  } else {
    console.warn('[MASS] HTTP2_ENABLED is true but HTTP2_CERT_PATH or HTTP2_KEY_PATH is missing; falling back to HTTP/1.1');
  }
}

if (!serverStarted) {
  server = http.createServer(app);
  server.listen(PORT, HOST, () => logServerReady('HTTP/1.1'));
}

// ── Cache pre-warm ──────────────────────────────────────────────────────────
// Each worker has its own in-memory LRU caches, so every worker needs to warm
// its own. We invoke the in-process SWR warmers directly (no HTTP round-trip)
// and stagger with jitter so a multi-worker cluster doesn't hammer FileMaker
// with simultaneous identical queries.
//
// SWR guarantees that once a cache entry is warm, subsequent requests (even
// hours later, when the soft TTL has elapsed) return stale-immediately while
// the refresh runs in the background. First-request latency ≈ 0 after warm.
{
  const { featuredWarmers }         = await import('./routes/catalog/featured.js');
  const { trendingWarmer }          = await import('./routes/catalog/trending.js');
  const { genresWarmer }            = await import('./routes/catalog/genres.js');
  const { publicPlaylistsWarmer }   = await import('./routes/catalog/discovery.js');

  const workerJitter = Math.floor(Math.random() * 2000); // 0–2s per-worker jitter

  async function prewarm(label, fn, baseDelayMs) {
    await new Promise((r) => setTimeout(r, baseDelayMs + workerJitter));
    const started = Date.now();
    try {
      await fn();
      console.log(`[MASS] ${label} cache pre-warmed (${Date.now() - started}ms)`);
    } catch (err) {
      console.warn(`[MASS] ${label} pre-warm failed:`, err?.message || err);
    }
  }

  // Ordered by user-visibility: the homepage hits featured + trending first,
  // so warm those before the longer/less-urgent genre scan.
  prewarm('Featured',         featuredWarmers.featured,    1000);
  prewarm('Trending',         trendingWarmer,              2000);
  prewarm('New Releases',     featuredWarmers.newReleases, 3000);
  prewarm('G100',             featuredWarmers.g100,        4000);
  prewarm('Public Playlists', publicPlaylistsWarmer,       5000);
  prewarm('Genres',           genresWarmer,                8000);
}
// ────────────────────────────────────────────────────────────────────────────

// ============================================================================
// GRACEFUL SHUTDOWN HANDLERS
// ============================================================================

process.on('SIGTERM', async () => {
  console.log('[MASS] SIGTERM received, shutting down gracefully...');
  if (server) {
    server.close(() => {
      console.log('[MASS] HTTP server closed');
    });
  }
  await closeFmPool();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[MASS] SIGINT received, shutting down gracefully...');
  if (server) {
    server.close(() => {
      console.log('[MASS] HTTP server closed');
    });
  }
  await closeFmPool();
  process.exit(0);
});
