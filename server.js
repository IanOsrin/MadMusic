import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import http2 from 'node:http2';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID, randomBytes, createHash, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fetch, Agent } from 'undici';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import nodemailer from 'nodemailer';
import { searchCache, exploreCache, albumCache, publicPlaylistsCache, trendingCache, genreCache } from './cache.js';

// ============================================================================
// HTTP CONNECTION POOL FOR FILEMAKER
// ============================================================================
// Persistent connection pool to FileMaker for better performance
// Reuses TCP connections instead of creating new ones for each request
const fmAgent = new Agent({
  connections: 20,              // Max 20 persistent connections to FileMaker
  pipelining: 1,                // 1 request per connection (HTTP/1.1 default)
  keepAliveTimeout: 60000,      // Keep connections alive for 60 seconds
  keepAliveMaxTimeout: 600000,  // Maximum keep-alive time: 10 minutes
  connect: {
    timeout: 30000,             // 30 second connection timeout
    keepAlive: true,
    keepAliveInitialDelay: 1000
  }
});

console.log('[INIT] FileMaker HTTP connection pool created (20 persistent connections)');

// Request deduplication - prevent duplicate simultaneous requests to FileMaker
const pendingRequests = new Map();

async function deduplicatedFetch(cacheKey, cache, fetchFn) {
  // Check cache first
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  // Check if request is already pending
  if (pendingRequests.has(cacheKey)) {
    return pendingRequests.get(cacheKey);
  }

  // Execute and store the promise
  const promise = fetchFn().finally(() => {
    pendingRequests.delete(cacheKey);
  });

  pendingRequests.set(cacheKey, promise);
  return promise;
}

// ETag support for API responses - reduces bandwidth on repeat visits
function generateETag(data) {
  const hash = createHash('md5').update(JSON.stringify(data)).digest('hex');
  return `"${hash.slice(0, 16)}"`;
}

function sendWithETag(res, data) {
  const etag = generateETag(data);
  res.setHeader('ETag', etag);

  const clientETag = res.req.headers['if-none-match'];
  if (clientETag === etag) {
    return res.status(304).end();
  }

  return res.json(data);
}


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

function parsePositiveInt(value, fallback) {
  const num = Number.parseInt(value, 10);
  if (Number.isFinite(num) && num > 0) {
    return num;
  }
  return fallback;
}

function parseNonNegativeInt(value, fallback) {
  const num = Number.parseInt(value, 10);
  if (Number.isFinite(num) && num >= 0) {
    return num;
  }
  return fallback;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FM_TIMEOUT_MS = parsePositiveInt(process.env.FM_TIMEOUT_MS, 45000);
const fmDefaultFetchOptions = { timeoutMs: FM_TIMEOUT_MS, retries: 1, dispatcher: fmAgent };
const FM_MAX_CONCURRENT_REQUESTS = parsePositiveInt(process.env.FM_MAX_CONCURRENT_REQUESTS, 8);
const FM_MIN_REQUEST_INTERVAL_MS = parseNonNegativeInt(process.env.FM_MIN_REQUEST_INTERVAL_MS, 10);

const fmRequestQueue = [];
let fmActiveRequests = 0;
let fmLastRequestTime = 0;
let fmStartChain = Promise.resolve();

async function takeStartSlot() {
  let release;
  const prev = fmStartChain;
  fmStartChain = new Promise((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    if (FM_MIN_REQUEST_INTERVAL_MS > 0) {
      const elapsed = Date.now() - fmLastRequestTime;
      const waitMs = FM_MIN_REQUEST_INTERVAL_MS - elapsed;
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    }
    fmLastRequestTime = Date.now();
  } finally {
    release();
  }
}

function processFmQueue() {
  while (fmRequestQueue.length && fmActiveRequests < FM_MAX_CONCURRENT_REQUESTS) {
    const job = fmRequestQueue.shift();
    fmActiveRequests += 1;
    (async () => {
      try {
        await takeStartSlot();
        const result = await job.task();
        job.resolve(result);
      } catch (err) {
        job.reject(err);
      } finally {
        fmActiveRequests -= 1;
        if (fmRequestQueue.length) {
          process.nextTick(processFmQueue);
        }
      }
    })();
  }
}

function enqueueFmRequest(task) {
  return new Promise((resolve, reject) => {
    fmRequestQueue.push({ task, resolve, reject });
    if (fmRequestQueue.length > FM_MAX_CONCURRENT_REQUESTS * 4) {
      console.warn(`[FM] Request queue length: ${fmRequestQueue.length}`);
    }
    processFmQueue();
  });
}

function fmSafeFetch(url, options, overrides = {}) {
  const finalOptions = { ...fmDefaultFetchOptions, ...overrides };
  return enqueueFmRequest(() => safeFetch(url, options, finalOptions));
}

const app = express();
app.set('trust proxy', trustProxySetting);

// Track server start time for health checks
const SERVER_START_TIME = Date.now();

// Force HTTPS in production (security - prevent credential leakage)
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    if (proto !== 'https') {
      console.warn(`[SECURITY] Redirecting HTTP request to HTTPS: ${req.method} ${req.path}`);
      return res.redirect(301, `https://${req.get('host')}${req.url}`);
    }
    next();
  });

  // Add HSTS header (tell browsers to always use HTTPS)
  app.use((req, res, next) => {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
}

// Enable gzip compression with optimized settings
app.use(compression({
  level: 6, // Balance between compression ratio and speed
  threshold: 1024, // Only compress responses > 1KB
  filter: (req, res) => {
    // Skip compression if client requests no compression
    if (req.headers['x-no-compression']) return false;
    // Use default filter for everything else
    return compression.filter(req, res);
  }
}));

// Response time logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    // Only log API requests and slow requests (>100ms)
    if (req.path.startsWith('/api/') || duration > 100) {
      const cached = res.getHeader('X-Cache-Hit') === 'true' ? '[CACHED]' : '';
      console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms ${cached}`);
    }
  });
  next();
});

// Capture raw body for Paystack webhook signature verification (must be before express.json)
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());

// Rate limiting configuration
// More relaxed rate limits for development
const isDevelopment = (process.env.NODE_ENV === 'development' || process.env.HOST === 'localhost' || process.env.HOST === '127.0.0.1');

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDevelopment ? 1000 : 100, // Much higher limit in development
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
  // Note: No need to skip static files - they're handled early by express.static()
});

const expensiveLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: isDevelopment ? 500 : 20, // Much higher limit in development for testing
  message: { error: 'Rate limit exceeded for this endpoint' }
});

const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 payment attempts per window per IP
  message: { error: 'Too many payment requests, please try again later' }
});

// Apply general rate limiting to all API routes
app.use('/api/', apiLimiter);

// Add Cache-Control headers for API and HTML responses
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    if (process.env.NODE_ENV === 'development') {
      // Development: no caching to always see fresh data
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      // Production: 3 minutes browser cache
      res.setHeader('Cache-Control', 'public, max-age=180');
    }
  } else if (req.path === '/' || req.path.endsWith('.html')) {
    if (process.env.NODE_ENV === 'development') {
      // Development: no caching for HTML
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
  next();
});

// Access token validation middleware - checks all API requests
app.use('/api/', async (req, res, next) => {
  // Skip access token check for certain endpoints
  // Note: req.path already has /api/ stripped when using app.use('/api/', ...)
  const skipPaths = [
    '/access/validate',
    '/wake',  // Connection warming - called on page load before auth
    '/container',  // Container/image requests - can't send headers from <img> tags
    '/random-songs',  // Public discovery endpoint for "Discover More" and "Highlights"
    '/public-playlists',  // Featured playlists - public discovery
    '/search',  // Album/artist search - public discovery
    '/album',  // Album details - public discovery
    '/trending',  // Trending tracks - public discovery
    '/featured-albums',  // Featured albums - public discovery
    '/missing-audio-songs',  // Debug endpoint for finding missing audio
    '/auth',  // Authentication endpoints - must work without access token
    '/payments/initialize',  // Payment initialization - no token yet
    '/payments/callback',    // Paystack redirect callback
    '/payments/webhook',     // Paystack webhook
    '/payments/plans'        // Public plan listing
  ];

  if (skipPaths.some(path => req.path === path || req.path.startsWith(path))) {
    return next();
  }

  // Check for access token in header or body
  const accessToken = req.headers['x-access-token'] || req.body?.accessToken;

  if (!accessToken) {
    return res.status(403).json({
      ok: false,
      error: 'Access token required',
      requiresAccessToken: true
    });
  }

  const validation = await validateAccessToken(accessToken);

  if (!validation.valid) {
    return res.status(403).json({
      ok: false,
      error: 'Invalid or expired access token',
      reason: validation.reason,
      requiresAccessToken: true
    });
  }

  // Token is valid, attach info to request and continue
  req.accessToken = {
    code: accessToken,
    type: validation.type,
    expirationDate: validation.expirationDate,
    email: validation.email || null
  };

  next();
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ========= ENV ========= */
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const HTTP2_ENABLED = process.env.HTTP2_ENABLED === 'true';
const HTTP2_CERT_PATH = process.env.HTTP2_CERT_PATH || '';
const HTTP2_KEY_PATH = process.env.HTTP2_KEY_PATH || '';
const FM_HOST = process.env.FM_HOST;
const FM_DB = process.env.FM_DB;
const FM_USER = process.env.FM_USER;
const FM_PASS = process.env.FM_PASS;
const FM_LAYOUT = process.env.FM_LAYOUT || 'API_Album_Songs';
const FM_USERS_LAYOUT = process.env.FM_USERS_LAYOUT || 'API_Users';
const FM_STREAM_EVENTS_LAYOUT = process.env.FM_STREAM_EVENTS_LAYOUT || 'Stream_Events';
const FM_FEATURED_FIELD = (process.env.FM_FEATURED_FIELD || 'Tape Files::featured').trim();
const FM_FEATURED_VALUE = (process.env.FM_FEATURED_VALUE || 'yes').trim();
const FM_FEATURED_VALUE_LC = FM_FEATURED_VALUE.toLowerCase();
const STREAM_EVENT_DEBUG =
  process.env.DEBUG_STREAM_EVENTS === 'true' ||
  process.env.NODE_ENV === 'development' ||
  process.env.DEBUG?.includes('stream');
const MASS_SESSION_COOKIE = 'mass.sid';
const MASS_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days (reduced from 1 year for security)
const STREAM_EVENT_TYPES = new Set(['PLAY', 'PROGRESS', 'PAUSE', 'SEEK', 'END', 'ERROR']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ========= PAYSTACK PAYMENT CONFIGURATION =========
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_BASE_URL = 'https://api.paystack.co';
const PAYSTACK_PLANS = {
  '1-day':  { amount: 500,   label: '1 Day Access',  days: 1,  display: 'R5' },
  '7-day':  { amount: 2000,  label: '7 Day Access',  days: 7,  display: 'R20' },
  '30-day': { amount: 5000,  label: '30 Day Access', days: 30, display: 'R50' }
};

// ========= EMAIL CONFIGURATION =========
const EMAIL_HOST = process.env.EMAIL_HOST || 'smtp.ionos.com';
const EMAIL_PORT = parseInt(process.env.EMAIL_PORT) || 587;
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
const EMAIL_FROM = process.env.EMAIL_FROM || EMAIL_USER;

let emailTransporter = null;
if (EMAIL_USER && EMAIL_PASS) {
  emailTransporter = nodemailer.createTransport({
    host: EMAIL_HOST,
    port: EMAIL_PORT,
    secure: EMAIL_PORT === 465,
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
  });
  console.log(`[INIT] Email transporter configured (${EMAIL_USER})`);
}

// Track processed payment references for idempotency (prevents duplicate token generation)
const pendingPayments = new Map();

// Clean up old entries every hour
setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [ref, entry] of pendingPayments) {
    if (entry.timestamp < oneHourAgo) {
      pendingPayments.delete(ref);
    }
  }
}, 60 * 60 * 1000);

// Validate session ID format (security - prevent session fixation)
function validateSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    return null;
  }
  // Must be valid UUID format
  if (!UUID_REGEX.test(sessionId)) {
    return null;
  }
  return sessionId;
}
const STREAM_TERMINAL_EVENTS = new Set(['END', 'ERROR']);
const STREAM_TIME_FIELD = 'TimeStreamed';
const STREAM_TIME_FIELD_LEGACY = 'PositionSec';

const STREAM_RECORD_CACHE_TTL_MS = 30 * 60 * 1000;
const streamRecordCache = new Map();
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const PLAYLISTS_PATH = path.join(DATA_DIR, 'playlists.json');
const ACCESS_TOKENS_PATH = path.join(DATA_DIR, 'access-tokens.json');

// Serve static files EARLY (after constants defined, before API middleware)
// This bypasses rate limiting, JSON parsing, and other API-specific middleware
const REGEX_STATIC_FILES = /\.(jpe?g|png|gif|svg|webp|ico|woff2?|ttf|eot|mp3|mp4|webm)$/i;
app.use(express.static(PUBLIC_DIR, {
  index: false, // Don't auto-serve index.html - we handle routes manually
  setHeaders: (res, filePath) => {
    // Versioned files (contain ?v= or .min.) get immutable caching for 1 year
    if (filePath.includes('.min.') || /\.[a-f0-9]{8,}\./i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (REGEX_STATIC_FILES.test(filePath)) {
      // Images, fonts, media: 7 day cache
      res.setHeader('Cache-Control', 'public, max-age=604800');
    } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      // JS/CSS without version: 1 hour with revalidation
      res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
    } else {
      // HTML and other files: no cache for development
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
  etag: true,
  lastModified: true
}));
const JUKEBOX_IMAGE_PATH = path.join(PUBLIC_DIR, 'img', 'jukebox.png');

app.get('/img/jukebox.webp', async (req, res, next) => {
  try {
    await fs.access(JUKEBOX_IMAGE_PATH);
    res.type('image/png');
    res.sendFile(JUKEBOX_IMAGE_PATH);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENAMETOOLONG')) return next();
    next(err);
  }
});
const FEATURED_ALBUM_CACHE_TTL_MS = parsePositiveInt(process.env.FEATURED_ALBUM_CACHE_TTL_MS, 30 * 1000); // 30 seconds

let featuredAlbumCache = { items: [], total: 0, updatedAt: 0 };
let cachedFeaturedFieldName = null; // Cache the successful featured field name
class HttpError extends Error {
  constructor(status, body, meta = {}) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body;
    this.meta = meta;
  }
}

const PUBLIC_PLAYLIST_FIELDS = [
  'PublicPlaylist'
];

// Cache for discovered field names (performance optimization)
let publicPlaylistFieldCache = null; // Caches which field name works in FileMaker
let yearFieldCache = null; // Caches which year field name works in FileMaker

// Memoized regex patterns (performance optimization - avoids recompilation)
const REGEX_WHITESPACE = /\s+/g;
const REGEX_CURLY_SINGLE_QUOTES = /[\u2018\u2019]/g;
const REGEX_CURLY_DOUBLE_QUOTES = /[\u201C\u201D]/g;
const REGEX_LEADING_TRAILING_NONWORD = /^\W+|\W+$/g;
const REGEX_HTTP_HTTPS = /^https?:\/\//i;
const REGEX_ABSOLUTE_API_CONTAINER = /^https?:\/\/[^/]+\/api\/container\?/i;
const REGEX_DATA_URI = /^data:/i;
const REGEX_EXTRACT_NUMBERS = /[^0-9.-]/g;
const REGEX_TRACK_SONG = /(track|song)/;
const REGEX_NUMBER_INDICATORS = /(no|num|#|seq|order|pos)/;
const REGEX_TABLE_MISSING = /table is missing/i;
// REGEX_STATIC_FILES moved to top of file (line ~205) where express.static() is configured
const REGEX_SLUGIFY_NONALPHA = /[^a-z0-9]+/g;
const REGEX_SLUGIFY_TRIM_DASHES = /^-+|-+$/g;
const REGEX_UUID_DASHES = /-/g;
const REGEX_NORMALIZE_FIELD = /[^a-z0-9]/gi;

// Input validation helpers (security - prevent injection/XSS)
const validators = {
  searchQuery: (value) => {
    if (typeof value !== 'string') return { valid: false, error: 'Must be string' };
    const trimmed = value.trim();
    if (trimmed.length > 200) return { valid: false, error: 'Too long (max 200 chars)' };
    // Only reject explicit FileMaker query operators (==, <=, >=, <>, !)
    // Allow normal characters like & and words like "and", "or", "not" in artist/album names
    if (/^[=!<>]|[=]{2}|[<>]=|<>/.test(trimmed)) {
      return { valid: false, error: 'Invalid characters in search query' };
    }
    return { valid: true, value: trimmed };
  },

  playlistName: (value) => {
    if (typeof value !== 'string') return { valid: false, error: 'Must be string' };
    const trimmed = value.trim();
    if (trimmed.length < 1) return { valid: false, error: 'Playlist name required' };
    if (trimmed.length > 100) return { valid: false, error: 'Too long (max 100 chars)' };
    // Prevent XSS by rejecting HTML tags
    if (/<[^>]*>/g.test(trimmed)) {
      return { valid: false, error: 'HTML tags not allowed' };
    }
    return { valid: true, value: trimmed };
  },

  recordId: (value) => {
    const str = String(value).trim();
    if (!/^\d+$/.test(str)) {
      return { valid: false, error: 'Record ID must be numeric' };
    }
    if (str.length > 20) {
      return { valid: false, error: 'Record ID too long' };
    }
    return { valid: true, value: str };
  },

  limit: (value, max = 1000) => {
    const num = parseInt(value, 10);
    if (isNaN(num) || num < 1) return { valid: false, error: 'Limit must be positive integer' };
    if (num > max) return { valid: false, error: `Limit exceeds maximum (${max})` };
    return { valid: true, value: num };
  },

  offset: (value) => {
    const num = parseInt(value, 10);
    if (isNaN(num) || num < 0) return { valid: false, error: 'Offset must be non-negative integer' };
    if (num > 1000000) return { valid: false, error: 'Offset too large' };
    return { valid: true, value: num };
  },

  url: (value) => {
    if (typeof value !== 'string') return { valid: false, error: 'URL must be string' };
    const trimmed = value.trim();
    // Reject directory traversal attempts
    if (trimmed.includes('..') || trimmed.includes('\\')) {
      return { valid: false, error: 'Invalid URL path' };
    }
    if (trimmed.length > 2000) {
      return { valid: false, error: 'URL too long' };
    }
    return { valid: true, value: trimmed };
  }
};

const TRACK_SEQUENCE_FIELDS = [
  'Track Number',
  'TrackNumber',
  'Track_Number',
  'Track No',
  'Track No.',
  'Track_No',
  'Track #',
  'Track#',
  'Track Sequence',
  'Track Sequence Number',
  'Track Seq',
  'Track Seq No',
  'Track Order',
  'Track Position',
  'TrackPosition',
  'Sequence',
  'Seq',
  'Sequence Number',
  'Sequence_Number',
  'Song Number',
  'Song No',
  'Song Seq',
  'Song Order',
  'Tape Files::Track Number',
  'Tape Files::Track_No'
];
const PUBLIC_PLAYLIST_NAME_SPLIT = /[,;|\r\n]+/;
const FM_VISIBILITY_FIELD = (process.env.FM_VISIBILITY_FIELD || '').trim();
const FM_VISIBILITY_VALUE = (process.env.FM_VISIBILITY_VALUE || 'show').trim();
const FM_VISIBILITY_VALUE_LC = FM_VISIBILITY_VALUE.toLowerCase();


function hasValidAudio(fields) {
  if (!fields || typeof fields !== 'object') return false;
  for (const field of AUDIO_FIELD_CANDIDATES) {
    const raw = fields[field];
    if (!raw) continue;
    const resolved = resolvePlayableSrc(String(raw));
    if (resolved) return true;
  }
  for (const field of DEFAULT_AUDIO_FIELDS) {
    const raw = fields[field];
    if (!raw) continue;
    const resolved = resolvePlayableSrc(String(raw));
    if (resolved) return true;
  }
  return false;
}

function hasValidArtwork(fields) {
  if (!fields || typeof fields !== 'object') return false;

  // Only accept albums with Artwork_S3_URL containing "GMVi" (valid sleeves)
  const artworkS3URL = fields['Artwork_S3_URL'] || fields['Tape Files::Artwork_S3_URL'] || '';
  if (!artworkS3URL || typeof artworkS3URL !== 'string') return false;

  // Case-insensitive check for GMVi
  if (!artworkS3URL.toLowerCase().includes('gmvi')) return false;

  // Verify the artwork can be resolved
  const resolved = resolveArtworkSrc(artworkS3URL);
  return !!resolved;
}

function applyVisibility(query = {}) {
  if (!FM_VISIBILITY_FIELD) return { ...query };
  return { ...query, [FM_VISIBILITY_FIELD]: FM_VISIBILITY_VALUE };
}

function shouldFallbackVisibility(json) {
  const code = json?.messages?.[0]?.code;
  const codeStr = code === undefined || code === null ? '' : String(code);
  return codeStr === '102' || codeStr === '121';
}

function isMissingFieldError(json) {
  const code = json?.messages?.[0]?.code;
  const codeStr = code === undefined || code === null ? '' : String(code);
  return codeStr === '102';
}

function recordIsVisible(fields = {}) {
  if (!FM_VISIBILITY_FIELD) return true;
  const raw = fields[FM_VISIBILITY_FIELD] ?? fields['Tape Files::Visibility'];
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) return true;
  return value === FM_VISIBILITY_VALUE_LC;
}

function recordIsFeatured(fields = {}) {
  if (!FEATURED_FIELD_CANDIDATES.length) return false;
  for (const field of FEATURED_FIELD_CANDIDATES) {
    const raw = fields[field];
    if (raw === undefined || raw === null) continue;
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : String(raw).trim().toLowerCase();
    if (!value) continue;
    if (value === FM_FEATURED_VALUE_LC) {
      return true;
    }
  }
  return false;
}

const DEFAULT_AUDIO_FIELDS = ['S3_URL', 'mp3', 'MP3', 'Audio File', 'Audio::mp3'];
const AUDIO_FIELD_CANDIDATES = ['S3_URL', 'mp3', 'MP3', 'Audio File', 'Audio::mp3'];
const ARTWORK_FIELD_CANDIDATES = [
  'Artwork_S3_URL',
  'Tape Files::Artwork_S3_URL',
  'Artwork::Picture',
  'Artwork Picture',
  'Picture',
  'CoverArtURL',
  'AlbumCover',
  'Cover Art',
  'CoverArt'
];
const CATALOGUE_FIELD_CANDIDATES = [
  'Album Catalogue Number',
  'Reference Catalogue Number',
  'Tape Files::Reference Catalogue Number'
];
const FEATURED_FIELD_BASE = FM_FEATURED_FIELD.replace(/^tape files::/i, '').trim();
const FEATURED_FIELD_CANDIDATES = Array.from(
  new Set(
    [
      FM_FEATURED_FIELD,
      FEATURED_FIELD_BASE && `Tape Files::${FEATURED_FIELD_BASE}`,
      FEATURED_FIELD_BASE,
      'Tape Files::featured',
      'Tape Files::Featured',
      'featured',
      'Featured'
    ].filter(Boolean)
  )
);

const PUBLIC_PLAYLIST_LAYOUT = 'API_Album_Songs';
const PLAYLIST_IMAGE_EXTS = ['.webp', '.jpg', '.jpeg', '.png', '.gif', '.svg'];
const PLAYLIST_IMAGE_DIR = path.join(PUBLIC_DIR, 'img', 'Playlists');
const playlistImageCache = new Map();

let playlistsCache = { data: null, mtimeMs: 0 };
let accessTokensCache = { data: null, mtimeMs: 0 };
const loggedPublicPlaylistFieldErrors = new Set();

// Map FileMaker error codes to appropriate HTTP status codes
function fmErrorToHttpStatus(fmCode, defaultStatus = 500) {
  const code = parseInt(fmCode, 10);

  // FileMaker error code reference:
  // https://fmhelp.filemaker.com/docs/18/en/errorcodes/

  if (isNaN(code)) return defaultStatus;

  // No records found - return 404 Not Found
  if (code === 401) return 404;

  // Client errors (400-499) - invalid request, missing fields, etc.
  if (code === 102) return 400; // Field is missing
  if (code === 103) return 400; // Relationship is missing
  if (code === 104) return 400; // Script is missing
  if (code === 105) return 400; // Layout is missing
  if (code === 106) return 400; // Table is missing
  if (code >= 500 && code <= 599) return 400; // Date/time validation errors
  if (code >= 800 && code <= 899) return 400; // Find errors (invalid criteria)

  // Service unavailable (503) - FileMaker down or inaccessible
  if (code === 802) return 503; // Unable to open file
  if (code === 954) return 503; // Server is busy
  if (code === 958) return 503; // Parameter missing in query
  if (code >= 10000) return 503; // ODBC/External errors

  // Authentication/permission errors - 401 Unauthorized or 403 Forbidden
  if (code >= 200 && code <= 299) return 403; // Permission/access errors

  // Default to 500 for unknown errors
  return 500;
}

const normalizeRecordId = (value) => {
  if (value === undefined || value === null) return '';
  const str = String(value).trim();
  return str;
};

const playlistOwnerMatches = (ownerId, userEmail) => {
  if (!ownerId || !userEmail) return false;
  const ownerStr = String(ownerId).trim().toLowerCase();
  const emailStr = String(userEmail).trim().toLowerCase();
  return ownerStr === emailStr;
};

const slugifyPlaylistName = (name) =>
  String(name || '')
    .trim()
    .toLowerCase()
    .replace(REGEX_SLUGIFY_NONALPHA, '-')
    .replace(REGEX_SLUGIFY_TRIM_DASHES, '');

const normalizeShareId = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const generateShareId = () => {
  if (typeof randomUUID === 'function') {
    return randomUUID().replace(REGEX_UUID_DASHES, '');
  }
  return randomBytes(16).toString('hex');
};

const cloneTrackForShare = (track) => {
  if (!track || typeof track !== 'object') return null;
  const {
    id = null,
    trackRecordId = null,
    name = '',
    albumTitle = '',
    albumArtist = '',
    catalogue = '',
    trackArtist = '',
    mp3 = '',
    resolvedSrc = '',
    seq = null,
    artwork = '',
    audioField = '',
    artworkField = '',
    addedAt = null,
    producer = '',
    language = '',
    genre = '',
    isrc = '',
    composer1 = '',
    composer2 = '',
    composer3 = '',
    composer4 = '',
    composers = [],
    albumKey = '',
    picture = ''
  } = track;

  const payload = {
    id,
    trackRecordId,
    name,
    albumTitle,
    albumArtist,
    catalogue,
    trackArtist,
    mp3,
    resolvedSrc,
    seq,
    artwork,
    audioField,
    artworkField,
    addedAt
  };
  if (producer) payload.producer = producer;
  if (language) payload.language = language;
  if (genre) payload.genre = genre;
  if (isrc) payload.isrc = isrc;
  if (composer1) payload.composer1 = composer1;
  if (composer2) payload.composer2 = composer2;
  if (composer3) payload.composer3 = composer3;
  if (composer4) payload.composer4 = composer4;
  if (Array.isArray(composers) && composers.length) payload.composers = composers.slice();
  if (albumKey) payload.albumKey = albumKey;
  if (picture) payload.picture = picture;
  return payload;
};

const sanitizePlaylistForShare = (playlist) => {
  if (!playlist || typeof playlist !== 'object') return null;
  const tracks = Array.isArray(playlist.tracks)
    ? playlist.tracks.map(cloneTrackForShare).filter(Boolean)
    : [];
  return {
    id: playlist.id || null,
    shareId: normalizeShareId(playlist.shareId),
    name: playlist.name || '',
    sharedAt: playlist.sharedAt || null,
    createdAt: playlist.createdAt || null,
    updatedAt: playlist.updatedAt || null,
    tracks
  };
};

const resolveRequestOrigin = (req) => {
  const originHeader = req.get('origin');
  if (originHeader) return originHeader;
  const forwardedProto = req.get('x-forwarded-proto');
  const forwardedHost = req.get('x-forwarded-host');
  const host = forwardedHost || req.get('host');
  const proto = forwardedProto || req.protocol;
  if (proto && host) return `${proto}://${host}`;
  if (host) return `http://${host}`;
  return '';
};

const buildShareUrl = (req, shareId) => {
  const normalized = normalizeShareId(shareId);
  if (!normalized) return '';
  const origin = resolveRequestOrigin(req);
  const pathPart = `/?share=${encodeURIComponent(normalized)}`;
  return origin ? `${origin}${pathPart}` : pathPart;
};

async function resolvePlaylistImage(name) {
  if (!name) return null;
  const slug = slugifyPlaylistName(name);
  if (!slug) return null;
  if (playlistImageCache.has(slug)) return playlistImageCache.get(slug);
  for (const ext of PLAYLIST_IMAGE_EXTS) {
    const fullPath = path.join(PLAYLIST_IMAGE_DIR, slug + ext);
    try {
      await fs.access(fullPath);
      const relative = `/img/Playlists/${slug}${ext}`;
      playlistImageCache.set(slug, relative);
      return relative;
    } catch {
      // ignore
    }
  }
  playlistImageCache.set(slug, null);
  return null;
}

if (!FM_HOST || !FM_DB || !FM_USER || !FM_PASS) {
  console.warn('[MASS] Missing .env values; expected FM_HOST, FM_DB, FM_USER, FM_PASS');
}

const fmBase = `${FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(FM_DB)}`;
console.log(`[MASS] FileMaker connection: ${FM_HOST} -> Database: ${FM_DB}`);
let fmToken = null;
let fmTokenExpiresAt = 0;
let fmLoginPromise = null;

const TRENDING_LOOKBACK_HOURS = parsePositiveInt(process.env.TRENDING_LOOKBACK_HOURS, 168);
const TRENDING_FETCH_LIMIT = parsePositiveInt(process.env.TRENDING_FETCH_LIMIT, 400);
const TRENDING_MAX_LIMIT = parsePositiveInt(process.env.TRENDING_MAX_LIMIT, 20);

const RETRYABLE_CODES = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'ETIMEDOUT']);
const RETRYABLE_NAMES = new Set(['AbortError']);

async function safeFetch(url, options = {}, { timeoutMs = 15000, retries = 2, dispatcher = null } = {}) {
  let attempt = 0;
  let backoff = 500;

  while (true) {
    let timedOut = false;
    let externalAbort = false;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, timeoutMs);

    const { signal: originalSignal, headers: originalHeaders, dispatcher: optionsDispatcher, ...rest } = options || {};

    const headers = new Headers(originalHeaders || {});
    // Only set Connection: close if we're not using a connection pool
    const finalDispatcher = optionsDispatcher || dispatcher;
    if (!finalDispatcher && !headers.has('Connection')) {
      headers.set('Connection', 'close');
    }

    if (originalSignal) {
      if (originalSignal.aborted) {
        externalAbort = true;
        timeoutController.abort();
      } else {
        originalSignal.addEventListener(
          'abort',
          () => {
            externalAbort = true;
            timeoutController.abort();
          },
          { once: true }
        );
      }
    }

    const signals = [timeoutController.signal];
    if (originalSignal) signals.push(originalSignal);
    const composedSignal = signals.length > 1 ? AbortSignal.any(signals) : timeoutController.signal;

    try {
      const fetchOptions = { ...rest, headers, signal: composedSignal };
      if (finalDispatcher) {
        fetchOptions.dispatcher = finalDispatcher;
      }
      const response = await fetch(url, fetchOptions);
      clearTimeout(timer);
      return response;
    } catch (err) {
      clearTimeout(timer);
      err.timedOut = err.timedOut || timedOut;
      err.externalAbort = err.externalAbort || externalAbort;

      const message = String(err?.message || '').toLowerCase();
      const code = err?.code || err?.cause?.code;
      const retryable = !externalAbort && (
        err.timedOut ||
        RETRYABLE_NAMES.has(err?.name) ||
        (code && RETRYABLE_CODES.has(code)) ||
        message.includes('terminated')
      );

      if (retryable && attempt < retries) {
        await sleep(backoff);
        attempt += 1;
        backoff *= 2;
        continue;
      }
      throw err;
    }
  }
}

function getClientIP(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length) {
    const first = forwarded[0];
    if (typeof first === 'string' && first.trim()) {
      return first.trim();
    }
  }
  if (typeof req?.ip === 'string' && req.ip) {
    return req.ip;
  }
  const remoteAddress = req?.socket?.remoteAddress;
  if (typeof remoteAddress === 'string' && remoteAddress) {
    return remoteAddress;
  }
  return '';
}

async function lookupASN(ip) {
  // TODO: integrate MaxMind ASN or an external lookup service for ASN enrichment.
  if (!ip) return 'Unknown';
  return 'Unknown';
}

async function fmLogin() {
  // Mutex pattern: if login is already in progress, wait for it
  if (fmLoginPromise) {
    return fmLoginPromise;
  }

  fmLoginPromise = (async () => {
    try {
      const loginUrl = `${fmBase}/sessions`;
      console.log(`[FM LOGIN] Attempting to connect to: ${loginUrl}`);
      console.log(`[FM LOGIN] FM_HOST from env: ${FM_HOST}`);
      console.log(`[FM LOGIN] FM_DB from env: ${FM_DB}`);
      const res = await fmSafeFetch(loginUrl, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(`${FM_USER}:${FM_PASS}`).toString('base64')
        },
        body: JSON.stringify({})
      }, { retries: 1 });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = json?.messages?.[0]?.message || `HTTP ${res.status}`;
        throw new Error(`FM login failed: ${msg}`);
      }
      const token = json?.response?.token;
      if (!token) throw new Error('FM login returned no token');
      fmToken = token;
      // Token expires in 12 minutes, but refresh 30 seconds early for safety
      fmTokenExpiresAt = Date.now() + (11.5 * 60 * 1000);
      return fmToken;
    } finally {
      fmLoginPromise = null;
    }
  })();

  return fmLoginPromise;
}

async function ensureToken() {
  // Refresh token if missing or expired (using >= to catch exact expiration time)
  if (!fmToken || Date.now() >= fmTokenExpiresAt) {
    await fmLogin();
  }
  return fmToken;
}

async function fmPost(pathSuffix, body) {
  await ensureToken();
  const url = `${fmBase}${pathSuffix}`;
  const baseHeaders = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${fmToken}`
  };

  let res = await fmSafeFetch(url, {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify(body)
  });

  if (res.status === 401) {
    await fmLogin();
    res = await fmSafeFetch(url, {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'Authorization': `Bearer ${fmToken}`
      },
      body: JSON.stringify(body)
    });
  }

  return res;
}

async function fmGetAbsolute(u, { signal } = {}) {
  await ensureToken();
  const headers = new Headers();
  if (typeof u === 'string' && u.startsWith(FM_HOST)) {
    headers.set('Authorization', `Bearer ${fmToken}`);
  }

  let res = await fmSafeFetch(u, { headers, signal }, { retries: 1 });
  if (res.status === 401 && typeof u === 'string' && u.startsWith(FM_HOST)) {
    await fmLogin();
    headers.set('Authorization', `Bearer ${fmToken}`);
    res = await fmSafeFetch(u, { headers, signal }, { retries: 1 });
  }
  return res;
}

async function fmCreateRecord(layout, fieldData) {
  await ensureToken();
  const url = `${fmBase}/layouts/${encodeURIComponent(layout)}/records`;
  const makeHeaders = () => ({
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${fmToken}`
  });

  let res = await fmSafeFetch(url, {
    method: 'POST',
    headers: makeHeaders(),
    body: JSON.stringify({ fieldData })
  });

  if (res.status === 401) {
    await fmLogin();
    res = await fmSafeFetch(url, {
      method: 'POST',
      headers: makeHeaders(),
      body: JSON.stringify({ fieldData })
    });
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.messages?.[0]?.message || 'FM error';
    const code = json?.messages?.[0]?.code;
    throw new Error(`FM create failed: ${msg} (${code ?? 'n/a'})`);
  }
  return json?.response || null;
}

async function fmUpdateRecord(layout, recordId, fieldData) {
  if (!recordId) throw new Error('fmUpdateRecord requires recordId');
  await ensureToken();
  const url = `${fmBase}/layouts/${encodeURIComponent(layout)}/records/${encodeURIComponent(recordId)}`;
  const makeHeaders = () => ({
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${fmToken}`
  });

  let res = await fmSafeFetch(url, {
    method: 'PATCH',
    headers: makeHeaders(),
    body: JSON.stringify({ fieldData })
  });

  if (res.status === 401) {
    await fmLogin();
    res = await fmSafeFetch(url, {
      method: 'PATCH',
      headers: makeHeaders(),
      body: JSON.stringify({ fieldData })
    });
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.messages?.[0]?.message || 'FM error';
    const code = json?.messages?.[0]?.code;
    throw new Error(`FM update failed: ${msg} (${code ?? 'n/a'})`);
  }
  return json?.response || null;
}

async function fmGetRecordById(layout, recordId) {
  if (!recordId) return null;
  await ensureToken();
  const url = `${fmBase}/layouts/${encodeURIComponent(layout)}/records/${encodeURIComponent(recordId)}`;
  const makeHeaders = () => ({
    'Accept': 'application/json',
    'Authorization': `Bearer ${fmToken}`
  });

  let res = await fmSafeFetch(url, { method: 'GET', headers: makeHeaders() });

  if (res.status === 401) {
    await fmLogin();
    res = await fmSafeFetch(url, { method: 'GET', headers: makeHeaders() });
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    return null;
  }
  return json?.response?.data?.[0] || null;
}

async function fmFindRecords(layout, queries, { limit = 1, offset = 1, sort = [] } = {}) {
  const payload = {
    query: queries,
    limit,
    offset
  };
  if (Array.isArray(sort) && sort.length) {
    payload.sort = sort;
  }
  const r = await fmPost(`/layouts/${encodeURIComponent(layout)}/_find`, payload);
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = json?.messages?.[0]?.message || 'FM error';
    const code = json?.messages?.[0]?.code;
    return { ok: false, status: r.status, msg, code, data: [], total: 0 };
  }
  const data = json?.response?.data || [];
  const total = json?.response?.dataInfo?.foundCount ?? data.length;
  return { ok: true, data, total };
}

function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

const normalizeFieldKey = (name) => (typeof name === 'string' ? name.replace(REGEX_NORMALIZE_FIELD, '').toLowerCase() : '');

function pickFieldValueCaseInsensitive(fields = {}, candidates = []) {
  const entries = Object.entries(fields);
  for (const candidate of candidates) {
    for (const [key, raw] of entries) {
      if (key === candidate && raw !== undefined && raw !== null) {
        const str = typeof raw === 'string' ? raw.trim() : String(raw).trim();
        if (str) return { value: str, field: key };
      }
    }
    const needle = normalizeFieldKey(candidate);
    if (!needle) continue;
    for (const [key, raw] of entries) {
      if (key === candidate) continue;
      if (raw === undefined || raw === null) continue;
      if (normalizeFieldKey(key) !== needle) continue;
      const str = typeof raw === 'string' ? raw.trim() : String(raw).trim();
      if (str) return { value: str, field: key };
    }
  }
  return { value: '', field: '' };
}

function splitPlaylistNames(raw) {
  if (typeof raw !== 'string') return [];
  return raw.split(PUBLIC_PLAYLIST_NAME_SPLIT).map((value) => value.trim()).filter(Boolean);
}

function resolvePlayableSrc(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const src = raw.trim();
  if (!src) return '';

  // Detect FileMaker's internal container metadata format (not a valid URL)
  // Format: "size:0,0\rmovie:file.mp3\rmoviemac:/path/to/file.mp3"
  if (src.includes('\r') || src.includes('\n') ||
      (src.includes('movie:') && src.includes('size:')) ||
      src.includes('moviemac:') || src.includes('moviewin:')) {
    console.warn('[MASS] Detected FileMaker container metadata format, rejecting:', src.slice(0, 100));
    return ''; // Return empty so client falls back to recordId+field approach
  }

  if (src.startsWith('/api/container?')) return src;
  if (REGEX_ABSOLUTE_API_CONTAINER.test(src)) return src;
  if (REGEX_DATA_URI.test(src)) return src;

  // Return S3 URLs directly (no proxy needed) - optimized for direct browser playback
  if (/^https?:\/\/.*\.s3[.-]/.test(src) || /^https?:\/\/s3[.-]/.test(src)) return src;

  // Only proxy non-S3 HTTP URLs through /api/container
  if (REGEX_HTTP_HTTPS.test(src)) return `/api/container?u=${encodeURIComponent(src)}`;
  if (src.startsWith('/')) return src;
  return `/api/container?u=${encodeURIComponent(src)}`;
}

function resolveArtworkSrc(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const src = raw.trim();
  if (!src) return '';

  // Detect FileMaker's internal container metadata format (not a valid URL)
  // But allow GMVi URLs which might contain "image:" in the path
  if (src.includes('\r') || src.includes('\n') ||
      (src.includes('movie:') && src.includes('size:')) ||
      src.includes('moviemac:') || src.includes('moviewin:')) {
    console.warn('[MASS] Detected FileMaker container metadata in artwork, rejecting:', src.slice(0, 100));
    return ''; // Return empty - artwork is optional
  }

  if (src.startsWith('/api/container?')) return src;

  // Return S3 URLs directly (no proxy needed) - optimized for direct browser loading
  if (/^https?:\/\/.*\.s3[.-]/.test(src) || /^https?:\/\/s3[.-]/.test(src)) return src;

  // Return other HTTP/HTTPS URLs as-is (for compatibility)
  if (REGEX_HTTP_HTTPS.test(src)) return src;

  return `/api/container?u=${encodeURIComponent(src)}`;
}

function normTitle(str) {
  return String(str || '')
    .replace(REGEX_WHITESPACE, ' ')
    .replace(REGEX_CURLY_SINGLE_QUOTES, "'")
    .replace(REGEX_CURLY_DOUBLE_QUOTES, '"')
    .replace(REGEX_LEADING_TRAILING_NONWORD, '')
    .trim();
}

function makeAlbumKey(catalogue, title, artist) {
  const cat = String(catalogue || '').trim();
  if (cat) return `cat:${cat.toLowerCase()}`;
  const normT = normTitle(title || '').toLowerCase();
  const normA = normTitle(artist || '').toLowerCase();
  return `title:${normT}|artist:${normA}`;
}

function parseTrackSequence(fields = {}) {
  for (const key of TRACK_SEQUENCE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    const raw = fields[key];
    if (raw === undefined || raw === null) continue;
    const str = String(raw).trim();
    if (!str) continue;
    const numeric = Number(str);
    if (Number.isFinite(numeric)) return numeric;
    const cleaned = Number(str.replace(REGEX_EXTRACT_NUMBERS, ''));
    if (Number.isFinite(cleaned)) return cleaned;
  }
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    const lower = key.toLowerCase();
    if (!REGEX_TRACK_SONG.test(lower)) continue;
    if (!REGEX_NUMBER_INDICATORS.test(lower)) continue;
    const str = String(value).trim();
    if (!str) continue;
    const numeric = Number(str);
    if (Number.isFinite(numeric)) return numeric;
    const cleaned = Number(str.replace(REGEX_EXTRACT_NUMBERS, ''));
    if (Number.isFinite(cleaned)) return cleaned;
  }
  return Number.POSITIVE_INFINITY;
}

function composersFromFields(fields = {}) {
  return [
    fields['Composer'],
    fields['Composer 1'] ?? fields['Composer1'],
    fields['Composer 2'] ?? fields['Composer2'],
    fields['Composer 3'] ?? fields['Composer3'],
    fields['Composer 4'] ?? fields['Composer4']
  ]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value).trim())
    .filter(Boolean);
}

function firstNonEmpty(fields, candidates) {
  for (const candidate of candidates) {
    if (!Object.prototype.hasOwnProperty.call(fields, candidate)) continue;
    const raw = fields[candidate];
    if (raw === undefined || raw === null) continue;
    const str = String(raw).trim();
    if (str) return str;
  }
  return '';
}

// ========= OPTIMIZED FIELD MAP CACHING (40x faster) =========
// WeakMap automatically cleans up when field objects are garbage collected
const fieldMapCache = new WeakMap();

/**
 * Build a normalized field map for fast lookups (O(n) once per record)
 * Maps normalized field names to their values
 */
function getFieldMap(fields) {
  // Check cache first
  if (fieldMapCache.has(fields)) {
    return fieldMapCache.get(fields);
  }

  // Build normalized field name map
  const map = new Map();
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;

    // Store exact match first
    const str = typeof value === 'string' ? value.trim() : String(value).trim();
    if (str && !map.has(key)) {
      map.set(key, str);
    }

    // Also store normalized version for case-insensitive lookup
    const normalized = normalizeFieldKey(key);
    if (normalized && str && !map.has(normalized)) {
      map.set(normalized, str);
    }
  }

  // Cache for future lookups
  fieldMapCache.set(fields, map);
  return map;
}

/**
 * Fast field value picker using cached field map (O(15) vs O(750))
 */
function firstNonEmptyFast(fields, candidates) {
  const map = getFieldMap(fields); // O(1) if cached, O(50) first time

  // Try exact matches first
  for (const candidate of candidates) {
    if (map.has(candidate)) {
      return map.get(candidate);
    }
  }

  // Try normalized matches
  for (const candidate of candidates) {
    const normalized = normalizeFieldKey(candidate);
    if (normalized && map.has(normalized)) {
      return map.get(normalized);
    }
  }

  return '';
}

async function fetchPublicPlaylistRecords({ limit = 100 } = {}) {
  // Robust version: try each candidate PublicPlaylist field individually, skip 102 errors,
  // merge and dedupe results.
  if (!FM_HOST || !FM_DB || !FM_USER || !FM_PASS) {
    return { records: [], total: 0, missingEnv: true };
  }

  const seen = new Set();
  const records = [];
  let totalFound = 0;

  const batchSize = Math.max(1, Math.min(100, limit));
  const candidates = Array.isArray(PUBLIC_PLAYLIST_FIELDS) ? PUBLIC_PLAYLIST_FIELDS : ['PublicPlaylist'];

  // Try cached field first, then others (performance optimization)
  const fieldsToTry = publicPlaylistFieldCache
    ? [publicPlaylistFieldCache, ...candidates.filter(f => f !== publicPlaylistFieldCache)]
    : candidates;

  for (const field of fieldsToTry) {
    let offset = 1;
    let progressed = false;
    while (records.length < limit) {
      const remaining = limit - records.length;
      const currentLimit = Math.min(batchSize, remaining);
      let json;
      try {
        const response = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, {
          query: [{ [field]: '*' }],
          limit: currentLimit,
          offset
        });
        json = await response.json().catch(() => ({}));

        if (!response.ok) {
          const msg = json?.messages?.[0]?.message || 'FM error';
          const code = json?.messages?.[0]?.code;
          const tableMissing = typeof msg === 'string' && REGEX_TABLE_MISSING.test(msg);
          // Skip missing field errors (102) and move to next candidate
          if (String(code) === '102') {
            console.warn(`[MASS] Skipping playlist field "${field}" (FileMaker code 102: Field is missing on layout ${FM_LAYOUT})`);
            break;
          }
          if (tableMissing) {
            if (!loggedPublicPlaylistFieldErrors.has(field)) {
              loggedPublicPlaylistFieldErrors.add(field);
              console.warn(
                `[MASS] Skipping playlist field "${field}" because FileMaker reported "Table is missing" on layout ${FM_LAYOUT}`
              );
            }
            break;
          }
          console.warn(`[MASS] Public playlist query on field "${field}" failed: ${msg} (${code ?? response.status})`);
          break;
        }
      } catch (err) {
        const msg = err?.message || '';
        if (REGEX_TABLE_MISSING.test(msg)) {
          if (!loggedPublicPlaylistFieldErrors.has(field)) {
            loggedPublicPlaylistFieldErrors.add(field);
            console.warn(
              `[MASS] Skipping playlist field "${field}" because FileMaker reported "Table is missing" on layout ${FM_LAYOUT}`
            );
          }
        } else {
          console.warn(`[MASS] Public playlist query on field "${field}" threw`, msg || err);
        }
        break;
      }

      const data = json?.response?.data || [];
      totalFound = Math.max(totalFound, json?.response?.dataInfo?.foundCount ?? 0);

      let added = 0;
      for (const row of data) {
        const rid = row?.recordId ? String(row.recordId) : JSON.stringify(row?.fieldData || row);
        if (seen.has(rid)) continue;
        seen.add(rid);
        records.push(row);
        added++;
        if (records.length >= limit) break;
      }

      progressed = progressed || added > 0;

      // Cache the working field name for future requests (performance optimization)
      if (added > 0 && !publicPlaylistFieldCache) {
        publicPlaylistFieldCache = field;
        console.log(`[CACHE] Detected public playlist field: "${field}"`);
      }

      if (data.length < currentLimit) break;
      offset += data.length;
    }
    // If this field produced any result and we already have enough rows, we can stop early
    if (records.length >= limit) break;
  }

  return { records, total: totalFound || records.length };
}

async function buildPublicPlaylistsPayload({ nameParam = '', limit = 100 } = {}) {
  const normalizedName = (nameParam || '').toString().trim();
  const normalizedLimit = Math.max(1, Math.min(2000, Number(limit) || 100));
  const result = await fetchPublicPlaylistRecords({ limit: normalizedLimit });
  if (result && result.missingEnv) {
    return { missingEnv: true };
  }
  const records = result?.records || [];
  if (!records.length) {
    const payload = { ok: true, playlists: [] };
    if (normalizedName) payload.tracks = [];
    return { payload };
  }

  const summaryMap = new Map();
  const tracks = [];
  const targetName = normalizedName.toLowerCase();

  for (const record of records) {
    const fields = record?.fieldData || {};
    if (!hasValidAudio(fields)) continue;

    const playlistInfo = pickFieldValueCaseInsensitive(fields, PUBLIC_PLAYLIST_FIELDS);
    if (!playlistInfo.value) continue;
    const playlistNames = splitPlaylistNames(playlistInfo.value);
    if (!playlistNames.length) continue;

    const trackName = firstNonEmptyFast(fields, ['Track Name', 'Tape Files::Track Name', 'Tape Files::Track_Name', 'Song Name', 'Song_Title', 'Title', 'Name']);
    const albumTitle = firstNonEmptyFast(fields, ['Album Title', 'Tape Files::Album_Title', 'Tape Files::Album Title', 'Album']);
    const albumArtist = firstNonEmptyFast(fields, ['Album Artist', 'Tape Files::Album Artist', 'Tape Files::Album_Artist', 'AlbumArtist', 'Artist']);
    const trackArtist = firstNonEmptyFast(fields, ['Track Artist', 'Tape Files::Track Artist', 'TrackArtist', 'Artist']) || albumArtist;
    const catalogue = firstNonEmptyFast(fields, CATALOGUE_FIELD_CANDIDATES);
    const genre = firstNonEmptyFast(fields, ['Local Genre', 'Tape Files::Local Genre', 'Genre']);
    const language = firstNonEmptyFast(fields, ['Language', 'Tape Files::Language', 'Language Code']);
    const producer = firstNonEmptyFast(fields, ['Producer', 'Tape Files::Producer']);

    const audioInfo = pickFieldValueCaseInsensitive(fields, AUDIO_FIELD_CANDIDATES);
    const artworkInfo = pickFieldValueCaseInsensitive(fields, ARTWORK_FIELD_CANDIDATES);
    const resolvedSrc = resolvePlayableSrc(audioInfo.value);
    const resolvedArt = resolveArtworkSrc(artworkInfo.value);
    const composers = composersFromFields(fields);
    const seq = parseTrackSequence(fields);
    const recordId = record.recordId ? String(record.recordId) : '';
    const albumKey = makeAlbumKey(catalogue, albumTitle, albumArtist);

    for (const rawName of playlistNames) {
      const trimmed = rawName.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      let entry = summaryMap.get(key);
      if (!entry) {
        entry = { name: trimmed, albumKeys: new Set(), trackCount: 0 };
        summaryMap.set(key, entry);
      }
      if (albumKey) entry.albumKeys.add(albumKey);
      entry.trackCount += 1;

      if (targetName && key === targetName) {
        tracks.push({
          id: recordId,
          trackRecordId: recordId,
          name: trackName || `Track ${tracks.length + 1}`,
          seq: Number.isFinite(seq) ? Number(seq) : null,
          albumTitle,
          albumArtist,
          trackArtist,
          catalogue,
          genre,
          language,
          producer,
          composers,
          isrc: firstNonEmptyFast(fields, ['ISRC', 'Tape Files::ISRC']) || '',
          composer1: fields['Composer'] || fields['Composer 1'] || fields['Composer1'] || '',
          composer2: fields['Composer 2'] || fields['Composer2'] || '',
          composer3: fields['Composer 3'] || fields['Composer3'] || '',
          composer4: fields['Composer 4'] || fields['Composer4'] || '',
          mp3: audioInfo.value || '',
          resolvedSrc,
          audioField: audioInfo.field || '',
          artworkField: artworkInfo.field || '',
          picture: resolvedArt,
          albumPicture: resolvedArt,
          albumKey,
          hasValidAudio: true
        });
      }
    }
  }

  const summaryEntries = Array.from(summaryMap.values());
  const playlists = await Promise.all(
    summaryEntries.map(async (entry) => {
      const image = (await resolvePlaylistImage(entry.name)) || '';
      return {
        name: entry.name,
        albumCount: entry.albumKeys.size,
        trackCount: entry.trackCount,
        image
      };
    })
  );
  playlists.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  if (normalizedName) {
    const match = playlists.find((p) => p && typeof p.name === 'string' && p.name.toLowerCase() === targetName);
    const fallbackImage = match?.image || '';
    if (fallbackImage) {
      for (const track of tracks) {
        if (!track || typeof track !== 'object') continue;
        if (!track.picture) track.picture = fallbackImage;
        if (!track.albumPicture) track.albumPicture = fallbackImage;
      }
    }
  }

  const payload = { ok: true, playlists };
  if (normalizedName) payload.tracks = tracks;
  return { payload };
}

function parseCookies(req) {
  const header = req.headers?.cookie;
  if (!header) return {};
  const out = {};
  const pieces = header.split(';');
  for (const piece of pieces) {
    const part = piece.trim();
    if (!part) continue;
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx);
    const value = part.slice(idx + 1);
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function validateQueryString(value, fieldName, maxLength = 200) {
  if (value === null || value === undefined) {
    return { ok: true, value: '' };
  }
  if (typeof value !== 'string') {
    return { ok: false, reason: `${fieldName} must be a string` };
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    return { ok: false, reason: `${fieldName} too long (max ${maxLength} characters)` };
  }
  return { ok: true, value: trimmed };
}

async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (err) {
    console.warn('[MASS] Failed to ensure data directory exists:', err);
  }
}

async function loadPlaylists() {
  try {
    const stat = await fs.stat(PLAYLISTS_PATH);
    if (Array.isArray(playlistsCache.data) && playlistsCache.mtimeMs === stat.mtimeMs) {
      return playlistsCache.data;
    }

    const raw = await fs.readFile(PLAYLISTS_PATH, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      console.warn('[MASS] Playlists file contained invalid JSON, resetting to empty list:', parseErr);
      await fs.writeFile(PLAYLISTS_PATH, '[]', 'utf8');
      let repairedMtime = Date.now();
      try {
        const repairedStat = await fs.stat(PLAYLISTS_PATH);
        if (repairedStat?.mtimeMs) repairedMtime = repairedStat.mtimeMs;
      } catch {
        // ignore stat errors; continue with Date.now()
      }
      playlistsCache = { data: [], mtimeMs: repairedMtime };
      return playlistsCache.data;
    }
    const data = Array.isArray(parsed) ? parsed : [];

    // Migrate legacy numeric userId values to email addresses
    let migrated = false;
    for (const entry of data) {
      if (entry && typeof entry === 'object') {
        delete entry.userEmail; // Remove legacy email field
        if (entry.userId && /^\d+$/.test(String(entry.userId))) {
          try {
            const record = await fmGetRecordById(FM_USERS_LAYOUT, entry.userId);
            if (record) {
              const email = normalizeEmail(record.fieldData?.Email || '');
              if (email) {
                console.log(`[MASS] Migrating playlist "${entry.name}" from userId=${entry.userId} to email=${email}`);
                entry.userId = email;
                migrated = true;
              }
            }
          } catch (err) {
            console.warn(`[MASS] Could not migrate playlist "${entry.name}" (userId=${entry.userId}):`, err?.message || err);
          }
        }
      }
    }
    if (migrated) {
      try { await savePlaylists(data); } catch (err) { console.warn('[MASS] Failed to save migrated playlists:', err); }
    }

    playlistsCache = { data, mtimeMs: stat.mtimeMs };
    return data;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      await ensureDataDir();
      await fs.writeFile(PLAYLISTS_PATH, '[]', 'utf8');
      playlistsCache = { data: [], mtimeMs: Date.now() };
      return playlistsCache.data;
    }
    console.warn('[MASS] Failed to read playlists file:', err);
    return Array.isArray(playlistsCache.data) ? playlistsCache.data : [];
  }
}

async function savePlaylists(playlists) {
  try {
    await ensureDataDir();
    const normalized = Array.isArray(playlists) ? playlists : [];
    for (const entry of normalized) {
      if (entry && typeof entry === 'object') {
        // userId is now an email address (or legacy numeric id)
        if (entry.userId) entry.userId = String(entry.userId).trim();

        // Remove legacy email field
        delete entry.userEmail;

        const shareId = normalizeShareId(entry.shareId);
        if (shareId) {
          entry.shareId = shareId;
        } else {
          delete entry.shareId;
          if (entry.sharedAt) entry.sharedAt = null;
        }
      }
    }
    const payload = JSON.stringify(normalized, null, 2);
    const tempPath = `${PLAYLISTS_PATH}.tmp`;
    await fs.writeFile(tempPath, payload, 'utf8');
    await fs.rename(tempPath, PLAYLISTS_PATH);
    let mtimeMs = Date.now();
    try {
      const stat = await fs.stat(PLAYLISTS_PATH);
      if (stat?.mtimeMs) mtimeMs = stat.mtimeMs;
    } catch {
      // ignore stat errors; fall back to Date.now()
    }
    playlistsCache = { data: normalized, mtimeMs };
  } catch (err) {
    console.error('[MASS] Failed to write playlists file:', err);
    throw err;
  }
}

// ========= ACCESS TOKEN MANAGEMENT =========

async function loadAccessTokens() {
  try {
    const stat = await fs.stat(ACCESS_TOKENS_PATH);
    if (accessTokensCache.data && accessTokensCache.mtimeMs === stat.mtimeMs) {
      return accessTokensCache.data;
    }

    const raw = await fs.readFile(ACCESS_TOKENS_PATH, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      console.warn('[MASS] Access tokens file contained invalid JSON, resetting to default:', parseErr);
      const defaultData = {
        tokens: [
          {
            code: 'MASS-UNLIMITED-ACCESS',
            type: 'unlimited',
            issuedDate: new Date().toISOString(),
            expirationDate: null,
            notes: 'Master cheat token - never expires'
          }
        ]
      };
      await fs.writeFile(ACCESS_TOKENS_PATH, JSON.stringify(defaultData, null, 2), 'utf8');
      accessTokensCache = { data: defaultData, mtimeMs: Date.now() };
      return defaultData;
    }

    const data = parsed && typeof parsed === 'object' ? parsed : { tokens: [] };
    if (!Array.isArray(data.tokens)) {
      data.tokens = [];
    }

    accessTokensCache = { data, mtimeMs: stat.mtimeMs };
    return data;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      await ensureDataDir();
      const defaultData = {
        tokens: [
          {
            code: 'MASS-UNLIMITED-ACCESS',
            type: 'unlimited',
            issuedDate: new Date().toISOString(),
            expirationDate: null,
            notes: 'Master cheat token - never expires'
          }
        ]
      };
      await fs.writeFile(ACCESS_TOKENS_PATH, JSON.stringify(defaultData, null, 2), 'utf8');
      accessTokensCache = { data: defaultData, mtimeMs: Date.now() };
      return defaultData;
    }
    console.warn('[MASS] Failed to read access tokens file:', err);
    return accessTokensCache.data || { tokens: [] };
  }
}

async function saveAccessTokens(tokenData) {
  try {
    await ensureDataDir();
    const normalized = tokenData && typeof tokenData === 'object' ? tokenData : { tokens: [] };
    if (!Array.isArray(normalized.tokens)) {
      normalized.tokens = [];
    }

    const payload = JSON.stringify(normalized, null, 2);
    const tempPath = `${ACCESS_TOKENS_PATH}.tmp`;
    await fs.writeFile(tempPath, payload, 'utf8');
    await fs.rename(tempPath, ACCESS_TOKENS_PATH);

    let mtimeMs = Date.now();
    try {
      const stat = await fs.stat(ACCESS_TOKENS_PATH);
      if (stat?.mtimeMs) mtimeMs = stat.mtimeMs;
    } catch {
      // ignore stat errors; fall back to Date.now()
    }
    accessTokensCache = { data: normalized, mtimeMs };
  } catch (err) {
    console.error('[MASS] Failed to write access tokens file:', err);
    throw err;
  }
}

// ========= PAYSTACK PAYMENT HELPERS =========

// Generate a secure random token code (same format as scripts/generate-access-token.js)
function generateTokenCode() {
  const bytes = randomBytes(6);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid confusing chars like 0/O, 1/I
  let code = 'MASS-';
  for (let i = 0; i < bytes.length; i++) {
    if (i === 3) code += '-';
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

// Create a new access token and save it to JSON + attempt FileMaker sync
async function createAccessToken(days, notes, email) {
  const code = generateTokenCode();
  const issuedDate = new Date();
  const expirationDate = new Date(issuedDate);
  expirationDate.setDate(expirationDate.getDate() + days);

  const token = {
    code,
    type: 'trial',
    issuedDate: issuedDate.toISOString(),
    expirationDate: expirationDate.toISOString(),
    notes: notes || `${days}-day access (Paystack purchase)`
  };
  if (email && email !== 'unknown') token.email = email;

  // Save to JSON file
  const tokenData = await loadAccessTokens();
  tokenData.tokens.push(token);
  await saveAccessTokens(tokenData);

  // Attempt to create in FileMaker (async, non-blocking)
  try {
    const layout = process.env.FM_TOKENS_LAYOUT || 'API_Access_Tokens';
    const durationSeconds = days * 24 * 60 * 60;
    const fmFields = {
      'Token_Code': code,
      'Token_Type': 'trial',
      'Active': 1,
      'Token_Duration_Hours': String(durationSeconds),
      'Notes': token.notes
    };
    if (token.email) fmFields['Email'] = token.email;
    await fmCreateRecord(layout, fmFields);
    console.log(`[MASS] Payment token ${code} synced to FileMaker`);
  } catch (err) {
    console.warn(`[MASS] Failed to sync payment token ${code} to FileMaker (JSON fallback active):`, err?.message || err);
  }

  console.log(`[MASS] Created access token ${code} (${days} days, expires ${expirationDate.toISOString()})`);
  return token;
}

// Send token delivery email (fire-and-forget, never blocks payment flow)
function sendTokenEmail(customerEmail, tokenCode, days) {
  if (!emailTransporter) {
    console.log('[MASS] Email transporter not configured — skipping token email');
    return;
  }
  if (!customerEmail || customerEmail === 'unknown') {
    console.log('[MASS] No customer email available — skipping token email');
    return;
  }

  const planLabel = days === 1 ? '1 Day' : `${days} Days`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a1a; margin-bottom: 8px;">Your Mass Music Access Token</h2>
      <p style="color: #555; margin-bottom: 24px;">Thank you for your purchase! Here is your access token:</p>
      <div style="background: #f4f4f4; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
        <span style="font-size: 28px; font-weight: bold; letter-spacing: 2px; color: #1a1a1a;">${tokenCode}</span>
      </div>
      <p style="color: #555;"><strong>Plan:</strong> ${planLabel} Access</p>
      <p style="color: #555; margin-bottom: 24px;">Enter this token on the Mass Music app to activate your streaming access.</p>
      <hr style="border: none; border-top: 1px solid #ddd; margin: 24px 0;" />
      <p style="color: #999; font-size: 12px;">If you did not make this purchase, please ignore this email.</p>
    </div>
  `;

  emailTransporter.sendMail({
    from: EMAIL_FROM,
    to: customerEmail,
    subject: `Your Mass Music Access Token: ${tokenCode}`,
    html
  }).then(() => {
    console.log(`[MASS] Token email sent to ${customerEmail}`);
  }).catch(err => {
    console.error(`[MASS] Failed to send token email to ${customerEmail}:`, err?.message || err);
  });
}

// Make authenticated requests to Paystack API
async function paystackRequest(method, endpoint, body) {
  if (!PAYSTACK_SECRET_KEY) {
    throw new Error('PAYSTACK_SECRET_KEY not configured');
  }
  const url = `${PAYSTACK_BASE_URL}${endpoint}`;
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Paystack API error: ${data.message || response.statusText}`);
  }
  return data;
}

// Verify Paystack webhook signature using HMAC-SHA512
function verifyPaystackWebhook(rawBody, signature) {
  if (!PAYSTACK_SECRET_KEY || !signature) return false;
  const hash = createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');
  return hash === signature;
}

// Fallback function: validates token from JSON file (used if FileMaker is down)
function validateAccessTokenFromJSON(tokenCode) {
  if (!tokenCode || typeof tokenCode !== 'string') {
    return { valid: false, reason: 'No token provided' };
  }

  const trimmedCode = tokenCode.trim().toUpperCase();

  // Special case: cheat token (unlimited access)
  if (trimmedCode === 'MASS-UNLIMITED-ACCESS') {
    return {
      valid: true,
      type: 'unlimited',
      expirationDate: null,
      email: null,
      message: 'Unlimited access token'
    };
  }

  // Load and check against stored tokens
  const tokenData = accessTokensCache.data || { tokens: [] };
  const token = tokenData.tokens.find(t =>
    t.code && t.code.trim().toUpperCase() === trimmedCode
  );

  if (!token) {
    return { valid: false, reason: 'Invalid token' };
  }

  // Check expiration
  if (token.expirationDate) {
    const expirationTime = new Date(token.expirationDate).getTime();
    const now = Date.now();

    if (now > expirationTime) {
      return {
        valid: false,
        reason: 'Token expired',
        expirationDate: token.expirationDate
      };
    }
  }

  return {
    valid: true,
    type: token.type || 'trial',
    expirationDate: token.expirationDate,
    issuedDate: token.issuedDate,
    notes: token.notes,
    email: token.email ? normalizeEmail(token.email) : null
  };
}

// Main function: validates token from FileMaker database
async function validateAccessToken(tokenCode) {
  if (!tokenCode || typeof tokenCode !== 'string') {
    return { valid: false, reason: 'No token provided' };
  }

  const trimmedCode = tokenCode.trim().toUpperCase();

  // Special case: unlimited cheat token (no DB lookup needed)
  if (trimmedCode === 'MASS-UNLIMITED-ACCESS') {
    return {
      valid: true,
      type: 'unlimited',
      expirationDate: null,
      email: null,
      message: 'Unlimited access token'
    };
  }

  try {
    // Look up token in FileMaker
    const layout = process.env.FM_TOKENS_LAYOUT || 'API_Access_Tokens';
    console.log(`[MASS] Looking up token "${trimmedCode}" in FileMaker layout "${layout}"`);

    const result = await fmFindRecords(layout, [
      { 'Token_Code': `==${trimmedCode}` }  // Exact match search
    ], { limit: 1 });

    console.log(`[MASS] FileMaker token lookup result: ${result?.data?.length || 0} records found`);

    // Token not found in FileMaker - try JSON fallback
    if (!result || !result.data || result.data.length === 0) {
      console.log('[MASS] Token not found in FileMaker, trying JSON fallback');
      return validateAccessTokenFromJSON(tokenCode);
    }

    const token = result.data[0].fieldData;

    // Check if token is disabled
    if (token.Active === 0 || token.Active === '0') {
      return { valid: false, reason: 'Token disabled' };
    }

    // Check expiration
    if (token.Expiration_Date) {
      // Parse FileMaker timestamp with timezone offset
      // FileMaker stores timestamps in server's local timezone (CAT = UTC+2)
      // We need to convert to UTC for comparison
      const fmTimezoneOffset = parseFloat(process.env.FM_TIMEZONE_OFFSET || '0');

      // Parse the FileMaker date string
      let expirationTime = new Date(token.Expiration_Date).getTime();

      // Adjust for FileMaker's timezone offset (convert FM local time to UTC)
      // If FM is UTC+2, subtract 2 hours to get UTC
      const offsetMs = fmTimezoneOffset * 60 * 60 * 1000;
      expirationTime = expirationTime - offsetMs;

      const now = Date.now();

      console.log(`[MASS] Token expiration check for ${trimmedCode}:`);
      console.log(`  Raw expiration from FM: "${token.Expiration_Date}"`);
      console.log(`  FM Timezone offset: ${fmTimezoneOffset > 0 ? '+' : ''}${fmTimezoneOffset} hours`);
      console.log(`  Parsed as local: ${new Date(token.Expiration_Date).toISOString()}`);
      console.log(`  Adjusted to UTC: ${new Date(expirationTime).toISOString()}`);
      console.log(`  Current UTC time: ${new Date(now).toISOString()}`);
      console.log(`  Time until expiry: ${((expirationTime - now) / 1000 / 60 / 60).toFixed(2)} hours`);

      if (isNaN(expirationTime)) {
        console.warn(`[MASS] Could not parse expiration date: "${token.Expiration_Date}" - treating as no expiration`);
      } else if (now > expirationTime) {
        console.log(`[MASS] Token ${trimmedCode} is EXPIRED`);
        return {
          valid: false,
          reason: 'Token expired',
          expirationDate: token.Expiration_Date
        };
      } else {
        console.log(`[MASS] Token ${trimmedCode} is still valid`);
      }
    }

    // Update usage statistics (async - don't wait for it)
    const recordId = result.data[0].recordId;
    const now = new Date();
    const fmTimestamp = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()} ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    const updateFields = {
      'Last_Used': fmTimestamp,
      'Use_Count': (parseInt(token.Use_Count) || 0) + 1
    };

    // Track if we're calculating a new expiration for first-time use
    let calculatedExpirationUTC = null;

    // If this is the first use, set First_Used timestamp
    if (!token.First_Used || token.First_Used === '') {
      updateFields['First_Used'] = fmTimestamp;
      console.log(`[MASS] Setting First_Used for token ${trimmedCode}`);

      // Also calculate and set Expiration_Date if Token_Duration_Hours is set
      if (token.Token_Duration_Hours && parseInt(token.Token_Duration_Hours) > 0) {
        const durationSeconds = parseInt(token.Token_Duration_Hours);
        const expirationTime = new Date(now.getTime() + (durationSeconds * 1000));
        const fmExpiration = `${expirationTime.getMonth() + 1}/${expirationTime.getDate()}/${expirationTime.getFullYear()} ${expirationTime.getHours()}:${String(expirationTime.getMinutes()).padStart(2, '0')}:${String(expirationTime.getSeconds()).padStart(2, '0')}`;
        updateFields['Expiration_Date'] = fmExpiration;

        // Store the calculated expiration as UTC ISO string for return
        calculatedExpirationUTC = expirationTime.toISOString();
        console.log(`[MASS] Setting Expiration_Date for token ${trimmedCode}: ${fmExpiration} (${durationSeconds} seconds from now)`);
      }
    }

    fmUpdateRecord(layout, recordId, updateFields).catch(err => {
      console.warn('[MASS] Failed to update token usage stats:', err);
    });

    // Token is valid!
    // Use calculated expiration if we just set it, otherwise convert from DB
    let expirationDateUTC = calculatedExpirationUTC;
    if (!expirationDateUTC && token.Expiration_Date) {
      const fmTimezoneOffset = parseFloat(process.env.FM_TIMEZONE_OFFSET || '0');
      let expirationTimeUTC = new Date(token.Expiration_Date).getTime();
      const offsetMs = fmTimezoneOffset * 60 * 60 * 1000;
      expirationTimeUTC = expirationTimeUTC - offsetMs;
      expirationDateUTC = new Date(expirationTimeUTC).toISOString();
    }

    return {
      valid: true,
      type: token.Token_Type || 'trial',
      expirationDate: expirationDateUTC,
      issuedDate: token.Issued_Date,
      notes: token.Notes,
      email: token.Email ? normalizeEmail(token.Email) : null
    };
  } catch (err) {
    console.error('[MASS] FileMaker token validation error:', err);

    // Fallback to JSON file if FileMaker lookup fails
    console.warn('[MASS] Falling back to JSON file for token validation');
    return validateAccessTokenFromJSON(tokenCode);
  }
}

function normalizeTrackPayload(raw = {}) {
  const recordId = typeof raw.recordId === 'string' ? raw.recordId.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const albumTitle = typeof raw.albumTitle === 'string' ? raw.albumTitle.trim() : '';
  const albumArtist = typeof raw.albumArtist === 'string' ? raw.albumArtist.trim() : '';
  const catalogue = typeof raw.catalogue === 'string' ? raw.catalogue.trim() : '';
  const trackArtist = typeof raw.trackArtist === 'string' ? raw.trackArtist.trim() : '';
  const mp3 = typeof raw.mp3 === 'string' ? raw.mp3.trim() : '';
  const resolvedSrc = typeof raw.resolvedSrc === 'string' ? raw.resolvedSrc.trim() : '';
  let seq = raw.seq;
  if (typeof seq === 'string') {
    const parsed = Number(seq.trim());
    seq = Number.isFinite(parsed) ? parsed : null;
  } else if (typeof seq === 'number') {
    seq = Number.isFinite(seq) ? seq : null;
  } else {
    seq = null;
  }
  const artwork = typeof raw.artwork === 'string' ? raw.artwork.trim() : '';
  const audioField = typeof raw.audioField === 'string' ? raw.audioField.trim() : '';
  const artworkField = typeof raw.artworkField === 'string' ? raw.artworkField.trim() : '';
  return {
    recordId,
    name,
    albumTitle,
    albumArtist,
    catalogue,
    trackArtist,
    mp3,
    resolvedSrc,
    seq,
    artwork,
    audioField,
    artworkField
  };
}

function trackDuplicateKey(payload) {
  if (!payload) return '';
  if (payload.recordId) return `id:${payload.recordId}`;
  if (payload.name && payload.albumTitle && payload.albumArtist) {
    return `meta:${payload.name}|${payload.albumTitle}|${payload.albumArtist}`;
  }
  return '';
}

function trackDuplicateKeyFromEntry(entry = {}) {
  const recordId = typeof entry.trackRecordId === 'string' ? entry.trackRecordId.trim() : '';
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  const albumTitle = typeof entry.albumTitle === 'string' ? entry.albumTitle.trim() : '';
  const albumArtist = typeof entry.albumArtist === 'string' ? entry.albumArtist.trim() : '';
  return trackDuplicateKey({ recordId, name, albumTitle, albumArtist });
}

function summarizeTrackPayload(payload = {}) {
  return {
    recordId: payload.recordId || null,
    name: payload.name || '',
    albumTitle: payload.albumTitle || '',
    albumArtist: payload.albumArtist || '',
    seq: Number.isFinite(payload.seq) ? payload.seq : null
  };
}

function buildTrackEntry(payload, addedAt) {
  return {
    id: randomUUID(),
    trackRecordId: payload.recordId || null,
    name: payload.name,
    albumTitle: payload.albumTitle,
    albumArtist: payload.albumArtist,
    catalogue: payload.catalogue,
    trackArtist: payload.trackArtist,
    mp3: payload.mp3,
    resolvedSrc: payload.resolvedSrc,
    seq: Number.isFinite(payload.seq) ? payload.seq : null,
    artwork: payload.artwork,
    audioField: payload.audioField,
    artworkField: payload.artworkField,
    addedAt
  };
}

function buildPlaylistDuplicateIndex(playlist) {
  const map = new Map();
  const tracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
  for (const entry of tracks) {
    const key = trackDuplicateKeyFromEntry(entry);
    if (key && !map.has(key)) {
      map.set(key, entry);
    }
  }
  return map;
}

function resolveDuplicate(map, payload) {
  const key = trackDuplicateKey(payload);
  if (!key) return { key: '', entry: null };
  return { key, entry: map.get(key) || null };
}

function streamRecordCacheKey(sessionId, trackRecordId) {
  return `${sessionId}::${trackRecordId}`;
}

function getCachedStreamRecordId(sessionId, trackRecordId) {
  const key = streamRecordCacheKey(sessionId, trackRecordId);
  const entry = streamRecordCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt < Date.now()) {
    streamRecordCache.delete(key);
    return null;
  }
  return entry.recordId || null;
}

function setCachedStreamRecordId(sessionId, trackRecordId, recordId) {
  if (!sessionId || !trackRecordId || !recordId) return;
  const key = streamRecordCacheKey(sessionId, trackRecordId);
  streamRecordCache.set(key, {
    recordId,
    expiresAt: Date.now() + STREAM_RECORD_CACHE_TTL_MS
  });
}

function clearCachedStreamRecordId(sessionId, trackRecordId) {
  if (!sessionId || !trackRecordId) return;
  const key = streamRecordCacheKey(sessionId, trackRecordId);
  streamRecordCache.delete(key);
}

async function findStreamRecord(sessionId, trackRecordId) {
  if (!sessionId || !trackRecordId) return null;
  const query = [
    {
      SessionID: `==${sessionId}`,
      TrackRecordID: `==${trackRecordId}`
    }
  ];
  const sort = [
    { fieldName: 'LastEventUTC', sortOrder: 'descend' },
    { fieldName: 'TimestampUTC', sortOrder: 'descend' }
  ];
  let result = await fmFindRecords(FM_STREAM_EVENTS_LAYOUT, query, { limit: 1, offset: 1, sort });
  if (!result.ok) {
    result = await fmFindRecords(FM_STREAM_EVENTS_LAYOUT, query, { limit: 1, offset: 1 });
  }
  if (!result.ok || result.data.length === 0) return null;
  const entry = result.data[0];
  const recordId = entry?.recordId;
  if (recordId) setCachedStreamRecordId(sessionId, trackRecordId, recordId);
  return {
    recordId,
    fieldData: entry?.fieldData || {}
  };
}

async function ensureStreamRecord(sessionId, trackRecordId, createFields, { forceNew = false } = {}) {
  if (!sessionId || !trackRecordId) {
    throw new Error('ensureStreamRecord requires sessionId and trackRecordId');
  }
  if (forceNew) {
    clearCachedStreamRecordId(sessionId, trackRecordId);
  } else {
    const cachedId = getCachedStreamRecordId(sessionId, trackRecordId);
    if (cachedId) {
      return { recordId: cachedId, created: false, response: null, existingFieldData: null };
    }
  }
  if (!forceNew) {
    const existing = await findStreamRecord(sessionId, trackRecordId);
    if (existing?.recordId) {
      return { recordId: existing.recordId, created: false, response: null, existingFieldData: existing.fieldData || null };
    }
  }
  const response = await fmCreateRecord(FM_STREAM_EVENTS_LAYOUT, createFields);
  const recordId = response?.recordId;
  if (!recordId) {
    throw new Error('Stream event create returned no recordId');
  }
  setCachedStreamRecordId(sessionId, trackRecordId, recordId);
  return { recordId, created: true, response, existingFieldData: null };
}

function normalizeSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return Math.max(0, Math.round(parsed));
  }
  return 0;
}

function toCleanString(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

// Escape HTML to prevent XSS attacks
function escapeHtml(unsafe) {
  if (typeof unsafe !== 'string') {
    unsafe = String(unsafe ?? '');
  }
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatTimestampUTC(dateInput = new Date()) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(d.getTime())) {
    return formatTimestampUTC(new Date());
  }
  const pad = (num) => String(num).padStart(2, '0');
  const month = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const year = d.getUTCFullYear();
  const hours = pad(d.getUTCHours());
  const minutes = pad(d.getUTCMinutes());
  const seconds = pad(d.getUTCSeconds());
  return `${month}/${day}/${year} ${hours}:${minutes}:${seconds}`;
}

function parseFileMakerTimestamp(value) {
  if (value instanceof Date) {
    const ts = value.getTime();
    return Number.isNaN(ts) ? 0 : ts;
  }
  if (typeof value !== 'string') {
    if (value === null || value === undefined) return 0;
    return parseFileMakerTimestamp(String(value));
  }
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    // FileMaker uses MM/DD/YYYY HH:MM:SS - Date.parse usually handles it; fallback to Date constructor
    const fallback = new Date(trimmed.replace(/-/g, '/'));
    const ts = fallback.getTime();
    return Number.isNaN(ts) ? 0 : ts;
  }
  return parsed;
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  const uptimeMs = Date.now() - SERVER_START_TIME;
  const uptimeSec = Math.floor(uptimeMs / 1000);
  res.json({
    status: 'ok',
    uptime: uptimeSec,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/stream-events', async (req, res) => {
  try {
    // Debug: Check if access token is available
    if (STREAM_EVENT_DEBUG) {
      console.log('[MASS] Stream event - Access Token:', req.accessToken?.code || 'NO TOKEN');
    }

    const {
      eventType = '',
      trackRecordId = '',
      trackISRC = '',
      positionSec = 0,
      durationSec = 0,
      deltaSec = 0
    } = req.body || {};

    const normalizedType = String(eventType || '').trim().toUpperCase();
    if (!STREAM_EVENT_TYPES.has(normalizedType)) {
      res.status(400).json({ ok: false, error: 'Invalid eventType' });
      return;
    }

    const headersSessionRaw = req.get?.('X-Session-ID') || req.headers?.['x-session-id'];
    let sessionId = Array.isArray(headersSessionRaw) ? headersSessionRaw[0] : headersSessionRaw;
    if (typeof sessionId === 'string') {
      sessionId = sessionId.trim();
    }

    const cookies = parseCookies(req);
    if (!sessionId) {
      sessionId = cookies[MASS_SESSION_COOKIE] || '';
    }

    // Validate session ID format (security - prevent session fixation)
    const validatedSession = validateSessionId(sessionId);
    if (!validatedSession) {
      // Invalid or missing session ID - generate new one
      sessionId = randomUUID();
      if (STREAM_EVENT_DEBUG && cookies[MASS_SESSION_COOKIE]) {
        console.log(`[SECURITY] Invalid session ID rejected, generating new one`);
      }
    } else {
      sessionId = validatedSession;
    }

    if (!cookies[MASS_SESSION_COOKIE] || cookies[MASS_SESSION_COOKIE] !== sessionId) {
      const cookieParts = [
        `${MASS_SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
        'Path=/',
        `Max-Age=${MASS_SESSION_MAX_AGE_SECONDS}`,
        'SameSite=Lax'
      ];
      res.setHeader('Set-Cookie', cookieParts.join('; '));
    }

    const timestamp = formatTimestampUTC();
    const clientIP = getClientIP(req);
    const asn = await lookupASN(clientIP);
    const userAgentHeader = req.headers?.['user-agent'];
    const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader || '';

    const normalizedTrackRecordId = toCleanString(trackRecordId);
    if (!normalizedTrackRecordId) {
      res.status(400).json({ ok: false, error: 'trackRecordId is required' });
      return;
    }

    const normalizedTrackISRC = toCleanString(trackISRC);

    const normalizedPosition = normalizeSeconds(positionSec);
    const normalizedDuration = normalizeSeconds(durationSec);
    const payloadDelta = normalizeSeconds(deltaSec);
    const baseFields = {
      TimestampUTC: timestamp,
      EventType: normalizedType,
      TrackRecordID: normalizedTrackRecordId,
      TrackISRC: normalizedTrackISRC,
      [STREAM_TIME_FIELD]: normalizedPosition,
      DurationSec: normalizedDuration,
      DeltaSec: payloadDelta,
      SessionID: sessionId,
      ClientIP: clientIP,
      ASN: asn || 'Unknown',
      UserAgent: userAgent,
      Token_Number: req.accessToken?.code || ''
    };

    const primaryKey = randomUUID();
    const createFields = {
      PrimaryKey: primaryKey,
      SessionID: sessionId,
      TrackRecordID: normalizedTrackRecordId,
      TrackISRC: normalizedTrackISRC,
      TimestampUTC: timestamp,
      EventType: normalizedType,
      [STREAM_TIME_FIELD]: normalizedPosition,
      DurationSec: normalizedDuration,
      DeltaSec: payloadDelta,
      ClientIP: clientIP,
      ASN: asn || 'Unknown',
      UserAgent: userAgent,
      TotalPlayedSec: payloadDelta,
      PlayStartUTC: normalizedType === 'PLAY' ? timestamp : '',
      LastEventUTC: timestamp,
      Token_Number: req.accessToken?.code || ''
    };

    if (STREAM_EVENT_DEBUG) {
      console.info('[MASS] stream event logging', {
        eventType: baseFields.EventType,
        sessionId,
        trackRecordId: normalizedTrackRecordId,
        timeStreamed: baseFields[STREAM_TIME_FIELD],
        deltaSec: baseFields.DeltaSec,
        tokenNumber: baseFields.Token_Number
      });
    }

    const forceNewRecord = normalizedType === 'PLAY';
    const ensureResult = await ensureStreamRecord(sessionId, normalizedTrackRecordId, createFields, { forceNew: forceNewRecord });
    const existingFields = ensureResult.existingFieldData || {};

    const existingPositionValue = existingFields
      ? existingFields[STREAM_TIME_FIELD] ?? existingFields[STREAM_TIME_FIELD_LEGACY]
      : null;
    const existingPosition = normalizeSeconds(existingPositionValue);
    const deltaFromPosition = Math.max(0, baseFields[STREAM_TIME_FIELD] - existingPosition);
    if (existingPosition > baseFields[STREAM_TIME_FIELD]) {
      baseFields[STREAM_TIME_FIELD] = existingPosition;
    }
    const existingDuration = normalizeSeconds(existingFields.DurationSec);
    if (existingDuration && !baseFields.DurationSec) {
      baseFields.DurationSec = existingDuration;
    }
    if (!baseFields.TrackISRC && existingFields.TrackISRC) {
      baseFields.TrackISRC = existingFields.TrackISRC;
    }

    const existingTotalPlayed = normalizeSeconds(existingFields.TotalPlayedSec);
    const effectiveDelta = payloadDelta || deltaFromPosition;
    baseFields.DeltaSec = effectiveDelta;
    baseFields.TotalPlayedSec = existingTotalPlayed + effectiveDelta;
    baseFields.LastEventUTC = timestamp;
    if (!existingFields.PlayStartUTC && normalizedType === 'PLAY') {
      baseFields.PlayStartUTC = timestamp;
    }

    // Ensure DurationSec reflects track length when provided at END.
    if (normalizedType === 'END' && normalizedDuration && normalizedDuration > baseFields.DurationSec) {
      baseFields.DurationSec = normalizedDuration;
    }

    if (STREAM_EVENT_DEBUG) {
      console.info('[MASS] Updating FileMaker record with Token_Number:', baseFields.Token_Number);
    }

    let fmResponse = await fmUpdateRecord(FM_STREAM_EVENTS_LAYOUT, ensureResult.recordId, baseFields);

    if (STREAM_EVENT_DEBUG) {
      console.info('[MASS] stream event persisted', {
        eventType: baseFields.EventType,
        sessionId,
        trackRecordId: normalizedTrackRecordId,
        recordId: ensureResult.recordId,
        totalPlayedSec: baseFields.TotalPlayedSec,
        timeStreamed: baseFields[STREAM_TIME_FIELD]
      });
    }

    if (STREAM_TERMINAL_EVENTS.has(normalizedType)) {
      clearCachedStreamRecordId(sessionId, normalizedTrackRecordId);
    } else {
      setCachedStreamRecordId(sessionId, normalizedTrackRecordId, ensureResult.recordId);
    }

    res.json({ ok: true, recordId: ensureResult.recordId, totalPlayedSec: baseFields.TotalPlayedSec });
  } catch (err) {
    console.error('[MASS] stream event failed', err);
    const errorMessage = err?.message || 'Stream event logging failed';
    res.status(500).json({ ok: false, error: errorMessage });
  }
});

async function collectTrendingStats({ limit, lookbackHours, fetchLimit }) {
  const normalizedLimit = Math.max(1, limit || 5);
  const cutoffDate = lookbackHours && lookbackHours > 0
    ? new Date(Date.now() - lookbackHours * 60 * 60 * 1000)
    : null;
  const baseQuery = { TrackRecordID: '*' };
  if (cutoffDate) {
    baseQuery.LastEventUTC = `>=${formatTimestampUTC(cutoffDate)}`;
  }

  const findResult = await fmFindRecords(
    FM_STREAM_EVENTS_LAYOUT,
    [baseQuery],
    {
      limit: fetchLimit,
      offset: 1,
      sort: [
        { fieldName: 'TimestampUTC', sortOrder: 'descend' }
      ]
    }
  );

  if (!findResult.ok) {
    const detail = `${findResult.msg || 'FM error'}${findResult.code ? ` (FM ${findResult.code})` : ''}`;
    throw new Error(`Trending stream query failed: ${detail}`);
  }

  const statsByTrack = new Map();
  for (const entry of findResult.data) {
    const fields = entry?.fieldData || {};
    const trackRecordId = normalizeRecordId(fields.TrackRecordID || fields['Track Record ID'] || '');
    if (!trackRecordId) continue;
    const totalSeconds = normalizeSeconds(
      fields.TotalPlayedSec ??
      fields[STREAM_TIME_FIELD] ??
      fields.DurationSec ??
      fields.DeltaSec ??
      0
    );
    const lastEventTs = parseFileMakerTimestamp(fields.LastEventUTC || fields.TimestampUTC);
    const sessionId = toCleanString(fields.SessionID || fields['Session ID'] || '');
    if (!statsByTrack.has(trackRecordId)) {
      statsByTrack.set(trackRecordId, {
        trackRecordId,
        totalSeconds: 0,
        playCount: 0,
        sessionIds: new Set(),
        lastEvent: 0
      });
    }
    const stat = statsByTrack.get(trackRecordId);
    stat.totalSeconds += totalSeconds || 0;
    stat.playCount += 1;
    if (sessionId) stat.sessionIds.add(sessionId);
    if (lastEventTs > stat.lastEvent) {
      stat.lastEvent = lastEventTs;
    }
  }

  if (!statsByTrack.size) {
    return [];
  }

  const sortedStats = Array.from(statsByTrack.values()).sort((a, b) => {
    if (b.totalSeconds !== a.totalSeconds) return b.totalSeconds - a.totalSeconds;
    if (b.playCount !== a.playCount) return b.playCount - a.playCount;
    return b.lastEvent - a.lastEvent;
  });

  const results = [];
  for (const stat of sortedStats) {
    const record = await fmGetRecordById(FM_LAYOUT, stat.trackRecordId);
    if (!record) continue;
    const fields = record.fieldData || {};
    if (!recordIsVisible(fields)) continue;
    if (!hasValidAudio(fields)) continue;
    if (!hasValidArtwork(fields)) continue;
    results.push({
      recordId: record.recordId || stat.trackRecordId,
      modId: record.modId || '0',
      fields,
      metrics: {
        plays: stat.playCount,
        uniqueListeners: stat.sessionIds.size || 0,
        lastPlayedAt: stat.lastEvent ? new Date(stat.lastEvent).toISOString() : null
      }
    });
    if (results.length >= normalizedLimit) break;
  }

  return results;
}

async function fetchTrendingTracks(limit = 5) {
  const normalizedLimit = Math.max(1, Math.min(TRENDING_MAX_LIMIT, limit || 5));
  const baseFetchLimit = Math.min(2000, Math.max(normalizedLimit * 80, TRENDING_FETCH_LIMIT));
  const attempts = [];
  if (TRENDING_LOOKBACK_HOURS > 0) {
    attempts.push({
      lookbackHours: TRENDING_LOOKBACK_HOURS,
      fetchLimit: baseFetchLimit
    });
  }
  attempts.push({
    lookbackHours: 0,
    fetchLimit: Math.min(2000, baseFetchLimit * 2)
  });

  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    try {
      const items = await collectTrendingStats({
        limit: normalizedLimit,
        lookbackHours: attempt.lookbackHours,
        fetchLimit: attempt.fetchLimit
      });
      if (items.length || i === attempts.length - 1) {
        return items.slice(0, normalizedLimit);
      }
    } catch (err) {
      if (i === attempts.length - 1) throw err;
      console.warn('[TRENDING] Attempt failed (will retry with fallback):', err?.message || err);
    }
  }
  return [];
}

function requireTokenEmail(req, res) {
  const email = req.accessToken?.email;
  if (!email) {
    res.status(401).json({ ok: false, error: 'Access token with associated email required' });
    return null;
  }
  return { email };
}

// ========= ACCESS TOKEN ENDPOINTS =========

console.log('[MASS] Registering access token validation endpoint');
app.post('/api/access/validate', async (req, res) => {
  console.log('[MASS] /api/access/validate route hit');
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        ok: false,
        valid: false,
        error: 'Token is required'
      });
    }

    const result = await validateAccessToken(token);

    if (result.valid) {
      res.json({
        ok: true,
        valid: true,
        type: result.type,
        expirationDate: result.expirationDate,
        email: result.email || null,
        message: result.message || 'Token is valid'
      });
    } else {
      res.status(401).json({
        ok: false,
        valid: false,
        reason: result.reason,
        expirationDate: result.expirationDate
      });
    }
  } catch (err) {
    console.error('[MASS] Token validation failed:', err);
    res.status(500).json({ ok: false, valid: false, error: 'Token validation failed' });
  }
});

// ========= PAYSTACK PAYMENT ENDPOINTS =========

// GET /api/payments/plans — return available plans with pricing
app.get('/api/payments/plans', (req, res) => {
  const plans = Object.entries(PAYSTACK_PLANS).map(([key, plan]) => ({
    id: key,
    label: plan.label,
    days: plan.days,
    display: plan.display,
    amount: plan.amount
  }));
  res.json({ ok: true, plans });
});

// POST /api/payments/initialize — create a Paystack transaction and return checkout URL
app.post('/api/payments/initialize', paymentLimiter, async (req, res) => {
  try {
    const { email, plan } = req.body;

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ ok: false, error: 'Valid email is required' });
    }

    const selectedPlan = PAYSTACK_PLANS[plan];
    if (!selectedPlan) {
      return res.status(400).json({ ok: false, error: 'Invalid plan. Choose: 1-day, 7-day, or 30-day' });
    }

    if (!PAYSTACK_SECRET_KEY) {
      return res.status(503).json({ ok: false, error: 'Payment system not configured' });
    }

    // Build callback URL from request origin
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const callbackUrl = `${protocol}://${host}/api/payments/callback`;

    const data = await paystackRequest('POST', '/transaction/initialize', {
      email: email.trim().toLowerCase(),
      amount: selectedPlan.amount,
      currency: 'ZAR',
      callback_url: callbackUrl,
      metadata: {
        plan_id: plan,
        plan_label: selectedPlan.label,
        days: selectedPlan.days
      }
    });

    console.log(`[MASS] Payment initialized: ${data.data.reference} (${plan}, ${email})`);

    res.json({
      ok: true,
      authorization_url: data.data.authorization_url,
      reference: data.data.reference
    });
  } catch (err) {
    console.error('[MASS] Payment initialization failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to initialize payment' });
  }
});

// GET /api/payments/callback — Paystack redirects here after payment
app.get('/api/payments/callback', async (req, res) => {
  const { reference } = req.query;

  if (!reference) {
    return res.redirect('/?payment=error&reason=missing_reference');
  }

  try {
    // Check idempotency — if we already processed this reference, return existing token
    if (pendingPayments.has(reference)) {
      const existing = pendingPayments.get(reference);
      console.log(`[MASS] Payment callback duplicate for ${reference}, returning existing token ${existing.tokenCode}`);
      return res.redirect(`/?payment=success&token=${encodeURIComponent(existing.tokenCode)}`);
    }

    // Verify payment with Paystack API
    const data = await paystackRequest('GET', `/transaction/verify/${encodeURIComponent(reference)}`);

    if (!data.data || data.data.status !== 'success') {
      console.warn(`[MASS] Payment verification failed for ${reference}: status=${data.data?.status}`);
      return res.redirect(`/?payment=failed&reason=not_successful`);
    }

    // Double-check idempotency after verification (race condition guard)
    if (pendingPayments.has(reference)) {
      const existing = pendingPayments.get(reference);
      return res.redirect(`/?payment=success&token=${encodeURIComponent(existing.tokenCode)}`);
    }

    // Extract plan info from metadata
    const metadata = data.data.metadata || {};
    const planId = metadata.plan_id;
    const days = parseInt(metadata.days) || 7;
    const email = data.data.customer?.email || 'unknown';

    // Generate access token
    const token = await createAccessToken(days, `Paystack purchase: ${planId} (${email}, ref: ${reference})`, email);

    // Send token via email (fire-and-forget)
    sendTokenEmail(email, token.code, days);

    // Mark as processed for idempotency
    pendingPayments.set(reference, {
      tokenCode: token.code,
      timestamp: Date.now()
    });

    console.log(`[MASS] Payment successful: ${reference} → token ${token.code} (${days} days)`);

    // Redirect to app with token in URL
    res.redirect(`/?payment=success&token=${encodeURIComponent(token.code)}`);
  } catch (err) {
    console.error(`[MASS] Payment callback error for ${reference}:`, err);
    res.redirect(`/?payment=error&reason=verification_failed`);
  }
});

// POST /api/payments/webhook — Paystack webhook backup confirmation
app.post('/api/payments/webhook', async (req, res) => {
  try {
    const rawBody = req.body;
    const signature = req.headers['x-paystack-signature'];

    // Verify webhook signature
    if (!verifyPaystackWebhook(rawBody, signature)) {
      console.warn('[MASS] Paystack webhook signature verification failed');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(rawBody.toString());

    // Only process successful charges
    if (event.event !== 'charge.success') {
      return res.sendStatus(200);
    }

    const paymentData = event.data;
    const reference = paymentData.reference;

    if (!reference) {
      console.warn('[MASS] Paystack webhook missing reference');
      return res.sendStatus(200);
    }

    // Check idempotency — already processed via callback
    if (pendingPayments.has(reference)) {
      console.log(`[MASS] Webhook: payment ${reference} already processed via callback`);
      return res.sendStatus(200);
    }

    // Extract plan info and generate token (backup path)
    const metadata = paymentData.metadata || {};
    const days = parseInt(metadata.days) || 7;
    const email = paymentData.customer?.email || 'unknown';
    const planId = metadata.plan_id || 'unknown';

    const token = await createAccessToken(days, `Paystack webhook: ${planId} (${email}, ref: ${reference})`, email);

    // Send token via email (fire-and-forget)
    sendTokenEmail(email, token.code, days);

    pendingPayments.set(reference, {
      tokenCode: token.code,
      timestamp: Date.now()
    });

    console.log(`[MASS] Webhook: payment ${reference} → token ${token.code} (${days} days)`);

    res.sendStatus(200);
  } catch (err) {
    console.error('[MASS] Paystack webhook error:', err);
    res.sendStatus(500);
  }
});

app.get('/api/playlists', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email = user.email;
    const playlists = await loadPlaylists();
    const mine = playlists.filter((p) => p && playlistOwnerMatches(p.userId, email));
    res.json({ ok: true, playlists: mine });
  } catch (err) {
    console.error('[MASS] Fetch playlists failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load playlists' });
  }
});

app.post('/api/playlists', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email = user.email;
    const nameRaw = req.body?.name;

    // Validate playlist name (prevent XSS and enforce limits)
    if (!nameRaw) {
      res.status(400).json({ ok: false, error: 'Playlist name required' });
      return;
    }
    const nameValidation = validators.playlistName(nameRaw);
    if (!nameValidation.valid) {
      res.status(400).json({ ok: false, error: nameValidation.error });
      return;
    }
    const name = nameValidation.value;

    const now = new Date().toISOString();
    const playlists = await loadPlaylists();
    const collision = playlists.find(
      (p) => p && playlistOwnerMatches(p.userId, email) && typeof p.name === 'string' && p.name.toLowerCase() === name.toLowerCase()
    );
    if (collision) {
      res.status(409).json({ ok: false, error: 'You already have a playlist with that name', playlist: collision });
      return;
    }

    const playlist = {
      id: randomUUID(),
      userId: email,
      name,
      tracks: [],
      createdAt: now,
      updatedAt: now
    };

    playlists.push(playlist);
    await savePlaylists(playlists);

    res.status(201).json({ ok: true, playlist });
  } catch (err) {
    console.error('[MASS] Create playlist failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to create playlist' });
  }
});

app.post('/api/playlists/:playlistId/tracks', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email = user.email;
    const playlistId = req.params?.playlistId;
    if (!playlistId) {
      res.status(400).json({ ok: false, error: 'Playlist ID required' });
      return;
    }

    const trackPayload = normalizeTrackPayload(req.body?.track || {});

    if (!trackPayload.name) {
      res.status(400).json({ ok: false, error: 'Track name required' });
      return;
    }

    const playlists = await loadPlaylists();
    const index = playlists.findIndex((p) => p && p.id === playlistId && playlistOwnerMatches(p.userId, email));
    if (index === -1) {
      res.status(404).json({ ok: false, error: 'Playlist not found' });
      return;
    }

    const playlist = playlists[index];
    playlist.tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];

    const duplicateIndex = buildPlaylistDuplicateIndex(playlist);
    const { entry: duplicate } = resolveDuplicate(duplicateIndex, trackPayload);
    if (duplicate) {
      res.status(200).json({ ok: true, playlist, track: duplicate, duplicate: true });
      return;
    }

    const addedAt = new Date().toISOString();
    const entry = buildTrackEntry(trackPayload, addedAt);

    playlist.tracks.push(entry);
    playlist.updatedAt = addedAt;

    playlists[index] = playlist;
    await savePlaylists(playlists);

    res.status(201).json({ ok: true, playlist, track: entry });
  } catch (err) {
    console.error('[MASS] Add track to playlist failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to add track' });
  }
});

app.post('/api/playlists/:playlistId/tracks/bulk', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email = user.email;
    const playlistId = req.params?.playlistId;
    if (!playlistId) {
      res.status(400).json({ ok: false, error: 'Playlist ID required' });
      return;
    }

    const rawTracks = Array.isArray(req.body?.tracks) ? req.body.tracks : [];
    if (!rawTracks.length) {
      res.status(400).json({ ok: false, error: 'At least one track required' });
      return;
    }

    const normalizedTracks = rawTracks.map((track) => normalizeTrackPayload(track || {}));
    const playlists = await loadPlaylists();
    const index = playlists.findIndex((p) => p && p.id === playlistId && playlistOwnerMatches(p.userId, email));
    if (index === -1) {
      res.status(404).json({ ok: false, error: 'Playlist not found' });
      return;
    }

    const playlist = playlists[index];
    playlist.tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];

    const duplicateIndex = buildPlaylistDuplicateIndex(playlist);

    const addedEntries = [];
    const duplicates = [];
    const skipped = [];
    const timestampBase = Date.now();

    for (const trackPayload of normalizedTracks) {
      if (!trackPayload.name) {
        skipped.push({ ...summarizeTrackPayload(trackPayload), reason: 'invalid_name' });
        continue;
      }

      const { key, entry: duplicate } = resolveDuplicate(duplicateIndex, trackPayload);
      if (duplicate) {
        duplicates.push({ ...summarizeTrackPayload(trackPayload), reason: 'already_exists' });
        continue;
      }

      const addedAt = new Date(timestampBase + addedEntries.length).toISOString();
      const entry = buildTrackEntry(trackPayload, addedAt);
      playlist.tracks.push(entry);
      addedEntries.push(entry);
      if (key) duplicateIndex.set(key, entry);
    }

    if (addedEntries.length) {
      playlist.updatedAt = addedEntries[addedEntries.length - 1].addedAt;
      playlists[index] = playlist;
      await savePlaylists(playlists);
    }

    const status = addedEntries.length ? 201 : 200;
    res.status(status).json({
      ok: true,
      playlist,
      addedCount: addedEntries.length,
      duplicateCount: duplicates.length,
      skippedCount: skipped.length,
      added: addedEntries,
      duplicates,
      skipped
    });
  } catch (err) {
    console.error('[MASS] Bulk add tracks to playlist failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to add tracks' });
  }
});

app.post('/api/playlists/:playlistId/share', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  let playlist = null;
  let shareId = '';

  try {
    const email = user.email;
    const playlistId = req.params?.playlistId;
    if (!playlistId) {
      res.status(400).json({ ok: false, error: 'Playlist ID required' });
      return;
    }

    const playlists = await loadPlaylists();
    const index = playlists.findIndex((p) => p && p.id === playlistId && playlistOwnerMatches(p.userId, email));
    if (index === -1) {
      res.status(404).json({ ok: false, error: 'Playlist not found' });
      return;
    }

    playlist = playlists[index];
    const tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
    if (!tracks.length) {
      res.status(400).json({ ok: false, error: 'Add at least one track before sharing a playlist' });
      return;
    }

    const regenerate = req.body?.regenerate === true;
    const existingIds = new Set();
    playlists.forEach((entry, idx) => {
      if (!entry || idx === index) return;
      const existing = normalizeShareId(entry.shareId);
      if (existing) existingIds.add(existing);
    });

    shareId = normalizeShareId(playlist.shareId);
    const needsNewId = regenerate || !shareId || existingIds.has(shareId);
    if (needsNewId) {
      let candidate = '';
      let attempts = 0;
      do {
        candidate = generateShareId();
        attempts += 1;
      } while (existingIds.has(candidate) && attempts < 50);
      if (existingIds.has(candidate)) {
        res.status(500).json({ ok: false, error: 'Unable to generate a unique share link' });
        return;
      }
      shareId = candidate;
      playlist.shareId = shareId;
      playlist.sharedAt = new Date().toISOString();
    } else if (!playlist.sharedAt) {
      playlist.sharedAt = new Date().toISOString();
    }

    playlists[index] = playlist;
    await savePlaylists(playlists);

    const payload = sanitizePlaylistForShare(playlist);
    const shareUrl = buildShareUrl(req, shareId);

    res.json({ ok: true, shareId, shareUrl, playlist: payload });
  } catch (err) {
    console.error('[MASS] Generate playlist share link failed:', err);
    const detail = err?.message || err?.code || String(err);
    const fallbackId = normalizeShareId(shareId || playlist?.shareId);
    if (fallbackId && playlist) {
      try {
        const payload = sanitizePlaylistForShare(playlist);
        const shareUrl = buildShareUrl(req, fallbackId);
        res.json({ ok: true, shareId: fallbackId, shareUrl, playlist: payload, reused: true, error: 'Existing share link reused' });
        return;
      } catch (fallbackErr) {
        console.error('[MASS] Fallback share link serialization failed:', fallbackErr);
      }
    }
    res.status(500).json({ ok: false, error: 'Unable to generate share link', detail });
  }
});

// Secret endpoint: Publish playlist to FileMaker (set PublicPlaylist field on tracks)
app.post('/api/playlists/:playlistId/publish-to-filemaker', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email = user.email;
    const playlistId = req.params?.playlistId;

    if (!playlistId) {
      return res.status(400).json({ ok: false, error: 'Playlist ID required' });
    }

    const playlists = await loadPlaylists();
    const playlist = playlists.find((p) => p && p.id === playlistId && playlistOwnerMatches(p.userId, email));

    if (!playlist) {
      return res.status(404).json({ ok: false, error: 'Playlist not found' });
    }

    if (!playlist.tracks || playlist.tracks.length === 0) {
      return res.status(400).json({ ok: false, error: 'Playlist has no tracks' });
    }

    const playlistName = playlist.name || 'Unnamed Playlist';
    console.log(`[MASS] Publishing playlist "${playlistName}" (${playlist.tracks.length} tracks) to FileMaker`);

    // Update each track's PublicPlaylist field in FileMaker
    const results = [];
    for (const track of playlist.tracks) {
      const recId = track['song files:recid'] || track.recordId || track.trackRecordId;
      if (!recId) {
        results.push({ track: track.name || 'Unknown', success: false, error: 'No record ID found' });
        continue;
      }

      try {
        await fmUpdateRecord(FM_LAYOUT, recId, {
          'PublicPlaylist': playlistName
        });
        results.push({ track: track.name || 'Unknown', recordId: recId, success: true });
        console.log(`[MASS] ✓ Updated track "${track.name}" (${recId}) with PublicPlaylist="${playlistName}"`);
      } catch (err) {
        const errMsg = err?.message || String(err);
        results.push({ track: track.name || 'Unknown', recordId: recId, success: false, error: errMsg });
        console.error(`[MASS] ✗ Failed to update track "${track.name}" (${recId}):`, errMsg);
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    console.log(`[MASS] Publish complete: ${successCount} succeeded, ${failCount} failed`);

    res.json({
      ok: true,
      message: 'Playlist published to FileMaker',
      playlistName,
      totalTracks: playlist.tracks.length,
      successCount,
      failCount,
      results
    });
  } catch (err) {
    console.error('[MASS] Publish playlist to FileMaker failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to publish playlist', detail: err?.message || String(err) });
  }
});

// Export playlist as compact code
app.get('/api/playlists/:playlistId/export', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email = user.email;
    const playlistId = req.params?.playlistId;

    if (!playlistId) {
      return res.status(400).json({ ok: false, error: 'Playlist ID required' });
    }

    const playlists = await loadPlaylists();
    const playlist = playlists.find((p) => p && p.id === playlistId && playlistOwnerMatches(p.userId, email));

    if (!playlist) {
      return res.status(404).json({ ok: false, error: 'Playlist not found' });
    }

    const tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
    if (!tracks.length) {
      return res.status(400).json({ ok: false, error: 'Playlist is empty' });
    }

    // Extract track IDs
    const trackIds = tracks.map(t => t.trackRecordId).filter(Boolean);
    console.log(`[MASS] Export: Extracted ${trackIds.length} track IDs from playlist "${playlist.name}"`);
    console.log(`[MASS] Export: Sample IDs:`, trackIds.slice(0, 3));

    // Create export data
    const exportData = {
      name: playlist.name,
      tracks: trackIds,
      exported: new Date().toISOString()
    };

    // Generate compact code (MASS:base64json)
    const jsonStr = JSON.stringify(exportData);
    const base64 = Buffer.from(jsonStr, 'utf-8').toString('base64');
    const compactCode = `MASS:${base64}`;
    console.log(`[MASS] Export: Generated code of length ${compactCode.length}`);

    res.json({
      ok: true,
      code: compactCode,
      json: exportData,
      trackCount: trackIds.length
    });
  } catch (err) {
    console.error('[MASS] Export playlist failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to export playlist', detail: err?.message });
  }
});

// Import playlist from compact code or track IDs
app.post('/api/playlists/import', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email = user.email;
    const { name, code, trackIds } = req.body;

    let playlistName = '';
    let importedTrackIds = [];

    // Parse compact code (MASS:base64json) or direct track IDs
    if (code && typeof code === 'string') {
      const trimmed = code.trim();

      // Check for MASS: prefix
      if (trimmed.startsWith('MASS:')) {
        const base64Part = trimmed.substring(5);
        try {
          const jsonStr = Buffer.from(base64Part, 'base64').toString('utf-8');
          const data = JSON.parse(jsonStr);
          playlistName = data.name || 'Imported Playlist';
          importedTrackIds = Array.isArray(data.tracks) ? data.tracks : [];
        } catch (parseErr) {
          return res.status(400).json({ ok: false, error: 'Invalid import code format' });
        }
      } else {
        // Try parsing as plain JSON
        try {
          const data = JSON.parse(trimmed);
          playlistName = data.name || 'Imported Playlist';
          importedTrackIds = Array.isArray(data.tracks) ? data.tracks : [];
        } catch {
          return res.status(400).json({ ok: false, error: 'Invalid import code format' });
        }
      }
    } else if (Array.isArray(trackIds)) {
      // Direct track IDs provided
      importedTrackIds = trackIds;
      playlistName = typeof name === 'string' && name.trim() ? name.trim() : 'Imported Playlist';
    } else {
      return res.status(400).json({ ok: false, error: 'Provide either code or trackIds' });
    }

    if (!importedTrackIds.length) {
      return res.status(400).json({ ok: false, error: 'No tracks found in import data' });
    }

    // Validate track IDs exist in FileMaker (fetch minimal data)
    console.log(`[MASS] Import: Validating ${importedTrackIds.length} track IDs`);
    const validTrackIds = [];
    const failedIds = [];
    for (const trackId of importedTrackIds.slice(0, 100)) { // Limit to 100 tracks
      try {
        const record = await fmGetRecordById(FM_LAYOUT, trackId);
        if (record) {
          console.log(`[MASS] Import: ✓ Found track ID: ${trackId}`);
          validTrackIds.push(trackId);
        } else {
          console.log(`[MASS] Import: ✗ Track ID not found: ${trackId}`);
          failedIds.push(trackId);
        }
      } catch (err) {
        console.error(`[MASS] Import: ✗ Error fetching track ${trackId}:`, err.message);
        failedIds.push(trackId);
      }
    }

    console.log(`[MASS] Import: Valid IDs: ${validTrackIds.length}, Failed IDs: ${failedIds.length}`);
    if (failedIds.length > 0) {
      console.log(`[MASS] Import: Failed ID samples:`, failedIds.slice(0, 5));
    }

    if (!validTrackIds.length) {
      return res.status(400).json({
        ok: false,
        error: 'None of the imported tracks were found',
        detail: `Tried ${importedTrackIds.length} track IDs, none found in FileMaker`
      });
    }

    // Create new playlist
    const now = new Date().toISOString();
    const playlists = await loadPlaylists();
    const newPlaylist = {
      id: randomUUID(),
      userId: email,
      name: playlistName,
      tracks: [], // Will be populated below
      createdAt: now,
      updatedAt: now
    };

    // Fetch full track data for valid IDs
    for (const trackId of validTrackIds) {
      try {
        const record = await fmGetRecordById(FM_LAYOUT, trackId);

        if (record) {
          const fields = record.fieldData || {};

          // Build track object
          const trackObj = {
            trackRecordId: trackId,
            name: fields['Track Name'] || fields['Tape Files::Track Name'] || 'Unknown Track',
            albumTitle: fields['Album'] || fields['Tape Files::Album'] || '',
            albumArtist: fields['Album Artist'] || fields['Artist'] || fields['Tape Files::Album Artist'] || '',
            trackArtist: fields['Track Artist'] || fields['Album Artist'] || '',
            catalogue: fields['Catalogue #'] || fields['Catalogue'] || '',
            addedAt: now
          };

          // Find audio and artwork fields
          const audioField = AUDIO_FIELD_CANDIDATES.find(f => fields[f]);
          const artworkField = ARTWORK_FIELD_CANDIDATES.find(f => fields[f]);

          if (audioField) {
            trackObj.mp3 = fields[audioField];
            trackObj.audioField = audioField;
          }
          if (artworkField) {
            trackObj.artwork = fields[artworkField];
            trackObj.artworkField = artworkField;
          }

          newPlaylist.tracks.push(trackObj);
        }
      } catch (err) {
        console.error(`[MASS] Failed to fetch track ${trackId}:`, err);
      }
    }

    playlists.push(newPlaylist);
    await savePlaylists(playlists);

    res.json({
      ok: true,
      playlist: newPlaylist,
      imported: newPlaylist.tracks.length,
      skipped: importedTrackIds.length - newPlaylist.tracks.length
    });
  } catch (err) {
    console.error('[MASS] Import playlist failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to import playlist', detail: err?.message });
  }
});

app.get('/api/shared-playlists/:shareId', async (req, res) => {
  try {
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

app.delete('/api/playlists/:playlistId/tracks/:addedAt', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email = user.email;
    const playlistId = req.params?.playlistId;
    const addedAt = req.params?.addedAt;

    if (!playlistId) {
      res.status(400).json({ ok: false, error: 'Playlist ID required' });
      return;
    }
    if (!addedAt) {
      res.status(400).json({ ok: false, error: 'Track addedAt timestamp required' });
      return;
    }

    const playlists = await loadPlaylists();
    const playlistIndex = playlists.findIndex((p) => p && p.id === playlistId && playlistOwnerMatches(p.userId, email));
    if (playlistIndex === -1) {
      res.status(404).json({ ok: false, error: 'Playlist not found' });
      return;
    }

    const playlist = playlists[playlistIndex];
    playlist.tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];

    const trackIndex = playlist.tracks.findIndex((t) => t && t.addedAt === addedAt);
    if (trackIndex === -1) {
      res.status(404).json({ ok: false, error: 'Track not found in playlist' });
      return;
    }

    const [deletedTrack] = playlist.tracks.splice(trackIndex, 1);
    playlist.updatedAt = new Date().toISOString();

    playlists[playlistIndex] = playlist;
    await savePlaylists(playlists);

    res.json({ ok: true, playlist, track: deletedTrack });
  } catch (err) {
    console.error('[MASS] Delete track from playlist failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to delete track from playlist' });
  }
});

app.delete('/api/playlists/:playlistId', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;

  try {
    const email = user.email;
    const playlistId = req.params?.playlistId;
    if (!playlistId) {
      res.status(400).json({ ok: false, error: 'Playlist ID required' });
      return;
    }

    const playlists = await loadPlaylists();
    const index = playlists.findIndex((p) => p && p.id === playlistId && playlistOwnerMatches(p.userId, email));
    if (index === -1) {
      res.status(404).json({ ok: false, error: 'Playlist not found' });
      return;
    }

    const [deleted] = playlists.splice(index, 1);
    await savePlaylists(playlists);

    res.json({ ok: true, playlist: deleted || null });
  } catch (err) {
    console.error('[MASS] Delete playlist failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to delete playlist' });
  }
});

app.get('/api/track/:recordId/container', async (req, res) => {
  try {
    const recordId = (req.params?.recordId || '').toString().trim();
    if (!recordId) {
      res.status(400).json({ ok: false, error: 'Record ID required' });
      return;
    }

    const layout = (req.query?.layout || FM_LAYOUT || '').toString().trim() || FM_LAYOUT;
    const requestedField = (req.query?.field || '').toString().trim();
    const candidateParam = (req.query?.candidates || '').toString().trim();
    const candidates = candidateParam
      ? candidateParam.split(',').map((value) => value.trim()).filter(Boolean)
      : [];

    const record = await fmGetRecordById(layout, recordId);
    if (!record) {
      res.status(404).json({ ok: false, error: 'Record not found' });
      return;
    }

    const fieldData = record.fieldData || {};

    const getFieldValue = (fieldName) => {
      if (!fieldName) return '';
      if (!Object.prototype.hasOwnProperty.call(fieldData, fieldName)) return '';
      const raw = fieldData[fieldName];
      if (raw === undefined || raw === null) return '';
      const str = typeof raw === 'string' ? raw.trim() : String(raw).trim();
      return str;
    };

    let chosenField = requestedField;
    let containerUrl = getFieldValue(chosenField);

    const tryCandidates = (list) => {
      for (const candidate of list) {
        const value = getFieldValue(candidate);
        if (value) {
          chosenField = candidate;
          containerUrl = value;
          return true;
        }
      }
      return false;
    };

    if (!containerUrl && candidates.length) {
      tryCandidates(candidates);
    }

    if (!containerUrl) {
      tryCandidates(DEFAULT_AUDIO_FIELDS);
    }

    if (!containerUrl) {
      res.status(404).json({ ok: false, error: 'Container data not found' });
      return;
    }

    res.json({ ok: true, url: containerUrl, field: chosenField || requestedField || '' });
  } catch (err) {
    console.error('[MASS] Container refresh failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to refresh container' });
  }
});

/* ========= Cache statistics ========= */
app.get('/api/cache/stats', (req, res) => {
  try {
    const stats = {
      search: searchCache.getStats(),
      explore: exploreCache.getStats(),
      album: albumCache.getStats(),
      publicPlaylists: publicPlaylistsCache.getStats(),
      timestamp: new Date().toISOString()
    };
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve cache stats' });
  }
});

/* ========= Static site ========= */
// Note: express.static() moved to top of file (line ~206) for better performance
// Static files now bypass rate limiting and API middleware
// Default to Modern view (MADMusic)
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'mad.html')));
// Classic jukebox view available at /jukebox and /classic
app.get('/jukebox', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/classic', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
// Modern view (MADMusic) available at /modern
app.get('/modern', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'modern-view.html')));
// Mobile-optimized view
app.get('/mobile', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'mobile.html')));
app.get('/m', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'mobile.html')));
// MAD (Music Africa Direct) new design
app.get('/mad', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'mad.html')));

/* ========= Search ========= */
const SEARCH_FIELDS_BASE = ['Album Artist', 'Album Title', 'Track Name'];
const SEARCH_FIELDS_OPTIONAL = [
  'Year of Release',
  'Local Genre',
  'Language Code',
  'Track Artist',
  'Genre'
];
const SEARCH_FIELDS_DEFAULT = [...SEARCH_FIELDS_BASE, ...SEARCH_FIELDS_OPTIONAL];

const ARTIST_FIELDS_BASE = ['Album Artist'];
const ARTIST_FIELDS_OPTIONAL = ['Track Artist'];
const ALBUM_FIELDS_BASE = ['Album Title'];
const ALBUM_FIELDS_OPTIONAL = [];
const TRACK_FIELDS_BASE = ['Track Name'];
const TRACK_FIELDS_OPTIONAL = [];

const TARGET_ARTIST_FIELDS = ['Track Artist'];
const TARGET_ALBUM_FIELDS = ['Album Title'];
const TARGET_TRACK_FIELDS = ['Track Name'];

const parseFieldList = (envKey, fallback) => {
  const raw = (process.env[envKey] || '').trim();
  if (!raw) return fallback;
  const parts = raw.split(/[,\|]/).map((value) => value.trim()).filter(Boolean);
  return parts.length ? parts : fallback;
};

const AI_GENRE_FIELDS = parseFieldList('FM_GENRE_FIELDS', ['Local Genre', 'Genre']);
const SEARCH_GENRE_FIELDS = ['Local Genre'];
const AI_LANGUAGE_FIELDS = parseFieldList('FM_LANGUAGE_FIELDS', ['Language Code']);

const listSearchFields = (base, optional, includeOptional) =>
  includeOptional ? [...base, ...optional] : base;

function buildSearchQueries({ q, artist, album, track }, includeOptionalFields, fieldOverrides = {}) {
  const queries = [];

  const extend = (arr, make) => {
    const out = [];
    for (const base of arr) {
      const vs = make(base);
      if (Array.isArray(vs)) out.push(...vs);
      else out.push(vs);
    }
    return out;
  };

  let combos = [{}];
  const artistFields = Array.isArray(fieldOverrides.artist) && fieldOverrides.artist.length
    ? fieldOverrides.artist
    : listSearchFields(ARTIST_FIELDS_BASE, ARTIST_FIELDS_OPTIONAL, includeOptionalFields);
  const albumFields = Array.isArray(fieldOverrides.album) && fieldOverrides.album.length
    ? fieldOverrides.album
    : listSearchFields(ALBUM_FIELDS_BASE, ALBUM_FIELDS_OPTIONAL, includeOptionalFields);
  const trackFields = Array.isArray(fieldOverrides.track) && fieldOverrides.track.length
    ? fieldOverrides.track
    : listSearchFields(TRACK_FIELDS_BASE, TRACK_FIELDS_OPTIONAL, includeOptionalFields);

  if (artist) {
    combos = extend(combos, (b) =>
      artistFields.map((field) => ({
        ...b,
        [field]: begins(artist)
      }))
    );
  }
  if (album) {
    combos = extend(combos, (b) =>
      albumFields.map((field) => ({
        ...b,
        [field]: begins(album)
      }))
    );
  }
  if (track) {
    combos = extend(combos, (b) =>
      trackFields.map((field) => ({
        ...b,
        [field]: begins(track)
      }))
    );
  }

  if (artist || album || track) {
    return combos;
  }

  if (q) {
    const fields = includeOptionalFields ? SEARCH_FIELDS_DEFAULT : SEARCH_FIELDS_BASE;
    return fields.map((field) => ({ [field]: begins(q) }));
  }

  return [{ 'Album Title': '*' }];
}

const begins = (s) => (s ? `${s}*` : '');
const contains = (s) => (s ? `*${s}*` : '');

function normalizeAiValue(value) {
  if (value === undefined || value === null) return '';
  const str = String(value).trim();
  if (!str || str.toLowerCase() === 'null') return '';
  return str;
}

function prepareAiSearchPayload(rawCriteria = {}, userQuery = '') {
  const normalized = {
    artist: normalizeAiValue(rawCriteria.artist),
    album: normalizeAiValue(rawCriteria.album),
    track: normalizeAiValue(rawCriteria.track),
    genre: normalizeAiValue(rawCriteria.genre),
    year: normalizeAiValue(rawCriteria.year),
    language: normalizeAiValue(rawCriteria.language),
    keywords: normalizeAiValue(rawCriteria.keywords || rawCriteria.q || rawCriteria.text || rawCriteria.description)
  };

  const fallbackQuery = normalizeAiValue(userQuery);
  const queryText = normalized.keywords || fallbackQuery;
  normalized.queryText = queryText;
  normalized.usedFallbackQuery = !normalized.keywords && Boolean(queryText);

  const shouldUseGeneral = !normalized.artist && !normalized.album && !normalized.track;
  // If we have extracted criteria (genre/year/language), don't use queryText in base search
  // This prevents "1960 jazz" from searching for titles containing "1960 jazz"
  // Instead, we'll just filter by the extracted criteria
  const hasExtractedCriteria = normalized.genre || normalized.year || normalized.language;
  const useQueryText = shouldUseGeneral && !hasExtractedCriteria;

  const baseQueries = buildSearchQueries({
    artist: normalized.artist,
    album: normalized.album,
    track: normalized.track,
    q: useQueryText ? queryText : ''
  }, true);

  let finalQueries = baseQueries.length ? baseQueries : [{ 'Album Title': '*' }];

  if (normalized.genre && AI_GENRE_FIELDS.length) {
    const genreQueries = [];
    finalQueries.forEach((q) => {
      AI_GENRE_FIELDS.forEach((field) => {
        genreQueries.push({ ...q, [field]: `*${normalized.genre}*` });
      });
    });
    finalQueries = genreQueries;
  }

  if (normalized.year) {
    finalQueries = finalQueries.map((q) => ({ ...q, 'Year of Release': normalized.year }));
  }

  if (normalized.language && AI_LANGUAGE_FIELDS.length) {
    finalQueries = finalQueries.map((q) => {
      const base = { ...q };
      AI_LANGUAGE_FIELDS.forEach((field) => {
        base[field] = `*${normalized.language}*`;
      });
      return base;
    });
  }

  if (!finalQueries.length) {
    finalQueries = [{ 'Album Title': '*' }];
  }

  return { normalizedCriteria: normalized, finalQueries };
}

async function buildAiResponseFromCriteria(rawCriteria, userQuery, logLabel = '') {
  let payloadInfo = prepareAiSearchPayload(rawCriteria, userQuery);
  console.log(`[AI SEARCH] Structured criteria${logLabel}:`, payloadInfo.normalizedCriteria);
  console.log(`[AI SEARCH] FileMaker queries${logLabel}:`, JSON.stringify(payloadInfo.finalQueries, null, 2));

  let findPayload = {
    query: payloadInfo.finalQueries,
    limit: 100
  };

  let findResponse = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, findPayload);
  let findJson = await findResponse.json().catch(() => ({}));

  const maybeRetryWithoutOptionalFields = async () => {
    const code = findJson?.messages?.[0]?.code;
    const codeStr = code === undefined || code === null ? '' : String(code);
    if (codeStr === '102' && (payloadInfo.normalizedCriteria.genre || payloadInfo.normalizedCriteria.language)) {
      const sanitizedCriteria = {
        ...rawCriteria,
        genre: '',
        language: ''
      };
      payloadInfo = prepareAiSearchPayload(sanitizedCriteria, userQuery);
      console.warn('[AI SEARCH] Retrying without genre/language filters due to missing field (102)');
      findPayload = {
        query: payloadInfo.finalQueries,
        limit: 100
      };
      findResponse = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, findPayload);
      findJson = await findResponse.json().catch(() => ({}));
    }
  };

  const maybeFallbackToGeneralSearch = async () => {
    const code = findJson?.messages?.[0]?.code;
    const codeStr = code === undefined || code === null ? '' : String(code);
    if (codeStr !== '102') return false;
    const fallbackText = payloadInfo.normalizedCriteria.queryText || userQuery || '';
    if (!fallbackText) return false;
    console.warn('[AI SEARCH] Retrying with general text search due to missing field (102)');
    const fallbackQuery = buildSearchQueries({ q: fallbackText, artist: '', album: '', track: '' }, false);
    const fallbackPayload = {
      query: fallbackQuery,
      limit: 100,
      offset: 1
    };
    findResponse = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, fallbackPayload);
    findJson = await findResponse.json().catch(() => ({}));
    payloadInfo.normalizedCriteria = {
      ...payloadInfo.normalizedCriteria,
      fallbackMode: 'text',
      genre: '',
      language: ''
    };
    return findResponse.ok;
  };

  await maybeRetryWithoutOptionalFields();
  if (!findResponse.ok) {
    const fallbackWorked = await maybeFallbackToGeneralSearch();
    if (!fallbackWorked) {
      const msg = findJson?.messages?.[0]?.message || 'Find failed';
      const code = findJson?.messages?.[0]?.code;
      return {
        error: {
          status: 500,
          body: {
            error: 'FileMaker find failed',
            detail: `${msg} (${code})`,
            criteria: payloadInfo.normalizedCriteria
          }
        }
      };
    }
  }

  const rawData = findJson?.response?.data || [];
  const validRecords = rawData.filter((record) => {
    const fields = record.fieldData || {};
    return hasValidAudio(fields) && hasValidArtwork(fields);
  });

  return {
    payload: {
      items: validRecords.map((d) => ({
        recordId: d.recordId,
        modId: d.modId,
        fields: d.fieldData || {}
      })),
      total: findJson?.response?.dataInfo?.foundCount || validRecords.length,
      aiInterpretation: payloadInfo.normalizedCriteria,
      query: userQuery
    }
  };
}

/* ========= Wake/Health endpoint ========= */
app.get('/api/wake', async (req, res) => {
  try {
    // Warm up the FileMaker connection by ensuring token is valid
    await ensureToken();
    res.json({
      status: 'ok',
      timestamp: Date.now(),
      tokenValid: !!fmToken
    });
  } catch (err) {
    console.error('[MASS] Wake endpoint error:', err);
    res.status(500).json({
      status: 'error',
      error: err.message
    });
  }
});

// Update the version to bust cached search responses when the shape changes
const SEARCH_CACHE_VERSION = 'genre-one-per-album-v1';

app.get('/api/search', async (req, res) => {
  try {
    // Validate search inputs (prevent injection)
    const validationErrors = {};
    if (req.query.q && req.query.q !== '') {
      const qResult = validators.searchQuery(req.query.q);
      if (!qResult.valid) validationErrors.q = qResult.error;
    }
    if (req.query.artist && req.query.artist !== '') {
      const artistResult = validators.searchQuery(req.query.artist);
      if (!artistResult.valid) validationErrors.artist = artistResult.error;
    }
    if (req.query.album && req.query.album !== '') {
      const albumResult = validators.searchQuery(req.query.album);
      if (!albumResult.valid) validationErrors.album = albumResult.error;
    }
    if (req.query.track && req.query.track !== '') {
      const trackResult = validators.searchQuery(req.query.track);
      if (!trackResult.valid) validationErrors.track = trackResult.error;
    }
    if (req.query.limit) {
      const limitResult = validators.limit(req.query.limit, 500);
      if (!limitResult.valid) validationErrors.limit = limitResult.error;
    }
    if (req.query.offset) {
      const offsetResult = validators.offset(req.query.offset);
      if (!offsetResult.valid) validationErrors.offset = offsetResult.error;
    }
    const q = (req.query.q || '').toString().trim();
    const artist = (req.query.artist || '').toString().trim();
    const album = (req.query.album || '').toString().trim();
    const track = (req.query.track || '').toString().trim();
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '10', 10)));
    const uiOff0 = Math.max(0, parseInt(req.query.offset || '0', 10));
    const fmOff = uiOff0 + 1;

    const rawGenreInput = req.query.genre;
    const genreFragments = [];
    if (Array.isArray(rawGenreInput)) {
      rawGenreInput.forEach((value) => {
        if (value === undefined || value === null) return;
        String(value)
          .split(/[,\|]/)
          .map((part) => part.trim())
          .filter(Boolean)
          .forEach((part) => genreFragments.push(part));
      });
    } else if (rawGenreInput !== undefined && rawGenreInput !== null) {
      String(rawGenreInput)
        .split(/[,\|]/)
        .map((part) => part.trim())
        .filter(Boolean)
        .forEach((part) => genreFragments.push(part));
    }

    const MAX_GENRE_FILTERS = 5;
    const genreFilters = [];
    const normalizedGenreKeys = new Set();
    for (const fragment of genreFragments) {
      if (genreFilters.length >= MAX_GENRE_FILTERS) break;
      const validation = validators.searchQuery(fragment);
      if (!validation.valid) {
        validationErrors.genre = validation.error;
        break;
      }
      const normalizedKey = validation.value.toLowerCase();
      if (normalizedGenreKeys.has(normalizedKey)) continue;
      normalizedGenreKeys.add(normalizedKey);
      genreFilters.push(validation.value);
    }

    // Parse decade parameter (e.g., "1980s" -> start=1980, end=1989)
    const decadeParam = (req.query.decade || '').toString().trim();
    let decadeStart = null;
    let decadeEnd = null;
    if (decadeParam) {
      const decadeMatch = decadeParam.match(/^(\d{4})s?$/i);
      if (decadeMatch) {
        decadeStart = parseInt(decadeMatch[1], 10);
        decadeEnd = decadeStart + 9;
        console.log('[SEARCH] Decade filter:', decadeParam, '-> years', decadeStart, '-', decadeEnd);
      }
    }

    if (Object.keys(validationErrors).length > 0) {
      return res.status(400).json({ error: 'Invalid input', details: validationErrors });
    }

    const genreCacheKey = genreFilters.length
      ? genreFilters.map((g) => g.toLowerCase()).sort().join('|')
      : '';

    const decadeCacheKey = decadeStart ? `${decadeStart}-${decadeEnd}` : '';

    if (genreFilters.length) {
      console.log('[SEARCH] Genre filters:', genreFilters.join(', '));
    }

    // Check cache
    const cacheKey = `search:${SEARCH_CACHE_VERSION}:${q}:${artist}:${album}:${track}:${limit}:${uiOff0}:${genreCacheKey}:${decadeCacheKey}`;
    const cached = searchCache.get(cacheKey);
    if (cached) {
      console.log(`[CACHE HIT] search (1-hour cache) - returning cached results instantly`);
      res.setHeader('X-Cache-Hit', 'true');
      return res.json(cached);
    }

    console.log(`[CACHE MISS] search - querying FileMaker (will be cached for 1 hour)...`);

    const applyGenreFiltersToQueries = (queries, candidateFields = SEARCH_GENRE_FIELDS) => {
      if (!genreFilters.length) return queries;
      const fields = Array.isArray(candidateFields) ? candidateFields.filter(Boolean) : [];
      if (!fields.length) return queries;
      const augmented = [];
      for (const baseQuery of queries) {
        for (const genreValue of genreFilters) {
          // Use exact match (==value) for accurate genre filtering
          // This ensures "Afro Beat" doesn't match "Afro-Folk", "Afro Fusion", etc.
          const pattern = `==${genreValue}`;
          fields.forEach((field) => {
            augmented.push({
              ...baseQuery,
              [field]: pattern
            });
          });
        }
      }
      return augmented.length ? augmented : queries;
    };

    // Use the cached year field from explore endpoint, or default to the most common one
    // This avoids the 102 "field missing" error by using a known-good field name
    const decadeYearField = yearFieldCache || 'Year of Release';

    const applyDecadeFiltersToQueries = (queries) => {
      if (!decadeStart || !decadeEnd) return queries;
      // FileMaker range query syntax: start...end
      const pattern = `${decadeStart}...${decadeEnd}`;
      // Apply the year filter to each query using the single known-good field
      return queries.map((baseQuery) => ({
        ...baseQuery,
        [decadeYearField]: pattern
      }));
    };

    const makePayload = (
      includeOptionalFields,
      overrides,
      genreFields = SEARCH_GENRE_FIELDS,
      customOffset,
      customLimit
    ) => {
      const baseQueries = buildSearchQueries({ q, artist, album, track }, includeOptionalFields, overrides);
      const queryWithGenres = applyGenreFiltersToQueries(baseQueries, genreFields);
      const queryWithDecade = applyDecadeFiltersToQueries(queryWithGenres);
      return {
        query: queryWithDecade,
        limit: typeof customLimit === 'number' ? customLimit : limit,
        offset: typeof customOffset === 'number' ? customOffset : fmOff
      };
    };

    const runSearch = async (includeOptionalFields, overrides, customOffset, customLimit) => {
      const genreFieldCandidates = SEARCH_GENRE_FIELDS.filter(Boolean);
      let activeGenreFields = genreFieldCandidates.slice();

      while (true) {
        const payload = makePayload(
          includeOptionalFields,
          overrides,
          activeGenreFields,
          customOffset,
          customLimit
        );
        const response = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, payload);
        const json = await response.json().catch(() => ({}));

        if (!genreFilters.length) {
          return { response, json };
        }

        const code = json?.messages?.[0]?.code;
        const codeStr = code === undefined || code === null ? '' : String(code);

        if (codeStr === '102' && activeGenreFields.length > 1) {
          const removedField = activeGenreFields.pop();
          console.warn(`[SEARCH] Genre field "${removedField}" missing (102); retrying with remaining fields`);
          continue;
        }

        return { response, json };
      }
    };

    const hasOnlyArtist = Boolean(artist) && !album && !track && !q;
    const hasOnlyAlbum = Boolean(album) && !artist && !track && !q;
    const hasOnlyTrack = Boolean(track) && !artist && !album && !q;

    const targetedOverrides = {};
    if (hasOnlyArtist) targetedOverrides.artist = TARGET_ARTIST_FIELDS;
    if (hasOnlyAlbum) targetedOverrides.album = TARGET_ALBUM_FIELDS;
    if (hasOnlyTrack) targetedOverrides.track = TARGET_TRACK_FIELDS;

    const usingTargetedOverrides = Object.keys(targetedOverrides).length > 0;

    let attemptUsedOptional = !usingTargetedOverrides;
    const fmQueryLimit = Math.min(500, Math.max(limit * 10, 50));
    const MAX_GENRE_FETCH_BATCHES = Math.max(1, parsePositiveInt(process.env.SEARCH_GENRE_MAX_BATCHES, 20));

    let attempt = await runSearch(
      attemptUsedOptional,
      usingTargetedOverrides ? targetedOverrides : undefined,
      undefined,
      fmQueryLimit
    );

    if (!attempt.response.ok) {
      const code = attempt.json?.messages?.[0]?.code;
      if (String(code) === '102' && attemptUsedOptional) {
        attemptUsedOptional = false;
        attempt = await runSearch(false, undefined, undefined, fmQueryLimit);
      }
    }

    if (!attempt.response.ok) {
      const msg = attempt.json?.messages?.[0]?.message || 'FM error';
      const code = attempt.json?.messages?.[0]?.code;
      const httpStatus = fmErrorToHttpStatus(code, attempt.response.status);
      return res
        .status(httpStatus)
        .json({ error: 'Album search failed', status: httpStatus, detail: `${msg} (FM ${code})` });
    }

    if (
      usingTargetedOverrides &&
      attempt.response.ok &&
      (attempt.json?.response?.dataInfo?.returnedCount ?? attempt.json?.response?.data?.length ?? 0) === 0
    ) {
      attemptUsedOptional = true;
      attempt = await runSearch(true, undefined, undefined, fmQueryLimit);
    }

    let aggregatedRawData = Array.isArray(attempt.json?.response?.data)
      ? attempt.json.response.data.slice()
      : [];
    let aggregatedRawCount = aggregatedRawData.length;
    const initialFoundCount = Number(attempt.json?.response?.dataInfo?.foundCount);
    let rawTotal = Number.isFinite(initialFoundCount) ? initialFoundCount : null;

    const filterValidRecords = () => {
      const visible = aggregatedRawData.filter(r => recordIsVisible(r.fieldData || {}));
      const withAudio = visible.filter(r => hasValidAudio(r.fieldData || {}));
      const withArtwork = withAudio.filter(r => hasValidArtwork(r.fieldData || {}));

      console.log(`[SEARCH] Filtering: ${aggregatedRawData.length} total → ${visible.length} visible → ${withAudio.length} with audio → ${withArtwork.length} with artwork`);

      return withArtwork;
    };
    const dedupeByAlbum = (records) => {
      const seenAlbums = new Set();
      const deduped = [];
      for (const record of records) {
        const fields = record.fieldData || {};
        const catalogue = firstNonEmptyFast(fields, CATALOGUE_FIELD_CANDIDATES);
        const albumTitle = firstNonEmptyFast(fields, ['Album Title', 'Tape Files::Album_Title', 'Tape Files::Album Title']);
        const albumArtist = firstNonEmptyFast(fields, ['Album Artist', 'Tape Files::Album Artist', 'Artist']);
        const trackName = firstNonEmptyFast(fields, ['Track Name', 'Tape Files::Track Name', 'Song Name', 'Title']);
        const trackArtist = firstNonEmptyFast(fields, ['Track Artist', 'Tape Files::Track Artist', 'Artist']) || albumArtist;

        let albumKey = makeAlbumKey(catalogue, albumTitle, albumArtist);
        const fallbackKey = record.recordId
          ? `record:${record.recordId}`
          : `track:${normTitle(trackName)}|artist:${normTitle(trackArtist)}`;
        if (!albumKey || albumKey === 'title:|artist:') {
          albumKey = fallbackKey || `row:${deduped.length}`;
        }

        if (seenAlbums.has(albumKey)) continue;
        seenAlbums.add(albumKey);
        deduped.push(record);
      }
      return deduped;
    };

    let validRecords = filterValidRecords();
    // Don't deduplicate - frontend groupAlbums() needs all tracks to group properly
    let processedRecords = validRecords.slice();

    if (genreFilters.length) {
      let batchesFetched = 1;
      let nextFmOffset = fmOff + aggregatedRawCount;
      while (
        processedRecords.length < limit &&
        batchesFetched < MAX_GENRE_FETCH_BATCHES &&
        (rawTotal === null || nextFmOffset <= rawTotal)
      ) {
        const nextAttempt = await runSearch(
          attemptUsedOptional,
          usingTargetedOverrides ? targetedOverrides : undefined,
          nextFmOffset,
          fmQueryLimit
        );
        if (!nextAttempt.response.ok) {
          break;
        }
        const nextRaw = nextAttempt.json?.response?.data || [];
        if (!nextRaw.length) {
          break;
        }
        aggregatedRawData = aggregatedRawData.concat(nextRaw);
        aggregatedRawCount += nextRaw.length;
        batchesFetched += 1;
        nextFmOffset += nextRaw.length;
        if (rawTotal === null) {
          const nextFound = Number(nextAttempt.json?.response?.dataInfo?.foundCount);
          if (Number.isFinite(nextFound)) {
            rawTotal = nextFound;
          }
        }
        validRecords = filterValidRecords();
        // Don't deduplicate - frontend needs all tracks
        processedRecords = validRecords.slice();
      }
    }

    const limitedRecords = processedRecords.slice(0, limit);
    if (rawTotal === null) {
      rawTotal = limitedRecords.length;
    }
    const rawReturnedCount = aggregatedRawCount;

    const response = {
      items: limitedRecords.map((d) => ({ recordId: d.recordId, modId: d.modId, fields: d.fieldData || {} })),
      total: rawTotal,
      offset: uiOff0,
      limit,
      rawReturnedCount
    };

    // Cache the response
    searchCache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    const detail = err?.response?.data?.messages?.[0]?.message || err?.message || String(err);
    res.status(500).json({ error: 'Album search failed', status: 500, detail });
  }
});

app.get('/api/ai-search', async (req, res) => {
  try {
    const query = (req.query.q || '').toString().trim();

    if (!query) {
      return res.status(400).json({ error: 'Query parameter required' });
    }

    if (query.length > 500) {
      return res.status(400).json({ error: 'Query too long (max 500 characters)' });
    }

    // Check cache
    const cacheKey = `ai-search:${query}`;
    const cached = searchCache.get(cacheKey);
    if (cached) {
      console.log(`[CACHE HIT] ai-search: ${query}`);
      res.setHeader('X-Cache-Hit', 'true');
      return res.json(cached);
    }

    console.log(`[AI SEARCH] Query: "${query}"`);

    const scriptParam = JSON.stringify({ query });
    const scriptUrl = `${FM_HOST}/fmi/data/v1/databases/${encodeURIComponent(FM_DB)}/layouts/${encodeURIComponent(FM_LAYOUT)}/script/AI_NaturalLanguageSearch?script.param=${encodeURIComponent(scriptParam)}`;

    const callScript = () =>
      safeFetch(scriptUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${fmToken}`,
          'Content-Type': 'application/json'
        }
      });

    const processScriptResponse = async (scriptResponse, label = '') => {
      const json = await scriptResponse.json();
      const scriptResult = json?.response?.scriptResult;

      if (!scriptResult) {
        res.status(500).json({ error: 'No script result returned from FileMaker script' });
        return false;
      }

      const result = JSON.parse(scriptResult);

      if (!result.success) {
        res.status(500).json({
          error: 'AI interpretation failed',
          detail: result.error || 'Unknown error'
        });
        return false;
      }

      const criteria = result.criteria || {};
      console.log(`[AI SEARCH] Extracted criteria${label}:`, criteria);

      const built = await buildAiResponseFromCriteria(criteria, query, label);
      if (built?.error) {
        res.status(built.error.status).json(built.error.body);
        return false;
      }

      const finalResult = built?.payload;
      if (!finalResult) {
        res.status(500).json({ error: 'AI search failed', detail: 'Missing AI payload' });
        return false;
      }

      searchCache.set(cacheKey, finalResult);
      res.json(finalResult);
      return true;
    };

    const response = await callScript();
    if (response.ok) {
      await processScriptResponse(response);
      return;
    }

    if (response.status === 401) {
      await ensureToken();
      const retryResponse = await callScript();
      if (!retryResponse.ok) {
        const errorText = await retryResponse.text();
        console.error('[AI SEARCH] Script execution failed:', errorText);
        res.status(500).json({ error: 'AI search failed', detail: errorText });
        return;
      }
      await processScriptResponse(retryResponse, ' (retry)');
      return;
    }

    const errorText = await response.text();
    console.error('[AI SEARCH] Script execution failed:', errorText);
    res.status(500).json({ error: 'AI search failed', detail: errorText });
  } catch (err) {
    console.error('[AI SEARCH] Error:', err);
    const detail = err?.message || String(err);
    res.status(500).json({ error: 'AI search failed', status: 500, detail });
  }
});

app.get('/api/trending', async (req, res) => {
  try {
    const limitParam = Number.parseInt(req.query.limit || '5', 10);
    const limit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(TRENDING_MAX_LIMIT, limitParam))
      : 5;
    const cacheKey = `trending:${limit}`;
    const cached = trendingCache.get(cacheKey);
    if (cached) {
      console.log(`[TRENDING] Serving from 24-hour cache (limit=${limit})`);
      res.setHeader('X-Cache-Hit', 'true');
      return res.json({ items: cached });
    }

    console.log(`[TRENDING] Cache miss - calculating fresh trending data (limit=${limit})`);
    const items = await fetchTrendingTracks(limit);
    trendingCache.set(cacheKey, items);
    console.log(`[TRENDING] Cached ${items.length} trending tracks for 24 hours`);
    res.json({ items });
  } catch (err) {
    console.error('[TRENDING] Failed to load trending tracks:', err);
    const detail = err?.message || 'Trending lookup failed';
    res.status(500).json({ error: detail || 'Failed to load trending tracks' });
  }
});

// ISO 639 language code expansion
function expandLanguageCode(code) {
  if (!code || typeof code !== 'string') return code;
  const trimmed = code.trim().toLowerCase();
  const languageMap = {
    'en': 'English',
    'es': 'Spanish',
    'fr': 'French',
    'de': 'German',
    'it': 'Italian',
    'pt': 'Portuguese',
    'ru': 'Russian',
    'ja': 'Japanese',
    'zh': 'Chinese',
    'ko': 'Korean',
    'ar': 'Arabic',
    'hi': 'Hindi',
    'nl': 'Dutch',
    'pl': 'Polish',
    'sv': 'Swedish',
    'no': 'Norwegian',
    'da': 'Danish',
    'fi': 'Finnish',
    'tr': 'Turkish',
    'el': 'Greek',
    'he': 'Hebrew',
    'th': 'Thai',
    'vi': 'Vietnamese',
    'id': 'Indonesian',
    'cs': 'Czech',
    'hu': 'Hungarian',
    'ro': 'Romanian',
    'uk': 'Ukrainian',
    'bg': 'Bulgarian',
    'hr': 'Croatian',
    'sk': 'Slovak',
    'sr': 'Serbian',
    'lt': 'Lithuanian',
    'lv': 'Latvian',
    'et': 'Estonian',
    'sl': 'Slovenian',
    'mt': 'Maltese',
    'ga': 'Irish',
    'cy': 'Welsh',
    'ca': 'Catalan',
    'eu': 'Basque',
    'gl': 'Galician',
    'is': 'Icelandic',
    'af': 'Afrikaans',
    'sw': 'Swahili',
    'zu': 'Zulu',
    'xh': 'Xhosa',
    'fa': 'Persian',
    'ur': 'Urdu',
    'bn': 'Bengali',
    'ta': 'Tamil',
    'te': 'Telugu',
    'ml': 'Malayalam',
    'kn': 'Kannada',
    'mr': 'Marathi',
    'gu': 'Gujarati',
    'pa': 'Punjabi',
    'ne': 'Nepali',
    'si': 'Sinhala',
    'my': 'Burmese',
    'km': 'Khmer',
    'lo': 'Lao',
    'mn': 'Mongolian',
    'ka': 'Georgian',
    'hy': 'Armenian',
    'az': 'Azerbaijani',
    'kk': 'Kazakh',
    'uz': 'Uzbek',
    'tg': 'Tajik',
    'tk': 'Turkmen',
    'ky': 'Kyrgyz',
    'ps': 'Pashto',
    'ku': 'Kurdish',
    'yi': 'Yiddish',
    'la': 'Latin',
    'sa': 'Sanskrit',
    'eo': 'Esperanto'
  };
  return languageMap[trimmed] || code;
}

app.get('/api/random-songs', async (req, res) => {
  try {
    // Override cache-control for random results
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');

    const countParam = Number.parseInt(req.query.count || '12', 10);
    const count = Number.isFinite(countParam) ? Math.max(1, Math.min(100, countParam)) : 12;

    // Parse genre filter (comma-separated genres)
    const genreParam = (req.query.genre || req.query.genres || '').toString().trim();
    const genres = genreParam
      .split(',')
      .map(g => g.trim())
      .filter(Boolean);

    console.log(`[RANDOM SONGS] Requesting ${count} songs${genres.length ? ` (genres: ${genres.join(', ')})` : ''}`);

    // Build FileMaker query - try different field combinations if genre filtering is needed
    let data = [];
    const fetchLimit = count * 3;

    if (genres.length > 0) {
      // Try genre field candidates one at a time to find which works
      const genreFieldCandidates = ['Local Genre', 'Genre'];
      let foundField = null;

      for (const field of genreFieldCandidates) {
        const query = genres.map(genre => ({ [field]: `*${genre}*` }));
        const payload = { query, limit: fetchLimit };

        const response = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, payload);
        const json = await response.json().catch(() => ({}));

        if (response.ok) {
          data = json?.response?.data || [];
          foundField = field;
          console.log(`[RANDOM SONGS] Using genre field "${field}", FileMaker returned ${data.length} records`);
          break;
        } else {
          const code = json?.messages?.[0]?.code;
          const msg = json?.messages?.[0]?.message || 'FM error';
          // Error 102 = field missing, try next candidate
          if (code === 102 || code === '102') {
            console.log(`[RANDOM SONGS] Genre field "${field}" not available (${code}), trying next...`);
            continue;
          }
          // Other errors should be reported
          console.error(`[RANDOM SONGS] FileMaker error: ${msg} (${code})`);
          return res.status(500).json({ ok: false, error: msg, code });
        }
      }

      if (!foundField) {
        console.error('[RANDOM SONGS] No valid genre field found on layout');
        return res.status(500).json({ ok: false, error: 'Genre filtering not supported on this layout' });
      }
    } else {
      // No genre filter - get any records with random offset for variety
      const query = [{ 'Album Title': '*' }];

      // First, get total count
      const countResponse = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, { query, limit: 1 });
      const countJson = await countResponse.json().catch(() => ({}));

      if (!countResponse.ok) {
        const msg = countJson?.messages?.[0]?.message || 'FM error';
        const code = countJson?.messages?.[0]?.code;
        console.error(`[RANDOM SONGS] FileMaker error: ${msg} (${code})`);
        return res.status(500).json({ ok: false, error: msg, code });
      }

      const totalRecords = countJson?.response?.dataInfo?.foundCount || 0;

      // Use random offset to get diverse results (like explore endpoint)
      // Fetch much larger window since albums are clustered consecutively
      // Use minimum 500 records to avoid hitting dead zones with no valid audio
      const windowSize = Math.min(Math.max(500, count * 50), 1000); // Fetch 50x requested count (min 500, max 1000)
      const maxStart = Math.max(1, totalRecords - windowSize + 1);
      const randStart = Math.floor(1 + Math.random() * maxStart);

      const payload = { query, limit: windowSize, offset: randStart };
      const response = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, payload);
      const json = await response.json().catch(() => ({}));

      if (!response.ok) {
        const msg = json?.messages?.[0]?.message || 'FM error';
        const code = json?.messages?.[0]?.code;
        console.error(`[RANDOM SONGS] FileMaker error: ${msg} (${code})`);
        return res.status(500).json({ ok: false, error: msg, code });
      }

      data = json?.response?.data || [];
      console.log(`[RANDOM SONGS] FileMaker returned ${data.length} records from offset ${randStart} (total: ${totalRecords})`);
    }

    // Filter to only records with valid audio AND valid artwork
    const validRecords = data.filter(record => {
      const fields = record.fieldData || {};
      return hasValidAudio(fields) && hasValidArtwork(fields);
    });
    console.log(`[RANDOM SONGS] ${validRecords.length} records have valid audio and artwork (filtered from ${data.length})`);

    // Deduplicate by album to ensure variety - only 1 track per album
    const seenAlbums = new Set();

    // First pass: shuffle all valid records
    const shuffled = validRecords.sort(() => Math.random() - 0.5);

    // Second pass: pick one track per album (process ALL records to maximize variety)
    const diverseRecords = [];
    for (const record of shuffled) {
      const fields = record.fieldData || {};
      const albumTitle = firstNonEmpty(fields, ['Album Title', 'Tape Files::Album Title', 'Album']);
      const albumArtist = firstNonEmpty(fields, ['Album Artist', 'Tape Files::Album Artist', 'Artist']);
      const albumKey = `${albumArtist}|||${albumTitle}`.toLowerCase();

      if (!seenAlbums.has(albumKey)) {
        diverseRecords.push(record);
        seenAlbums.add(albumKey);
      }
    }

    console.log(`[RANDOM SONGS] ${diverseRecords.length} diverse records from ${seenAlbums.size} different albums`);

    // Shuffle again and select requested count
    const finalShuffled = diverseRecords.sort(() => Math.random() - 0.5);
    const selected = finalShuffled.slice(0, count);

    // Build response items with all metadata
    const items = selected.map(record => {
      const fields = record.fieldData || {};
      const recordId = String(record.recordId || '');

      // Extract metadata using helper functions and field candidates
      const albumArtist = firstNonEmpty(fields, ['Album Artist', 'Tape Files::Album Artist', 'Artist']);
      const albumTitle = firstNonEmpty(fields, ['Album Title', 'Tape Files::Album Title', 'Album']);
      const trackName = firstNonEmpty(fields, ['Track Name', 'Tape Files::Track Name', 'Song Title', 'Title']);
      const catalogue = firstNonEmpty(fields, CATALOGUE_FIELD_CANDIDATES);
      const genre = firstNonEmpty(fields, ['Local Genre', 'Tape Files::Local Genre', 'Genre']);
      const languageCode = firstNonEmpty(fields, ['Language Code', 'Language', 'Tape Files::Language']);
      const language = expandLanguageCode(languageCode);
      const producer = firstNonEmpty(fields, ['Producer', 'Tape Files::Producer']);
      const composers = composersFromFields(fields);

      // Get audio and artwork URLs
      const audioInfo = pickFieldValueCaseInsensitive(fields, AUDIO_FIELD_CANDIDATES);
      const artworkInfo = pickFieldValueCaseInsensitive(fields, ARTWORK_FIELD_CANDIDATES);
      const audioSrc = resolvePlayableSrc(audioInfo.value);
      const artworkSrc = resolveArtworkSrc(artworkInfo.value);

      return {
        recordId,
        fields: {
          'Album Artist': albumArtist,
          'Album Title': albumTitle,
          'Track Name': trackName,
          'Catalogue': catalogue,
          'Genre': genre,
          'Language': language,
          'Language Code': languageCode,
          'Producer': producer,
          'Composers': composers,
          [audioInfo.field]: audioInfo.value,
          [artworkInfo.field]: artworkInfo.value
        },
        audioSrc,
        artworkSrc
      };
    }).filter(item => item.audioSrc && item.artworkSrc); // Final safety check - ensure both are non-empty

    console.log(`[RANDOM SONGS] Returning ${items.length} songs (all with valid audio and artwork)`);
    res.json({ ok: true, items, count: items.length });
  } catch (err) {
    console.error('[RANDOM SONGS] Error:', err);
    const detail = err?.message || String(err);
    res.status(500).json({ ok: false, error: 'Failed to fetch random songs', detail });
  }
});

app.get('/api/public-playlists', expensiveLimiter, async (req, res) => {
  try {
    const nameParam = (req.query.name || '').toString().trim();
    const limitParam = Number.parseInt((req.query.limit || '100'), 10);
    const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(2000, limitParam)) : 100;
    const cacheKey = `public-playlists:${nameParam}:${limit}`;
    const cached = publicPlaylistsCache.get(cacheKey);
    if (cached) {
      console.log(`[CACHE HIT] public-playlists: ${nameParam || 'all'}`);
      res.setHeader('X-Cache-Hit', 'true');
      return res.json(cached);
    }

    const { payload, missingEnv } = await buildPublicPlaylistsPayload({ nameParam, limit });
    if (missingEnv) {
      return res.status(503).json({ ok: false, error: 'Curated playlists are disabled: missing FM_HOST/FM_DB/FM_USER/FM_PASS' });
    }

    const finalPayload = payload || { ok: true, playlists: [] };
    publicPlaylistsCache.set(cacheKey, finalPayload);
    res.json(finalPayload);
  } catch (err) {
    console.error('[MASS] Public playlists fetch failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load public playlists' });
  }
});

/* ========= Container proxy ========= */
const MIRROR_HEADERS = new Map([
  ['content-type', 'Content-Type'],
  ['content-length', 'Content-Length'],
  ['accept-ranges', 'Accept-Ranges'],
  ['content-range', 'Content-Range'],
  ['etag', 'ETag'],
  ['last-modified', 'Last-Modified']
]);

app.get('/api/container', async (req, res) => {
  const direct = (req.query.u || '').toString().trim();
  const rid = (req.query.rid || '').toString().trim();
  const field = (req.query.field || '').toString().trim();
  const rep = (req.query.rep || '1').toString().trim();

  let upstreamUrl = '';
  let requiresAuth = false;

  if (rid && field) {
    // Validate record ID
    const ridValidation = validators.recordId(rid);
    if (!ridValidation.valid) {
      res.status(400).json({ error: 'invalid_input', detail: `Invalid record ID: ${ridValidation.error}` });
      return;
    }
    upstreamUrl = `${fmBase}/records/${encodeURIComponent(rid)}/containers/${encodeURIComponent(field)}/${encodeURIComponent(rep || '1')}`;
    requiresAuth = true;
  } else if (direct) {
    // Validate URL to prevent directory traversal and SSRF
    const urlValidation = validators.url(direct);
    if (!urlValidation.valid) {
      res.status(400).json({ error: 'invalid_input', detail: urlValidation.error });
      return;
    }

    // If absolute URL, validate hostname is not private/internal
    if (REGEX_HTTP_HTTPS.test(direct)) {
      try {
        const url = new URL(direct);
        const hostname = url.hostname;

        // Reject private IP ranges and localhost (prevent SSRF)
        if (
          hostname === 'localhost' ||
          hostname === '127.0.0.1' ||
          hostname.match(/^10\./) ||
          hostname.match(/^172\.(1[6-9]|2[0-9]|3[01])\./) ||
          hostname.match(/^192\.168\./) ||
          hostname.match(/^169\.254\./) || // AWS metadata
          hostname.match(/^::1$/) || // IPv6 localhost
          hostname.match(/^fe80:/i) || // IPv6 link-local
          hostname.match(/^fc00:/i) // IPv6 private
        ) {
          res.status(403).json({ error: 'forbidden', detail: 'Access to private/internal IPs not allowed' });
          return;
        }
        upstreamUrl = direct;
      } catch (err) {
        res.status(400).json({ error: 'invalid_input', detail: 'Invalid URL format' });
        return;
      }
    } else {
      // FileMaker container path - already validated for directory traversal by validators.url
      upstreamUrl = `${FM_HOST.replace(/\/?$/, '')}/${direct.replace(/^\//, '')}`;
    }
    requiresAuth = upstreamUrl.startsWith(FM_HOST);
  } else {
    res.status(400).json({ error: 'invalid_input', detail: 'Missing rid/field or u parameter.' });
    return;
  }

  let clientAborted = false;
  const controller = new AbortController();
  const onClose = () => {
    clientAborted = true;
    controller.abort();
  };
  req.once('close', onClose);

  try {
    await ensureToken();

    const headers = new Headers();
    if (requiresAuth && fmToken) headers.set('Authorization', `Bearer ${fmToken}`);
    if (req.headers.range) headers.set('Range', req.headers.range);
    if (req.headers['if-none-match']) headers.set('If-None-Match', req.headers['if-none-match']);
    if (req.headers['if-modified-since']) headers.set('If-Modified-Since', req.headers['if-modified-since']);

    let upstream = await safeFetch(
      upstreamUrl,
      { headers, signal: controller.signal },
      { timeoutMs: 45000, retries: 1 }
    );

    if (upstream.status === 401 && requiresAuth) {
      await fmLogin();
      headers.set('Authorization', `Bearer ${fmToken}`);
      upstream = await safeFetch(
        upstreamUrl,
        { headers, signal: controller.signal },
        { timeoutMs: 45000, retries: 1 }
      );
    }

    if (!upstream.ok && upstream.status !== 206 && upstream.status !== 304) {
      console.warn('[MASS] Container fetch failed', {
        status: upstream.status,
        requiresAuth,
        url: upstreamUrl.slice(0, 200)
      });
      if (upstream.status === 404) {
        res.status(404).json({ error: 'not_found', status: 404, url: upstreamUrl });
      } else {
        const detail = `Upstream error: ${upstream.status}`;
        res.status(upstream.status).send(detail);
      }
      return;
    }

    res.statusCode = upstream.status;
    for (const [lower, headerName] of MIRROR_HEADERS.entries()) {
      const value = upstream.headers.get(lower);
      if (value !== null) res.setHeader(headerName, value);
    }

    if (!res.getHeader('Accept-Ranges')) {
      res.setHeader('Accept-Ranges', 'bytes');
    }

    // Add caching headers for audio/media content to reduce re-fetching and improve buffering
    const contentType = res.getHeader('Content-Type') || '';
    if (contentType.startsWith('audio/') || contentType.startsWith('video/')) {
      res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    }

    if (!upstream.body) {
      res.end();
      return;
    }

    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (err) {
    if (clientAborted) {
      return;
    }

    const msg = String(err?.message || '').toLowerCase();
    const code = err?.code || err?.cause?.code;
    if (err?.name === 'AbortError' && err?.timedOut) {
      if (!res.headersSent) res.status(504).send('Upstream timeout');
    } else if (code === 'UND_ERR_SOCKET' || code === 'ERR_STREAM_PREMATURE_CLOSE' || msg.includes('terminated')) {
      if (!res.headersSent) res.status(502).send('Upstream connection terminated');
    } else {
      if (!res.headersSent) res.status(500).send('Container proxy failed');
    }
  } finally {
    req.off('close', onClose);
  }
});

/* ========= Explore by decade ========= */
app.get('/api/explore', expensiveLimiter, async (req, res) => {
  try {
    // Override global API cache-control - explore returns random data
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');

    const start = parseInt((req.query.start || '0'), 10);
    const end = parseInt((req.query.end || '0'), 10);
    const reqLimit = Math.max(1, Math.min(300, parseInt((req.query.limit || '50'), 10)));
    const requestedOffset = Math.max(0, parseInt((req.query.offset || '0'), 10));
    const bypassCache = req.query.refresh === '1' || req.query.refresh === 'true';
    const usePagination = requestedOffset > 0 || req.query.pagination === 'true';
    if (!start || !end || end < start) return res.status(400).json({ error: 'bad decade', start, end });

    // Note: Random offset means we cache by decade/limit but accept different random results
    // This gives variety while still caching common decade queries
    // Skip cache if refresh parameter is present (for "Select Again" button)
    // Don't cache pagination requests (they need consistent results)
    const cacheKey = `explore:${start}:${end}:${reqLimit}`;
    if (!bypassCache && !usePagination) {
      const cached = exploreCache.get(cacheKey);
      if (cached) {
        console.log(`[CACHE HIT] explore: ${start}-${end}`);
        res.setHeader('X-Cache-Hit', 'true');
        return res.json(cached);
      }
    } else if (bypassCache) {
      console.log(`[CACHE BYPASS] explore: ${start}-${end} (refresh requested)`);
      // Clear cache for this decade to ensure maximum variety
      exploreCache.delete(cacheKey);
    } else if (usePagination) {
      console.log(`[CACHE BYPASS] explore: ${start}-${end} (pagination mode)`);
    }

    const FIELDS = [
      'Year of Release',
      'Year Of Release',
      'Year of release',
      'Year Release',
      'Year',
      'Original Release Year',
      'Original Release Date',
      'Release Year',
      'Recording Year',
      'Year_Release',
      'Year Release num',
      'Year_Release_num',
      'Tape Files::Year of Release',
      'Tape Files::Year Release',
      'Tape Files::Year',
      'Tape Files::Year Release num',
      'Tape Files::Year_Release_num',
      'Albums::Year of Release',
      'Albums::Year Release',
      'Albums::Year',
      'Albums::Year Release num',
      'Albums::Year_Release_num',
      'API_Albums::Year of Release',
      'API_Albums::Year Release',
      'API_Albums::Year',
      'API_Albums::Year Release num',
      'API_Albums::Year_Release_num'
    ];

    // Try cached year field first, then others (performance optimization)
    const fieldsToTry = yearFieldCache
      ? [yearFieldCache, ...FIELDS.filter(f => f !== yearFieldCache)]
      : FIELDS;

    async function tryFind(payload) {
      const r = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, payload);
      const json = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = json?.messages?.[0]?.message || 'FM error';
        const code = json?.messages?.[0]?.code;
        return { ok: false, status: r.status, msg, code, data: [], total: 0 };
      }
      const data = json?.response?.data || [];
      const total = json?.response?.dataInfo?.foundCount ?? data.length;
      return { ok: true, data, total };
    }

    let chosenField = null;
    for (const field of fieldsToTry) {
      const probe = await tryFind({ query: [{ [field]: `${start}...${end}` }], limit: 1, offset: 1 });
      if (probe.ok && probe.total > 0) {
        chosenField = field;
        break;
      }
    }
    if (!chosenField) {
      const years = Array.from({ length: end - start + 1 }, (_, i) => start + i);
      for (const field of fieldsToTry) {
        const probe = await tryFind({ query: years.map((y) => ({ [field]: `==${y}` })), limit: 1, offset: 1 });
        if (probe.ok && probe.total > 0) {
          chosenField = field;
          break;
        }
      }
    }
    if (!chosenField) {
      for (const field of fieldsToTry) {
        const probe = await tryFind({ query: [{ [field]: `${start}*` }], limit: 1, offset: 1 });
        if (probe.ok && probe.total > 0) {
          chosenField = field;
          break;
        }
      }
    }
    if (!chosenField) {
      console.log(`[EXPLORE] No matching year field for ${start}-${end}`);
      return res.json({ ok: true, items: [], total: 0, offset: 0, limit: reqLimit });
    }

    // Cache the working year field for future requests (performance optimization)
    if (chosenField && !yearFieldCache) {
      yearFieldCache = chosenField;
      console.log(`[CACHE] Detected year field: "${chosenField}"`);
    }

    const probe = await tryFind({ query: [{ [chosenField]: `${start}...${end}` }], limit: 1, offset: 1 });
    let foundTotal = probe.total || 0;

    if (!foundTotal) {
      const years = Array.from({ length: end - start + 1 }, (_, i) => start + i);
      const probe2 = await tryFind({ query: years.map((y) => ({ [chosenField]: `==${y}` })), limit: 1, offset: 1 });
      foundTotal = probe2.total || 0;
      if (foundTotal === 0) {
        const probe3 = await tryFind({ query: [{ [chosenField]: `${start}*` }], limit: 1, offset: 1 });
        foundTotal = probe3.total || 0;
      }
    }

    if (foundTotal === 0) {
      console.log(`[EXPLORE] Field ${chosenField} yielded 0 rows for ${start}-${end}`);
      return res.json({ ok: true, items: [], total: 0, offset: 0, limit: reqLimit });
    }

    const windowSize = Math.min(reqLimit, 300);
    const maxStart = Math.max(1, foundTotal - windowSize + 1);

    // Use pagination offset if requested, otherwise use random offset
    let fetchOffset;
    if (usePagination) {
      // For pagination: use requested offset (1-based for FileMaker)
      fetchOffset = Math.max(1, Math.min(requestedOffset + 1, foundTotal));
      console.log(`[EXPLORE] Pagination mode: offset=${requestedOffset}, limit=${windowSize}`);
    } else {
      // For random/shuffle: use random offset
      fetchOffset = Math.floor(1 + Math.random() * maxStart);
      console.log(`[EXPLORE] Random mode: offset=${fetchOffset}, limit=${windowSize}`);
    }

    let final = await tryFind({ query: [{ [chosenField]: `${start}...${end}` }], limit: windowSize, offset: fetchOffset });
    if (!final.ok || final.data.length === 0) {
      const years = Array.from({ length: end - start + 1 }, (_, i) => start + i);
      final = await tryFind({ query: years.map((y) => ({ [chosenField]: `==${y}` })), limit: windowSize, offset: fetchOffset });
      if (!final.ok || final.data.length === 0) {
        final = await tryFind({ query: [{ [chosenField]: `${start}*` }], limit: windowSize, offset: fetchOffset });
      }
    }

    // Filter to only include records with valid audio AND artwork
    const filteredData = (final.data || []).filter(d => {
      const fields = d.fieldData || {};
      return hasValidAudio(fields) && hasValidArtwork(fields);
    });
    const items = filteredData.map((d) => ({ recordId: d.recordId, modId: d.modId, fields: d.fieldData || {} }));
    console.log(`[EXPLORE] ${start}-${end} using ${chosenField}: total ${foundTotal}, offset ${fetchOffset}, returned ${items.length} with audio+artwork (filtered from ${final.data?.length || 0})`);

    // Calculate if there are more results available (for "Load More" button)
    const currentOffset = fetchOffset - 1; // Convert to 0-based
    const hasMore = (currentOffset + items.length) < foundTotal;

    const response = {
      ok: true,
      items,
      total: foundTotal,
      offset: currentOffset,
      limit: windowSize,
      field: chosenField,
      hasMore,
      nextOffset: hasMore ? currentOffset + items.length : null
    };
    // Only cache initial loads, not refreshes or pagination (to preserve variety and consistency)
    if (!bypassCache && !usePagination) {
      exploreCache.set(cacheKey, response);
    }
    return res.json(response);
  } catch (err) {
    const detail = err?.message || String(err);
    return res.status(500).json({ error: 'Explore failed', status: 500, detail });
  }
});


function resolveArtist(fields = {}) {
  return (
    fields['Album Artist'] ||
    fields['Artist'] ||
    fields['Tape Files::Album Artist'] ||
    'Unknown'
  );
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Seeded random number generator using mulberry32 algorithm
// Returns a function that generates random numbers between 0 and 1
function createSeededRandom(seed) {
  let state = seed;
  return function() {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isAbortError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  if (typeof err.code === 'string' && err.code.toUpperCase() === 'UND_ERR_ABORTED') return true;
  const message = typeof err.message === 'string' ? err.message.toLowerCase() : '';
  return message.includes('aborted') || message.includes('aborterror');
}


async function fetchFeaturedAlbumRecords(limit = 400) {
  if (!FEATURED_FIELD_CANDIDATES.length) return [];
  const normalizedLimit = Math.max(1, Math.min(1000, limit));

  // Helper function to try a specific field
  const tryField = async (field) => {
    if (!field) return null;
    // Featured albums are a small set, so we'll filter in Node.js to be less restrictive
    const query = applyVisibility({
      [field]: FM_FEATURED_VALUE
    });
    const payload = {
      query: [query],
      limit: normalizedLimit,
      offset: 1
    };
    try {
      const response = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, payload);
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (isMissingFieldError(json)) {
          return null; // Field doesn't exist, try next
        }
        const fmCode = json?.messages?.[0]?.code;
        if (String(fmCode) === '401') {
          return null; // No records found, try next
        }
        const msg = json?.messages?.[0]?.message || 'FM error';
        console.warn('[featured] Album fetch failed', { field, status: response.status, msg, code: fmCode });
        return [];
      }
      const rawData = json?.response?.data || [];
      // Filter in Node.js for featured albums (small dataset, less restrictive)
      const filtered = rawData
        .filter(record => recordIsVisible(record.fieldData || {}))
        .filter(record => hasValidAudio(record.fieldData || {}))
        .filter(record => hasValidArtwork(record.fieldData || {}))
        .filter(record => recordIsFeatured(record.fieldData || {}));
      if (filtered.length) {
        console.log(`[featured] Field "${field}" returned ${filtered.length}/${rawData.length} records`);
        cachedFeaturedFieldName = field; // Cache successful field name
        return filtered;
      }
      return null;
    } catch (err) {
      console.warn(`[featured] Fetch threw for field "${field}"`, err);
      return null;
    }
  };

  // Try cached field first if we have one
  if (cachedFeaturedFieldName) {
    console.log(`[featured] Trying cached field: "${cachedFeaturedFieldName}"`);
    const result = await tryField(cachedFeaturedFieldName);
    if (result && result.length > 0) {
      return result;
    }
    // Cached field failed, clear it and try all candidates
    console.warn(`[featured] Cached field "${cachedFeaturedFieldName}" failed, trying all candidates`);
    cachedFeaturedFieldName = null;
  }

  // Try all field candidates
  for (const field of FEATURED_FIELD_CANDIDATES) {
    const result = await tryField(field);
    if (result && result.length > 0) {
      return result;
    }
    if (Array.isArray(result) && result.length === 0) {
      // Empty array means error, stop trying
      return [];
    }
  }
  return [];
}

function cloneRecordsForLimit(records = [], count = records.length) {
  return records.slice(0, Math.min(count, records.length)).map((record) => ({
    recordId: record.recordId,
    modId: record.modId,
    fields: { ...(record.fieldData || record.fields || {}) }
  }));
}

async function loadFeaturedAlbumRecords({ limit = 400, refresh = false } = {}) {
  const now = Date.now();
  const cacheAge = featuredAlbumCache.updatedAt ? (now - featuredAlbumCache.updatedAt) / 1000 : 0;

  if (
    !refresh &&
    featuredAlbumCache.items.length &&
    now - featuredAlbumCache.updatedAt < FEATURED_ALBUM_CACHE_TTL_MS
  ) {
    console.log(`[featured] Using cache (age: ${cacheAge.toFixed(1)}s, ${featuredAlbumCache.items.length} items)`);
    return {
      items: cloneRecordsForLimit(featuredAlbumCache.items, limit),
      total: featuredAlbumCache.total
    };
  }

  console.log(`[featured] Fetching fresh data (refresh=${refresh}, cache age=${cacheAge.toFixed(1)}s)`);
  const fetchLimit = Math.max(limit, 400);
  const records = await fetchFeaturedAlbumRecords(fetchLimit);
  const items = records.map((record) => ({
    recordId: record.recordId,
    modId: record.modId,
    fields: record.fieldData || {}
  }));

  console.log(`[featured] Cached ${items.length} featured albums`);

  // Log first 5 albums for debugging
  if (items.length > 0) {
    console.log('[featured] Sample albums:');
    items.slice(0, 5).forEach((item, i) => {
      const title = item.fields['Album Title'] || item.fields['Tape Files::Album_Title'] || 'Unknown';
      const artist = item.fields['Album Artist'] || item.fields['Tape Files::Album Artist'] || 'Unknown';
      const featuredValue = item.fields['Tape Files::featured'] || item.fields['featured'] || item.fields['Tape Files::Featured'] || item.fields['Featured'] || 'N/A';
      console.log(`[featured]   ${i + 1}. "${title}" by ${artist} (featured=${featuredValue})`);
    });
  }

  featuredAlbumCache = {
    items,
    total: items.length,
    updatedAt: now
  };

  return {
    items: cloneRecordsForLimit(items, limit),
    total: items.length
  };
}

app.get('/api/featured-albums', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit || '400', 10)));
    const refresh = req.query.refresh === '1';
    console.log(`[featured] GET /api/featured-albums limit=${limit} refresh=${refresh}`);
    const result = await loadFeaturedAlbumRecords({ limit, refresh });
    // No browser caching - always fetch fresh from server (server has its own 30s cache)
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.json({ ok: true, items: result.items, total: result.total });
  } catch (err) {
    console.error('[featured] Failed to load albums', err);
    return res.status(500).json({ ok: false, error: 'Failed to load featured albums' });
  }
});

// Alias endpoint for modern view
app.get('/api/releases/latest', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit || '1', 10)));
    const refresh = req.query.refresh === '1';
    console.log(`[releases] GET /api/releases/latest limit=${limit} refresh=${refresh}`);
    const result = await loadFeaturedAlbumRecords({ limit, refresh });
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.json({ ok: true, items: result.items, total: result.total });
  } catch (err) {
    console.error('[releases] Failed to load latest releases', err);
    return res.status(500).json({ ok: false, error: 'Failed to load latest releases' });
  }
});



/* ========= Missing Audio Songs: Get random songs WITHOUT valid audio ========= */
app.get('/api/missing-audio-songs', async (req, res) => {
  try {
    const count = Math.max(1, Math.min(50, parseInt(req.query.count || '12', 10)));

    await ensureToken();

    // Fetch with random offset to show different missing audio songs each time
    const fetchLimit = count * 20; // Fetch more since we're filtering for missing audio
    const maxOffset = 10000;
    const randomOffset = Math.floor(Math.random() * maxOffset) + 1;

    console.log(`[missing-audio-songs] Fetching ${fetchLimit} records from offset ${randomOffset}`);

    const json = await fmFindRecords(FM_LAYOUT, [{ 'Album Title': '*' }], {
      limit: fetchLimit,
      offset: randomOffset
    });

    const rawData = json?.data || [];
    console.log(`[missing-audio-songs] Fetched ${rawData.length} total records`);

    // Filter for records WITHOUT valid audio
    const missingAudioRecords = rawData.filter(record => {
      const fields = record.fieldData || {};
      const hasAudio = hasValidAudio(fields);
      return !hasAudio;
    });

    console.log(`[missing-audio-songs] Found ${missingAudioRecords.length} songs without audio out of ${rawData.length} total`);

    // Shuffle and take requested count
    const shuffled = missingAudioRecords.sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, count);

    // Map to items format
    const items = selected.map(record => ({
      recordId: record.recordId,
      modId: record.modId,
      fields: record.fieldData || {}
    }));

    console.log(`[missing-audio-songs] Returning ${items.length} songs`);

    return res.json({ ok: true, items, total: items.length });
  } catch (err) {
    console.error('[missing-audio-songs] Error:', err);
    const detail = err?.message || String(err);
    return res.status(500).json({ error: 'Missing audio songs failed', status: 500, detail });
  }
});

/* ========= Album: fetch full tracklist =========*/
app.get('/api/album', async (req, res) => {
  try {
    // Validate input parameters
    const catValidation = validateQueryString(req.query.cat, 'cat', 100);
    if (!catValidation.ok) {
      return res.status(400).json({ error: catValidation.reason });
    }
    const titleValidation = validateQueryString(req.query.title, 'title', 200);
    if (!titleValidation.ok) {
      return res.status(400).json({ error: titleValidation.reason });
    }
    const artistValidation = validateQueryString(req.query.artist, 'artist', 200);
    if (!artistValidation.ok) {
      return res.status(400).json({ error: artistValidation.reason });
    }

    const cat = catValidation.value;
    const title = titleValidation.value;
    const artist = artistValidation.value;
    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit || '100', 10)));

    // Check cache
    const cacheKey = `album:${cat}:${title}:${artist}:${limit}`;
    const cached = albumCache.get(cacheKey);
    if (cached) {
      console.log(`[CACHE HIT] album: ${cacheKey.slice(0, 50)}...`);
      res.setHeader('X-Cache-Hit', 'true');
      return res.json(cached);
    }

    let queries = [];
    const exact = (v) => `==${v}`;

    if (cat) {
      // Search by Reference Catalogue Number
      queries = [
        { 'Reference Catalogue Number': cat }
      ];
    } else if (title) {
      // Just search by album title - don't use exact match as it may not be supported
      queries = [
        { 'Album Title': title }
      ];
    } else {
      return res.status(400).json({ error: 'Missing cat or title' });
    }

    const payload = { query: queries, limit, offset: 1 };
    const r = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, payload);
    const json = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = json?.messages?.[0]?.message || 'FM error';
      const code = json?.messages?.[0]?.code;
      const httpStatus = fmErrorToHttpStatus(code, r.status);
      return res.status(httpStatus).json({ error: 'Album lookup failed', status: httpStatus, detail: `${msg} (FM ${code})` });
    }

    const rawData = json?.response?.data || [];

    // Filter to only include records with valid audio
    const data = rawData.filter(d => hasValidAudio(d.fieldData || {}));

    // Get the actual total count from FileMaker (before filtering)
    const actualTotal = json?.response?.dataInfo?.foundCount ?? rawData.length;

    const response = {
      ok: true,
      items: data.map((d) => ({ recordId: d.recordId, modId: d.modId, fields: d.fieldData || {} })),
      total: actualTotal,
      offset: 0, // This endpoint doesn't use pagination (returns all tracks for an album)
      limit
    };

    // Cache the response
    albumCache.set(cacheKey, response);
    return res.json(response);
  } catch (err) {
    const detail = err?.message || String(err);
    return res.status(500).json({ error: 'Album lookup failed', status: 500, detail });
  }
});

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

// Load access tokens on server startup
try {
  await loadAccessTokens();
  console.log('[MASS] Access tokens loaded successfully');
} catch (err) {
  console.warn('[MASS] Failed to load access tokens:', err);
}

// Pre-warm FileMaker connection pool
async function warmConnections() {
  console.log('[MASS] Warming FileMaker connections...');
  try {
    await ensureToken();
    // Make a lightweight query to fully establish the connection
    await fmFindRecords(FM_LAYOUT, [{ 'Album Title': '*' }], { limit: 1 });
    console.log('[MASS] FileMaker connection warmed successfully');

    const warmTasks = [];

    warmTasks.push((async () => {
      try {
        const items = await fetchTrendingTracks(5);
        trendingCache.set('trending:5', items);
        console.log(`[MASS] Prefetched ${items.length} trending tracks`);
      } catch (err) {
        console.warn('[MASS] Trending warm-up failed:', err?.message || err);
      }
    })());

    warmTasks.push((async () => {
      try {
        const { payload, missingEnv } = await buildPublicPlaylistsPayload({ nameParam: '', limit: 100 });
        if (missingEnv) {
          console.warn('[MASS] Skipping playlist warm-up: missing FM environment variables');
          return;
        }
        if (payload) {
          publicPlaylistsCache.set('public-playlists::100', payload);
          console.log(`[MASS] Prefetched ${payload.playlists?.length || 0} public playlists`);
        }
      } catch (err) {
        console.warn('[MASS] Public playlist warm-up failed:', err?.message || err);
      }
    })());

    await Promise.allSettled(warmTasks);
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

// Call warmConnections before starting the server
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
// Properly close the HTTP connection pool and server on shutdown signals

process.on('SIGTERM', async () => {
  console.log('[MASS] SIGTERM received, shutting down gracefully...');
  if (server) {
    server.close(() => {
      console.log('[MASS] HTTP server closed');
    });
  }
  try {
    await fmAgent.close();
    console.log('[MASS] FileMaker connection pool closed');
  } catch (err) {
    console.error('[MASS] Error closing connection pool:', err);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[MASS] SIGINT received, shutting down gracefully...');
  if (server) {
    server.close(() => {
      console.log('[MASS] HTTP server closed');
    });
  }
  try {
    await fmAgent.close();
    console.log('[MASS] FileMaker connection pool closed');
  } catch (err) {
    console.error('[MASS] Error closing connection pool:', err);
  }
  process.exit(0);
});
