import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import http2 from 'node:http2';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import dns from 'node:dns/promises';
import net from 'node:net';
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
import editorialRouter from './routes/featured-editorial.js';
import downloadRouter from './routes/download.js';
import ringtoneRouter from './routes/ringtone.js';
import telkomRouter from './routes/telkom.js';
import podcastsRouter from './routes/podcasts.js';
import suggestionsRouter from './routes/suggestions.js';
import { initSemanticIndex, semanticIndexStatus } from './lib/semantic-index.js';

import { validateAccessToken } from './lib/auth.js';
import { timingSafeEqualStr } from './lib/crypto-utils.js';
import { normalizeShareId } from './lib/format.js';
import { sanitizePlaylistForShare } from './lib/playlist.js';
import { buildShareUrl } from './lib/http.js';
import { tokenValidationCache } from './cache.js';
import { ensureToken, closeFmPool } from './fm-client.js';
import { loadAccessTokens } from './lib/token-store.js';
import { loadPlaylistByShareId } from './lib/playlist-store.js';
import { createPrecompressedStatic } from './lib/precompressed-static.js';

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
  const isProd = process.env.NODE_ENV === 'production';
  // Default: in production, trust exactly one proxy hop (Render's edge). In dev,
  // trust loopback only. Never default to trusting all hops.
  if (value === undefined || value === null) return isProd ? 1 : 'loopback';
  if (typeof value === 'number' || Array.isArray(value)) return value;
  if (typeof value === 'boolean') {
    // `true` makes req.ip the client-controlled left-most X-Forwarded-For, which
    // lets attackers rotate the header to defeat rate limiting. Refuse it in prod.
    if (value === true && isProd) {
      console.warn('[SECURITY] TRUST_PROXY=true is unsafe in production (spoofable client IP). Coercing to 1 hop.');
      return 1;
    }
    return value;
  }
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return isProd ? 1 : false;
  const lower = trimmed.toLowerCase();
  if (lower === 'true') {
    if (isProd) {
      console.warn('[SECURITY] TRUST_PROXY=true is unsafe in production (spoofable client IP). Set it to the proxy hop count (Render = 1). Coercing to 1.');
      return 1;
    }
    return true;
  }
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
      "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://www.googletagmanager.com",   // inline scripts used in app.html; cdnjs for ringtone lamejs encoder
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",  // googleapis for Google Fonts CSS
      "img-src 'self' https: data: blob:",    // https: for S3 artwork URLs; blob: for canvas; data: for inline
      "media-src 'self' https: blob:",       // https: for direct S3 audio URLs; blob: for streamed audio
      "connect-src 'self' http://localhost:8765 http://127.0.0.1:8765 https://ipwho.is https://open.er-api.com https://www.googletagmanager.com https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com",
      "font-src 'self' https:",              // https: for Google Fonts (fonts.gstatic.com)
      "frame-src 'self' https://www.googletagmanager.com",   // 'self' for the in-app ringtone modal iframe; GTM noscript iframe (ns.html)
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ')
  );
  next();
});

// ── Audio Lab feature flag ────────────────────────────────────────────────────
// Audio Lab is OFF by default. The code stays in place; this gate simply makes
// the page, its static HTML, and every /api/audio-lab/* endpoint return 404 so
// the whole surface (including audio-lab.html's reflected-title param) is
// unreachable until revived. To turn it back on, set AUDIO_LAB_ENABLED=true.
const AUDIO_LAB_ENABLED = process.env.AUDIO_LAB_ENABLED === 'true';
// Mirrors routes/featured-editorial.js. Surfaced to the client (see loadHtml)
// so the hero can skip the guaranteed-empty /api/featured-editorial round-trip
// when the feature is off — saving one above-the-fold RTT on every page load.
const EDITORIAL_HERO_ENABLED = process.env.EDITORIAL_HERO_ENABLED === 'true';
app.use((req, res, next) => {
  if (AUDIO_LAB_ENABLED) return next();
  const p = req.path.toLowerCase();
  if (p === '/audio-lab' || p === '/audio-lab.html' || p.startsWith('/api/audio-lab')) {
    return res.status(404).send('Not found');
  }
  next();
});

// ── Telkom feature flag ───────────────────────────────────────────────────────
// Telkom integration is OFF by default (ring-fenced June 2026 — waiting on
// Telkom for webhook secret/signature, IP ranges, and PartnerHUB confirmation).
// The code stays in place; this gate makes every /api/telkom/* endpoint return
// 404, and the webhook paths are NOT added to the auth skip-list while off.
// Known open issues to fix BEFORE enabling: fail-open when TELKOM_WEBHOOK_SECRET
// unset; raw '==' FM finds (telkom.js:75,247 → fmExactMatch); SUSPENDED/CANCELLED
// never disables tokens (disableSubscriptionToken type/key mismatch); billing
// renewal not mirrored to the JSON token store.
// To turn it back on, set TELKOM_ENABLED=true.
const TELKOM_ENABLED = process.env.TELKOM_ENABLED === 'true';

// Podcasts section (2026-06-11): ships dark. While the flag is off the path
// 404s BEFORE the auth middleware — otherwise an unmounted /api path falls
// through to the token wall and a stale frontend probing it would get a 403
// with requiresAccessToken, popping the token gate for no reason.
const PODCASTS_ENABLED = process.env.PODCASTS_ENABLED === 'true';

// "Similar albums" suggestions (2026-06-15): ships dark. Powered by the slim
// semantic album index (data/suggest.db, lib/semantic-index.js) — a local
// sqlite-vec nearest-neighbour query, never FileMaker. Like podcasts it 404s
// BEFORE the auth middleware while off so a stale frontend probing it never
// trips the token wall. Enable with SUGGESTIONS_ENABLED=true (an artifact must
// be present on disk or downloadable via SUGGEST_DB_URL — see initSemanticIndex).
const SUGGESTIONS_ENABLED = process.env.SUGGESTIONS_ENABLED === 'true';

app.use((req, res, next) => {
  if (TELKOM_ENABLED) return next();
  if (req.path.toLowerCase().startsWith('/api/telkom')) {
    return res.status(404).send('Not found');
  }
  next();
});
app.use((req, res, next) => {
  if (PODCASTS_ENABLED) return next();
  if (req.path.toLowerCase().startsWith('/api/podcasts')) {
    return res.status(404).send('Not found');
  }
  next();
});
app.use((req, res, next) => {
  if (SUGGESTIONS_ENABLED) return next();
  if (req.path.toLowerCase().startsWith('/api/suggestions')) {
    return res.status(404).send('Not found');
  }
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

// JSON body limit kept tight to protect 512 MB Render workers from a single
// oversized payload blowing the heap. Large uploads (XLSX ingest, audio, ZIPs)
// go through multer / express.raw on their specific routes.
app.use(express.json({ limit: '2mb' }));


// Rate limiting configuration
const isDevelopment = (process.env.NODE_ENV === 'development' || process.env.HOST === 'localhost' || process.env.HOST === '127.0.0.1');

// In test mode (MASS_NO_LISTEN=true) rate limits would prevent supertest from
// firing many requests against the same endpoint. Skip in that case only.
const TEST_MODE = process.env.MASS_NO_LISTEN === 'true';
const skipInTest = () => TEST_MODE;

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopment ? 1000 : 100,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest
});

const expensiveLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: isDevelopment ? 500 : 20,
  message: { error: 'Rate limit exceeded for this endpoint' },
  skip: skipInTest
});

const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many payment requests, please try again later' },
  skip: skipInTest
});

// Apply general rate limiting to all API routes
app.use('/api/', apiLimiter);

// Apply stricter rate limits to expensive and payment-sensitive endpoints
app.use(['/api/explore', '/api/trending', '/api/featured-albums', '/api/missing-audio-songs', '/api/singles'], expensiveLimiter);
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

// Concurrent-validation dedup. On a cold start the per-process tokenValidationCache
// is empty, and the SPA fires a burst of /api/* calls at once. Without this map,
// every request in that burst with the SAME token would miss the cache
// simultaneously and each fire its own FileMaker _find (+ usage PATCH), flooding
// the FM request queue (cap 8) while FM Cloud is itself cold — the root cause of
// multi-minute "won't play" stalls. This collapses a burst of identical-token
// lookups into a single in-flight FM round-trip (the swr-cache.js dedup principle,
// applied to the auth read path per CLAUDE.md's hard rule).
const tokenValidationInFlight = new Map(); // cacheKey -> Promise<validation>

function validateAccessTokenDeduped(accessToken, cacheKey) {
  const existing = tokenValidationInFlight.get(cacheKey);
  if (existing) return existing;
  const p = validateAccessToken(accessToken)
    .finally(() => tokenValidationInFlight.delete(cacheKey));
  tokenValidationInFlight.set(cacheKey, p);
  return p;
}

app.use('/api/', async (req, res, next) => {
  const skipPaths = [
    '/access/validate', '/wake', '/container', '/random-songs', '/public-playlists',
    '/search', '/album', '/trending', '/explore', '/featured-albums', '/missing-audio-songs',
    '/g100-albums', '/g100-playlists', '/genres', '/singles', '/featured-editorial',
    '/auth', '/payments/initialize', '/payments/subscribe', '/payments/trial', '/payments/callback',
    '/payments/webhook', '/payments/plans', '/payments/subscription-plan',
    '/access/stream-events', '/access/logout', '/access/email/', '/health',
    '/tokens/resync', '/tokens/unsynced', '/tokens/clear-trials',
    // Telkom webhook paths skip token auth ONLY while the integration is live;
    // ring-fenced (404 before this middleware) when TELKOM_ENABLED is off.
    ...(TELKOM_ENABLED ? ['/telkom/subscription', '/telkom/billing'] : []),
    // Podcasts are public catalogue content (like /trending, /singles); the
    // path is only mounted when PODCASTS_ENABLED, so skip it under the same gate.
    ...(PODCASTS_ENABLED ? ['/podcasts'] : []),
    // Similar-albums suggestions are public catalogue content; only skip-listed
    // while enabled (the path is 404'd before this middleware when off).
    ...(SUGGESTIONS_ENABLED ? ['/suggestions'] : []),
    '/download/',
    '/ringtone/',
    '/audio-proxy',
    // NOTE: '/audio-lab/' is intentionally NOT skipped — every /api/audio-lab/*
    // endpoint (key validation + the Replicate proxy) requires a valid access
    // token so we never forward to a paid third-party API unauthenticated.
    '/catalog/'
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

  const validation = await validateAccessTokenDeduped(accessToken, cacheKey);

  if (!validation.valid) {
    const STALE_GRACE_MS = 24 * 60 * 60 * 1000;
    // Only fall back to the stale cache when FileMaker was UNREACHABLE (network/
    // 5xx/timeout). An authoritative "token disabled / expired / in use elsewhere"
    // verdict must deny immediately — otherwise a revoked subscriber keeps access
    // for up to 24h. validateAccessToken sets `definitive: true` for real denials.
    const fmUnavailable = validation.definitive !== true;
    if (fmUnavailable && cached?.data && (Date.now() - cached.expiresAt) < STALE_GRACE_MS) {
      console.warn(`[MASS] FM unreachable (${validation.reason}), using stale cache for token ${cacheKey.slice(0, 8)}…`);
      req.accessToken = cached.data;
      return next();
    }
    // Definitive denial: drop any cached entry so it can't be reused.
    if (validation.definitive === true) tokenValidationCache.delete(cacheKey);
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
  let stamped = raw.replace(
    /((?:src|href)="\/(?:js|css)\/[^"]+)\?v=[^"&]*/g,
    `$1?v=${DEPLOY_STAMP}`
  );
  // When Audio Lab is disabled, hide its UI entry points (home widget + per-track
  // buttons) so users don't hit the 404'd routes. Purely cosmetic; the server-side
  // gate above is the real control. Re-enabling AUDIO_LAB_ENABLED removes this.
  if (!AUDIO_LAB_ENABLED) {
    stamped += '\n<style id="audio-lab-disabled">#audioLabWidget,.track-audio-lab-btn,.btn-audio-lab{display:none !important;}</style>\n';
  }
  // Tell the client whether the editorial hero is live. When false, the hero
  // skips fetching /api/featured-editorial (which would return empty anyway)
  // and goes straight to /api/new-releases — one fewer serial request above
  // the fold. Absence of the flag preserves the original attempt-then-fallback.
  stamped += `\n<script>window.__EDITORIAL_HERO=${EDITORIAL_HERO_ENABLED ? 'true' : 'false'};</script>\n`;
  // Tell the client whether "Similar albums" is live, so the album page skips
  // the /api/suggestions round-trip (which would 404) when the feature is off.
  stamped += `\n<script>window.__SUGGESTIONS=${SUGGESTIONS_ENABLED ? 'true' : 'false'};</script>\n`;
  if (!DEV_MODE) _htmlCache.set(filename, stamped);
  return stamped;
}

function sendHtml(res, filename) {
  return loadHtml(filename)
    .then(html => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // HTML documents carry inline app logic, so they must never be cached —
      // by browsers OR shared proxies. The path-based middleware above only
      // matches '/' and '*.html', so extensionless view routes like /mobile,
      // /albums, /jukebox would otherwise be served with no Cache-Control and
      // get heuristically cached, leaving stale inline JS on devices.
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.send(html);
    })
    .catch(err => {
      console.error(`[MASS] sendHtml failed for ${filename}:`, err.message);
      if (!res.headersSent) res.status(500).send('Server error loading page');
    });
}
// ───────────────────────────────────────────────────────────────────────────

// Single source of truth for static-asset Cache-Control, shared by the
// precompressed layer below and express.static so the two never disagree.
function cacheControlFor(filePath) {
  if (filePath.includes('.min.') || /\.[a-f0-9]{8,}\./i.test(filePath)) {
    return 'public, max-age=31536000, immutable';
  } else if (REGEX_STATIC_FILES.test(filePath)) {
    return 'public, max-age=604800';
  } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
    // In dev: no caching so edits show immediately.
    // In production: 1 hour with revalidation (deploy stamp handles busting).
    return DEV_MODE ? 'no-store' : 'public, max-age=3600, must-revalidate';
  }
  return 'no-cache';
}

// Serve boot-time brotli-q11 / gzip-9 copies of static text assets ahead of
// express.static. Production only: in dev we want fresh disk reads on every
// edit, so this layer is skipped and express.static (with on-the-fly q4) serves.
if (!DEV_MODE) {
  const precompressed = createPrecompressedStatic(PUBLIC_DIR, cacheControlFor);
  const { count, rawBytes, brBytes } = precompressed.stats;
  console.log(`[MASS] Precompressed ${count} static assets (br q11): ${(rawBytes / 1024).toFixed(0)}KB -> ${(brBytes / 1024).toFixed(0)}KB`);
  app.use(precompressed);
}

app.use(express.static(PUBLIC_DIR, {
  index: false,
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', cacheControlFor(filePath));
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
if (TELKOM_ENABLED) app.use('/api/telkom', telkomRouter); // ring-fenced: 404'd above when off
if (PODCASTS_ENABLED) app.use('/api', podcastsRouter);    // dark until PODCASTS_ENABLED=true
if (SUGGESTIONS_ENABLED) app.use('/api', suggestionsRouter); // dark until SUGGESTIONS_ENABLED=true
app.use('/api/download', downloadRouter);
app.use('/api/ringtone', ringtoneRouter);
app.use('/api/playlists', playlistsRouter);
app.use('/api/library', libraryRouter);
app.use('/api', catalogRouter);
app.use('/api', streamRouter);
app.use('/api', adminRouter);
app.use('/api', editorialRouter);

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
  // No hardcoded fallback — the Audio Lab unlock key MUST be configured via the
  // AUDIO_LAB_KEY env var. If it's unset, the feature fails closed (503) rather
  // than accepting a well-known default that would let anyone unlock it.
  const validKey = process.env.AUDIO_LAB_KEY;
  if (!validKey) return res.status(503).json({ ok: false, error: 'Audio Lab not configured' });
  if (!key) return res.status(400).json({ ok: false, error: 'No key provided' });
  // Constant-time comparison to avoid leaking the key via timing.
  if (!timingSafeEqualStr(String(key).trim(), validKey)) {
    return res.status(403).json({ ok: false, error: 'Invalid key' });
  }

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

// ── SSRF guard ───────────────────────────────────────────────────────────────
// Decide whether a resolved IP address belongs to a private/internal range.
// Uses net.isIP + numeric checks so decimal/octal/hex/IPv4-mapped-IPv6 literals
// can't slip past a string regex.
function _ipIsPrivate(ip) {
  if (!ip) return true;
  const fam = net.isIP(ip);
  if (fam === 4) {
    const o = ip.split('.').map(Number);
    if (o.length !== 4 || o.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
    if (o[0] === 10) return true;                          // 10.0.0.0/8
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16.0.0/12
    if (o[0] === 192 && o[1] === 168) return true;         // 192.168.0.0/16
    if (o[0] === 169 && o[1] === 254) return true;         // link-local
    if (o[0] === 127) return true;                         // loopback
    if (o[0] === 0) return true;                           // 0.0.0.0/8
    if (o[0] >= 224) return true;                          // multicast/reserved
    return false;
  }
  if (fam === 6) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd')) return true;
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — re-check the embedded v4 address.
    const m = low.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return _ipIsPrivate(m[1]);
    return false;
  }
  return true; // not a valid IP literal → treat as unsafe
}

// Resolve a hostname and return true if ANY resolved address is private/internal.
// This defeats DNS-rebinding (attacker domain → 169.254.169.254) and alternate
// IP encodings that a hostname-string regex would miss.
async function _hostnameResolvesPrivate(hostname) {
  if (!hostname) return true;
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return true;
  if (net.isIP(h)) return _ipIsPrivate(h);
  try {
    const records = await dns.lookup(h, { all: true });
    if (!records.length) return true;
    return records.some(r => _ipIsPrivate(r.address));
  } catch {
    return true; // unresolvable → block
  }
}

// ── Audio Lab proxy ── fetches a remote audio URL server-side to bypass CORS ──
app.get('/api/audio-proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url param' });
  try {
    const target = new URL(url); // throws if invalid
    // Block non-https schemes and private/internal IP ranges (SSRF prevention).
    // Resolves DNS so rebinding and alternate IP encodings can't bypass the check.
    if (target.protocol !== 'https:') return res.status(400).json({ error: 'Only https URLs allowed' });
    if (await _hostnameResolvesPrivate(target.hostname)) {
      return res.status(400).json({ error: 'Private or internal addresses not allowed' });
    }
    const upstream = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!upstream.ok) return res.status(upstream.status).json({ error: `Upstream ${upstream.status}` });
    const ct = upstream.headers.get('content-type') || 'audio/mpeg';
    const cl = upstream.headers.get('content-length');
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (cl) res.setHeader('Content-Length', cl);
    // Stream the body instead of buffering. Loading whole MP3s (3–15 MB) into
    // memory per request was a meaningful contributor to OOM kills on the
    // 512 MB Render tier with multiple concurrent listeners.
    if (!upstream.body) return res.end();
    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on('error', (err) => {
      console.warn('[audio-proxy] upstream stream error:', err.message);
      if (!res.headersSent) res.status(502).end();
      else res.destroy(err);
    });
    res.on('close', () => { if (!nodeStream.destroyed) nodeStream.destroy(); });
    nodeStream.pipe(res);
  } catch (err) {
    console.warn('[audio-proxy] error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Upstream request failed' });
    else res.destroy();
  }
});

// ── Replicate proxy ── forwards requests to api.replicate.com server-side ──────
// The browser passes its Replicate API key in X-Replicate-Key header.
// We forward to Replicate so the browser never hits api.replicate.com directly
// (avoids CSP / CORS issues). No key is stored on this server.

// Start a prediction — audio sent as base64 MP3 data URL (encoded client-side to keep size small).
app.post('/api/audio-lab/replicate/predictions', async (req, res) => {
  // Auth is enforced by the /api/ middleware (no longer skip-listed). The caller
  // must supply their OWN Replicate key — we never fall back to the server's key
  // for a client request, which would let callers spend the server's credits.
  const replicateKey = req.headers['x-replicate-key'];
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
    res.status(502).json({ error: 'Upstream request failed' });
  }
});

// Step 3: Poll prediction status.
app.get('/api/audio-lab/replicate/predictions/:id', async (req, res) => {
  const replicateKey = req.headers['x-replicate-key'];
  if (!replicateKey) return res.status(400).json({ error: 'No Replicate API key provided' });
  // Constrain the id to Replicate's id charset so it can't be used to path-traverse
  // or hit arbitrary Replicate endpoints.
  if (!/^[A-Za-z0-9]+$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid prediction id' });
  }

  try {
    const upstream = await fetch(`https://api.replicate.com/v1/predictions/${req.params.id}`, {
      headers: { 'Authorization': `Token ${replicateKey}` }
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('[Replicate] Poll error:', err.message);
    res.status(502).json({ error: 'Upstream request failed' });
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

// Export the configured Express app so tests can drive it via supertest
// without binding a port. The boot block below is gated on MASS_NO_LISTEN.
export { app };

if (process.env.MASS_NO_LISTEN !== 'true') {

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

// Open the semantic album index at boot so the first "Similar albums" request
// isn't slowed by the (one-time) DB open / S3 download. Non-fatal: if the
// artifact is absent the route degrades to an empty rail. Off-thread of listen.
if (SUGGESTIONS_ENABLED) {
  initSemanticIndex()
    .then(() => console.log('[MASS] Semantic suggestion index:', JSON.stringify(semanticIndexStatus())))
    .catch((err) => console.warn('[MASS] Semantic index init failed:', err?.message || err));
}

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
//
// Memory note: each pre-warmed SWR entry costs ~MBs (trending pulls up to 400
// enriched track records). On the 512 MB Render tier we'd rather pay first-
// request latency than sit at the memory ceiling forever, so pre-warm is OFF
// by default and gated on PREWARM_CACHES=true. When more than one worker is
// running, only worker 0 pre-warms so we don't multiply the cost.
if (process.env.PREWARM_CACHES === 'true' && (process.env.WORKER_INDEX || '0') === '0') {
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
  prewarm('Singles',          featuredWarmers.singles,     3500);
  prewarm('Global Favorites', featuredWarmers.globalFavorites, 3750);
  prewarm('G100',             featuredWarmers.g100,        4000);
  prewarm('Public Playlists', publicPlaylistsWarmer,       5000);
  prewarm('Genres',           genresWarmer,                8000);
} else {
  console.log('[MASS] Cache pre-warm disabled (set PREWARM_CACHES=true to enable). SWR caches will fill on first request.');
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

} // end of if (MASS_NO_LISTEN !== 'true')
