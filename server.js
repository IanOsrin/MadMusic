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

// Import helpers
import { validateAccessToken } from './helpers.js';
import { tokenValidationCache } from './cache.js';
import { ensureToken, closeFmPool } from './fm-client.js';
import { ensureDataDir, loadAccessTokens, loadPlaylists } from './store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Track server start time for health checks
const SERVER_START_TIME = Date.now();

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

app.use(express.json());

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

// Add Cache-Control headers
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    if (process.env.NODE_ENV === 'development') {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=180');
    }
  } else if (req.path === '/' || req.path.endsWith('.html')) {
    if (process.env.NODE_ENV === 'development') {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
  next();
});

// Token validation cache and middleware
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

app.use('/api/', async (req, res, next) => {
  const skipPaths = [
    '/access/validate', '/wake', '/container', '/random-songs', '/public-playlists',
    '/search', '/album', '/trending', '/featured-albums', '/missing-audio-songs',
    '/auth', '/payments/initialize', '/payments/callback', '/payments/webhook', '/payments/plans'
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
    if (cached && cached.data && (Date.now() - cached.expiresAt) < STALE_GRACE_MS) {
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
    code: accessToken,
    type: validation.type,
    expirationDate: validation.expirationDate,
    email: validation.email || null
  };

  tokenValidationCache.set(cacheKey, { data: tokenData, expiresAt: Date.now() + TOKEN_CACHE_TTL_MS });

  req.accessToken = tokenData;
  next();
});

// Serve static files EARLY
const PUBLIC_DIR = path.join(__dirname, 'public');
const REGEX_STATIC_FILES = /\.(jpe?g|png|gif|svg|webp|ico|woff2?|ttf|eot|mp3|mp4|webm)$/i;

app.use(express.static(PUBLIC_DIR, {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.includes('.min.') || /\.[a-f0-9]{8,}\./i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (REGEX_STATIC_FILES.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
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
app.use('/api/playlists', playlistsRouter);
app.use('/api/library', libraryRouter);
app.use('/api', catalogRouter);
app.use('/api', streamRouter);
app.use('/api', adminRouter);

// Shared playlist routes (not under /api/playlists)
app.get('/api/shared-playlists/:shareId', async (req, res) => {
  try {
    const { normalizeShareId, sanitizePlaylistForShare, buildShareUrl } = await import('./helpers.js');
    const { loadPlaylists } = await import('./store.js');

    const shareId = normalizeShareId(req.params?.shareId);
    if (!shareId) {
      res.status(400).json({ ok: false, error: 'Share ID required' });
      return;
    }

    const playlists = await loadPlaylists();
    const playlist = playlists.find((p) => p && normalizeShareId(p.shareId) === shareId);
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

// Static site routes
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'home.html')));
app.get('/modern', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'home.html')));
app.get('/albums', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'albums.html')));
app.get('/classic', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'albums.html')));
app.get('/jukebox', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'albums.html')));
app.get('/mobile', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'mobile.html')));
app.get('/m', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'mobile.html')));
app.get('/library', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'library.html')));

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
