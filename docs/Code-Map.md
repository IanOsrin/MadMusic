# MAD Code Map
This document summarizes the purpose of each primary .js and .html file in the repository. Where available, the first header comment is included as a hint.

## server.js
- Summary: (no header comment; see description below)
- Role: Express app entry point; mounts routes, sets security headers, serves static assets, and starts HTTP server(s).

Header/context:
```
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
```

## cluster.js
- Summary: (no header comment; see description below)
- Role: Clustered server launcher; manages multi-worker startup for server.js.

Header/context:
```
import cluster from 'node:cluster';
import os from 'node:os';
const numCPUs = os.cpus().length;
const MAX_WORKERS = Number.parseInt(process.env.MAX_WORKERS || '0', 10) || Math.min(numCPUs, 4);
if (cluster.isPrimary) {
  console.log(`[CLUSTER] Primary process ${process.pid} is running`);
  console.log(`[CLUSTER] Starting ${MAX_WORKERS} workers (${numCPUs} CPUs available)`);
  // Fork workers with a staggered delay so they don't all hammer FileMaker
  // at the same instant during startup (avoids FM request queue bursts).
  for (let i = 0; i < MAX_WORKERS; i++) {
    setTimeout(() => cluster.fork({ WORKER_INDEX: String(i) }), i * 1500);
  }
```

## cache.js
- Summary: High-performance LRU cache using npm package
- Role: Central in-memory LRU caches and TTLs used across the app.

Header/context:
```
// High-performance LRU cache using npm package
import { LRUCache } from 'lru-cache';
// ── Named TTL constants (milliseconds) ────────────────────────────────────────
const MINUTE_MS  = 60 * 1000;
const HOUR_MS    = 60 * MINUTE_MS;
const DAY_MS     = 24 * HOUR_MS;
// Global cache instances - Optimized for faster performance with bounded memory
export const searchCache = new LRUCache({
  max: 2000, // Increased from 500 to cache more searches
  ttl: HOUR_MS, // 1 hour (increased from 5 minutes for better performance)
  updateAgeOnGet: true, // Reset TTL on access to keep popular searches cached
  updateAgeOnHas: true
```

## fm-client.js
- Summary: ============================================================================
- Role: FileMaker client: token management, HTTP helpers, and FM query wrappers.

Header/context:
```
// ============================================================================
// fm-client.js — FileMaker Data API client
// Handles connection pooling, request queuing, token management, and all
// FileMaker API operations. Imported by server.js.
// ============================================================================
import 'dotenv/config';
import { fetch, Agent } from 'undici';
import { parsePositiveInt, parseNonNegativeInt } from './lib/format.js';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// ============================================================================
// HTTP CONNECTION POOL
// ============================================================================
```

## store.js
- Summary: store.js — backwards-compatibility re-export shim for token storage.
- Role: Simple in-memory store/shared state used by the server.

Header/context:
```
// store.js — backwards-compatibility re-export shim for token storage.
// Playlists and library have moved to FM-backed modules; import directly from:
//   lib/token-store.js    — token CRUD and generation
//   lib/playlist-store.js — playlist FM operations
//   lib/library-store.js  — user library FM operations
export * from './lib/token-store.js';
```

## routes/access.js
- Summary: (no header comment; see description below)
- Role: Express route module mounted under /api or top-level path; handles HTTP requests and JSON responses.

Header/context:
```
import { Router } from 'express';
import { validateAccessToken, MASS_SESSION_COOKIE, MASS_SESSION_MAX_AGE_SECONDS } from '../lib/auth.js';
import { parseCookies, getClientIP } from '../lib/http.js';
import { formatTimestampUTC, toCleanString, normalizeSeconds } from '../lib/format.js';
import { validateSessionId } from '../lib/validators.js';
import {
  STREAM_EVENT_TYPES, STREAM_EVENT_DEBUG, STREAM_TERMINAL_EVENTS,
  STREAM_TIME_FIELD, STREAM_TIME_FIELD_LEGACY,
  ensureStreamRecord, findStreamRecord,
  setCachedStreamRecordId, clearCachedStreamRecordId, getCachedStreamRecordId
} from '../lib/stream-events.js';
import { fmUpdateRecord, fmFindRecords } from '../fm-client.js';
```

## routes/payments.js
- Summary: (no header comment; see description below)
- Role: Express route module mounted under /api or top-level path; handles HTTP requests and JSON responses.

Header/context:
```
import { Router } from 'express';
import { sendTokenEmail, sendSubscriptionWelcomeEmail, sendTrialEmail } from '../lib/email.js';
import {
  paystackRequest, verifyPaystackWebhook,
  PAYSTACK_PLANS, PAYSTACK_SUBSCRIPTION_PLAN, SUBSCRIPTION_INTERVAL_DAYS,
  getSubscriptionPlanAmount
} from '../lib/paystack.js';
import { handleDownloadWebhook } from './download.js';
import {
  createAccessToken,
  createSubscriptionToken, renewSubscriptionToken,
  disableSubscriptionToken, findSubscriptionToken,
```

## routes/admin.js
- Summary: routes/admin.js — health, cache stats, and cache flush.
- Role: Express route module mounted under /api or top-level path; handles HTTP requests and JSON responses.

Header/context:
```
// routes/admin.js — health, cache stats, and cache flush.
//
// Write endpoints (POST /cache/flush) require the X-Admin-Key header to match
// the ADMIN_SECRET environment variable.
// /health is public (no auth) so monitoring tools can reach it without credentials.
// /cache/stats requires a valid access token (NOT in skipPaths) but NOT an admin key.
// /cache/flush requires both a valid access token AND the X-Admin-Key header.
import { Router } from 'express';
import { ensureToken, fmQueueStats } from '../fm-client.js';
import { loadAccessTokens, saveAccessTokens, resyncUnsyncedTokens } from '../lib/token-store.js';
import {
  searchCache,
```

## routes/library.js
- Summary: (no header comment; see description below)
- Role: Express route module mounted under /api or top-level path; handles HTTP requests and JSON responses.

Header/context:
```
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireTokenEmail } from '../lib/auth.js';
import { loadUserLibrary, updateUserLibrary } from '../lib/library-store.js';
const router = Router();
// All library routes return user-specific data — never cache on client or CDN.
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
router.get('/', async (req, res) => {
  const user = requireTokenEmail(req, res);
  if (!user) return;
  try {
    const { songs, albums } = await loadUserLibrary(user.email);
```

## routes/playlists.js
- Summary: (no header comment; see description below)
- Role: Express route module mounted under /api or top-level path; handles HTTP requests and JSON responses.

Header/context:
```
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireTokenEmail } from '../lib/auth.js';
import { validators } from '../lib/validators.js';
import { normalizeShareId, generateShareId, escapeHtml } from '../lib/format.js';
import { buildShareUrl } from '../lib/http.js';
import {
  playlistOwnerMatches, sanitizePlaylistForShare,
  buildPlaylistDuplicateIndex, resolveDuplicate, summarizeTrackPayload, buildTrackEntry
} from '../lib/playlist.js';
import { normalizeTrackPayload } from '../lib/track.js';
import { AUDIO_FIELD_CANDIDATES, ARTWORK_FIELD_CANDIDATES, FM_LAYOUT } from '../lib/fm-fields.js';
```

## routes/download.js
- Summary: (no header comment; see description below)
- Role: Express route module mounted under /api or top-level path; handles HTTP requests and JSON responses.

Header/context:
```
/**
 * routes/download.js — Per-track paid download endpoints.
 * No streaming access token required — open to anyone.
 * Purchases are identified by Paystack reference stored in FileMaker.
 *
 * POST /api/download/initiate  { trackId, trackRecordId, email } → { ok, authorization_url, reference }
 * GET  /api/download/callback  ?reference=                       → redirects to /?download=success&ref=...
 * GET  /api/download/file      ?ref=                             → proxied audio file
 */
import { Router }   from 'express';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
```

## routes/ringtone.js
- Summary: (no header comment; see description below)
- Role: Express route module mounted under /api or top-level path; handles HTTP requests and JSON responses.

Header/context:
```
/**
 * routes/ringtone.js — Ringtone purchase payment flow (R5 via Paystack).
 *
 * POST /api/ringtone/initiate   { src, name, artist, artwork, startSec, durationSec, email }
 *                               → { ok, authorization_url, reference }
 *
 * GET  /api/ringtone/callback   ?reference=
 *                               → verify Paystack, record in FM, redirect to /ringtone?paid=REF&...
 *
 * GET  /api/ringtone/verify     ?ref=
 *                               → { ok, valid } — called by the frontend after redirect
 *
```

## routes/telkom.js
- Summary: (no header comment; see description below)
- Role: Express route module mounted under /api or top-level path; handles HTTP requests and JSON responses.

Header/context:
```
/**
 * routes/telkom.js — Telkom PartnerHUB webhook endpoints
 *
 * Receives subscription lifecycle notifications from Telkom SDP and
 * manages access tokens + API_Users records accordingly.
 *
 * Endpoints:
 *   POST /api/telkom/subscription  — subscription status change notifications
 *   POST /api/telkom/billing       — billing event notifications
 */
import { Router } from 'express';
import { fmFindRecords, fmCreateRecord, fmUpdateRecord } from '../fm-client.js';
```

## routes/stream.js
- Summary: (no header comment; see description below)
- Role: Express route module mounted under /api or top-level path; handles HTTP requests and JSON responses.

Header/context:
```
import { Router } from 'express';
import { fmGetRecordById, ensureToken, safeFetch, fmLogin } from '../fm-client.js';
import { validators } from '../lib/validators.js';
import { AUDIO_FIELD_CANDIDATES, FM_LAYOUT, FM_HOST } from '../lib/fm-fields.js';
import { containerUrlCache } from '../cache.js';
const router = Router();
const REGEX_HTTP_HTTPS = /^https?:\/\//i;
const PRIVATE_IP_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
```

## routes/catalog.js
- Summary: routes/catalog.js — thin index: mounts catalog sub-routers.
- Role: Express route module mounted under /api or top-level path; handles HTTP requests and JSON responses.

Header/context:
```
// routes/catalog.js — thin index: mounts catalog sub-routers.
// Each sub-router owns its helpers, caches, and route handlers.
//
//   search.js    → /wake, /search, /explore, /ai-search
//   trending.js  → /trending, /my-stats
//   featured.js  → /featured-albums, /releases/latest, /new-releases
//   discovery.js → /random-songs, /public-playlists, /album, /missing-audio-songs
//   genres.js    → /genres
import { Router } from 'express';
import searchRouter    from './catalog/search.js';
import trendingRouter  from './catalog/trending.js';
import featuredRouter  from './catalog/featured.js';
```

## routes/catalog/search.js
- Summary: routes/catalog/search.js — /wake, /search, /explore, /ai-search
- Role: Express route module mounted under /api or top-level path; handles HTTP requests and JSON responses.

Header/context:
```
// routes/catalog/search.js — /wake, /search, /explore, /ai-search
import { Router } from 'express';
import { fmPost, ensureToken } from '../../fm-client.js';
import { searchCache, exploreCache } from '../../cache.js';
import { hasValidAudio, hasValidArtwork } from '../../lib/track.js';
import {
  isMissingFieldError, applyVisibility,
  FM_LAYOUT
} from '../../lib/fm-fields.js';
import { fmErrorToHttpStatus } from '../../lib/http.js';
import { createLogger } from '../../lib/logger.js';
const router = Router();
```

## routes/catalog/genres.js
- Summary: routes/catalog/genres.js — /genres
- Role: Express route module mounted under /api or top-level path; handles HTTP requests and JSON responses.

Header/context:
```
// routes/catalog/genres.js — /genres
//
// Scans distinct Local Genre values across FM records. Cold fetch is ~18s (59k
// records / 20 FM pages), so we wrap it in SWR: users only wait that long once,
// on the very first request after startup. After that, every request returns
// instantly — stale-while-revalidate refreshes in the background.
//
import { Router } from 'express';
import { fmPost } from '../../fm-client.js';
import { FM_LAYOUT, applyVisibility } from '../../lib/fm-fields.js';
import { parsePositiveInt } from '../../lib/format.js';
import { createSwrCache } from '../../lib/swr-cache.js';
```

## routes/catalog/discovery.js
- Summary: routes/catalog/discovery.js — /random-songs, /public-playlists, /album, /missing-audio-songs
- Role: Express route module mounted under /api or top-level path; handles HTTP requests and JSON responses.

Header/context:
```
// routes/catalog/discovery.js — /random-songs, /public-playlists, /album, /missing-audio-songs
import { Router } from 'express';
import { randomInt } from 'node:crypto';
import { fmPost, fmFindRecords } from '../../fm-client.js';
import { albumCache, randomSongsPoolCache } from '../../cache.js';
import { hasValidAudio, hasValidArtwork, resolvePlayableSrc, resolveArtworkSrc } from '../../lib/track.js';
import {
  FM_LAYOUT,
  firstNonEmpty, AUDIO_FIELD_CANDIDATES, ARTWORK_FIELD_CANDIDATES,
  CATALOGUE_FIELD_CANDIDATES, pickFieldValueCaseInsensitive
} from '../../lib/fm-fields.js';
import { fmErrorToHttpStatus } from '../../lib/http.js';
```

## routes/catalog/trending.js
- Summary: routes/catalog/trending.js — /trending, /my-stats
- Role: Express route module mounted under /api or top-level path; handles HTTP requests and JSON responses.

Header/context:
```
// routes/catalog/trending.js — /trending, /my-stats
//
// Performance:
//   - /trending is wrapped in SWR (24h soft TTL): first call warms; every
//     subsequent call either returns fresh (<24h) or stale-with-background-
//     refresh, so users never wait on the FM round-trip after warm-up.
//   - Track-record fan-out (fmGetRecordById batch) is routed through the
//     shared trackRecordCache, eliminating the N+1 pattern where /trending
//     and /my-stats re-fetch the same hot tracks that /featured-albums etc.
//     have already loaded.
//
import { Router } from 'express';
```

## routes/catalog/featured.js
- Summary: routes/catalog/featured.js — /featured-albums, /releases/latest, /new-releases, /g100-albums
- Role: Express route module mounted under /api or top-level path; handles HTTP requests and JSON responses.

Header/context:
```
// routes/catalog/featured.js — /featured-albums, /releases/latest, /new-releases, /g100-albums
//
// All three endpoints now share the same stale-while-revalidate pattern:
//   - Fresh cache hit  → return immediately.
//   - Stale cache hit  → return stale, kick off background refresh (no user wait).
//   - Cold miss        → one synchronous load, subsequent callers dedupe.
//
// Aggressive TTLs (10 min featured/new-releases, 10 min G100) with SWR mean
// users only ever wait on the very first request after a cold start.
//
import { Router } from 'express';
import { fmPost } from '../../fm-client.js';
```

## lib/auth.js
- Summary: (no header comment; see description below)
- Role: Library/helper module used by routes and server; encapsulates domain logic or integrations.

Header/context:
```
/**
 * lib/auth.js — Access token validation and session auth middleware.
 * Dependencies: fm-client.js, cache.js, store.js, lib/format.js, lib/http.js
 */
import { fmFindRecords, fmUpdateRecord } from '../fm-client.js';
import { getAccessTokensCacheData } from './token-store.js';
import { normalizeEmail } from './format.js';
import { parseCookies } from './http.js';
// ── Session constants ─────────────────────────────────────────────────────────
export const MASS_SESSION_COOKIE          = 'mass.sid';
export const MASS_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
// ── Token validation ──────────────────────────────────────────────────────────
```

## lib/email.js
- Summary: (no header comment; see description below)
- Role: Library/helper module used by routes and server; encapsulates domain logic or integrations.

Header/context:
```
/**
 * lib/email.js — Nodemailer singleton and transactional email helpers.
 * No dependencies on other app modules (env vars only).
 */
import nodemailer from 'nodemailer';
// ── Config ───────────────────────────────────────────────────────────────────
const EMAIL_HOST = process.env.EMAIL_HOST || 'smtp.ionos.com';
const EMAIL_PORT = Number.parseInt(process.env.EMAIL_PORT) || 587;
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
const EMAIL_FROM = process.env.EMAIL_FROM || EMAIL_USER;
// ── Singleton transporter ─────────────────────────────────────────────────────
```

## lib/format.js
- Summary: (no header comment; see description below)
- Role: Library/helper module used by routes and server; encapsulates domain logic or integrations.

Header/context:
```
/**
 * lib/format.js — Pure string / value formatting utilities.
 * No dependencies on other app modules.
 */
import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// lib/ is one level below the project root, so public/ is ../public
export const PUBLIC_DIR = path.join(__dirname, '..', 'public');
export const PLAYLIST_IMAGE_EXTS = ['.webp', '.jpg', '.jpeg', '.png', '.gif', '.svg'];
```

## lib/http.js
- Summary: (no header comment; see description below)
- Role: Library/helper module used by routes and server; encapsulates domain logic or integrations.

Header/context:
```
/**
 * lib/http.js — HTTP / request utilities.
 * No dependencies on other app modules.
 */
import { createHash } from 'node:crypto';
import { normalizeShareId } from './format.js';
// Module-level map: shared across all calls so concurrent requests for the
// same key actually share one in-flight promise.
const _pendingRequests = new Map();
export async function deduplicatedFetch(cacheKey, cache, fetchFn) {
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
```

## lib/logger.js
- Summary: (no header comment; see description below)
- Role: Library/helper module used by routes and server; encapsulates domain logic or integrations.

Header/context:
```
/**
 * lib/logger.js — Log-level-aware logger with per-tag debug gating.
 *
 * Usage:
 *   import { createLogger } from '../lib/logger.js';
 *   const log = createLogger('featured');
 *   log.debug('fetched', items.length, 'records');  // only logs if DEBUG includes 'featured' or '*'
 *   log.info('cache warmed');                        // always logs
 *   log.warn('fallback triggered');                  // always logs
 *   log.error('fatal', err);                         // always logs
 *
 * Enable debug output with:
```

## lib/paystack.js
- Summary: (no header comment; see description below)
- Role: Library/helper module used by routes and server; encapsulates domain logic or integrations.

Header/context:
```
/**
 * lib/paystack.js — Paystack client and plan definitions.
 * No dependencies on other app modules (env vars + node:crypto only).
 */
import { createHmac } from 'node:crypto';
import { safeFetch } from '../fm-client.js';
// ── Config ───────────────────────────────────────────────────────────────────
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_BASE_URL   = 'https://api.paystack.co';
// ── One-time plans — single source of truth ───────────────────────────────────
export const PAYSTACK_PLANS = {
  '1-day':  { amount: 500,   label: '1 Day Access',  days: 1,  display: 'R5'  },
```

## lib/playlist.js
- Summary: (no header comment; see description below)
- Role: Library/helper module used by routes and server; encapsulates domain logic or integrations.

Header/context:
```
/**
 * lib/playlist.js — Playlist business logic and track entry helpers.
 * Dependencies: lib/format.js, cache.js
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { PUBLIC_DIR, PLAYLIST_IMAGE_EXTS, slugifyPlaylistName, normalizeShareId } from './format.js';
import { playlistImageLRU } from '../cache.js';
export const PLAYLIST_IMAGE_DIR = path.join(PUBLIC_DIR, 'img', 'playlists');
// ── Playlist ownership ───────────────────────────────────────────────────────
export const playlistOwnerMatches = (ownerId, userEmail) => {
```

## lib/playlist-store.js
- Summary: (no header comment; see description below)
- Role: Library/helper module used by routes and server; encapsulates domain logic or integrations.

Header/context:
```
/**
 * lib/playlist-store.js — Playlist storage, backed by FileMaker (API_Playlists layout).
 * Each playlist is a separate FM record. Tracks are stored as a JSON blob in Songs_JSON.
 *
 * FM layout: API_Playlists (env: FM_PLAYLISTS_LAYOUT)
 * Fields: Playlist_ID, User_Email, Name, Artwork, Songs_JSON,
 *         Share_ID, Shared_At, Created_At, Updated_At
 */
import 'dotenv/config';
import { fmFindRecords, fmCreateRecord, fmUpdateRecord, fmDeleteRecord } from '../fm-client.js';
import { normalizeShareId } from './format.js';
const FM_PLAYLISTS_LAYOUT = process.env.FM_PLAYLISTS_LAYOUT || 'API_Playlists';
```

## lib/server-start-time.js
- Summary: Captures the process start time once at module load.
- Role: Library/helper module used by routes and server; encapsulates domain logic or integrations.

Header/context:
```
// Captures the process start time once at module load.
// Import this wherever you need server uptime rather than re-declaring Date.now().
export const SERVER_START_TIME = Date.now();
```

## lib/stream-events.js
- Summary: (no header comment; see description below)
- Role: Library/helper module used by routes and server; encapsulates domain logic or integrations.

Header/context:
```
/**
 * lib/stream-events.js — Stream event constants and FileMaker record tracking.
 * Dependencies: fm-client.js, cache.js, lib/fm-fields.js
 */
import { fmFindRecords, fmCreateRecord } from '../fm-client.js';
import { streamRecordLRU } from '../cache.js';
import { FM_STREAM_EVENTS_LAYOUT } from './fm-fields.js';
// ── Constants ────────────────────────────────────────────────────────────────
export const STREAM_EVENT_DEBUG = (
  process.env.DEBUG_STREAM_EVENTS === 'true' ||
  process.env.NODE_ENV === 'development' ||
  process.env.DEBUG?.includes('stream')
```

## lib/swr-cache.js
- Summary: (no header comment; see description below)
- Role: Library/helper module used by routes and server; encapsulates domain logic or integrations.

Header/context:
```
/**
 * lib/swr-cache.js — Stale-while-revalidate wrapper for any LRU-style cache.
 *
 * Strategy:
 *   - Miss           → synchronously load; store { value, storedAt }; return value.
 *   - Fresh (<ttlMs) → return value immediately.
 *   - Stale (>ttlMs) → return stored value immediately, kick off background refresh.
 *   - Concurrent stale hits dedupe: only one background refresh runs per key.
 *   - Concurrent misses dedupe too: only one synchronous fetch runs per key.
 *   - Background refresh failure preserves the stale value (no cache nuke).
 *
 * The wrapped cache's own TTL should be set ≥ 2× ttlMs so stale values survive
```

## lib/token-store.js
- Summary: (no header comment; see description below)
- Role: Library/helper module used by routes and server; encapsulates domain logic or integrations.

Header/context:
```
/**
 * lib/token-store.js — Access token storage, generation, and FM sync.
 * FM (API_Access_Tokens layout) is the source of truth; the JSON file
 * (data/access-tokens.json) is a resilience cache for FM outages.
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { fmCreateRecord } from '../fm-client.js';
import { acquireLock, releaseLock } from './file-lock.js';
```

## lib/track.js
- Summary: (no header comment; see description below)
- Role: Library/helper module used by routes and server; encapsulates domain logic or integrations.

Header/context:
```
/**
 * lib/track.js — Track URL resolution and payload normalisation.
 * Dependencies: lib/fm-fields.js
 */
import { AUDIO_FIELD_CANDIDATES } from './fm-fields.js';
// ── Internal regex ───────────────────────────────────────────────────────────
const REGEX_HTTP_HTTPS               = /^https?:\/\//i;
const REGEX_ABSOLUTE_API_CONTAINER   = /^https?:\/\/[^/]+\/api\/container\?/i;
const REGEX_DATA_URI                 = /^data:/i;
const REGEX_S3_URL                   = /^https?:\/\/(?:.*\.s3[.-]|s3[.-])/;
// ── Track URL resolution ────────────────────────────────────────────────────
export function resolvePlayableSrc(raw) {
```

## lib/track-cache.js
- Summary: (no header comment; see description below)
- Role: Library/helper module used by routes and server; encapsulates domain logic or integrations.

Header/context:
```
/**
 * lib/track-cache.js — Read-through cache wrapper around fmGetRecordById.
 *
 * Why:
 *   /trending and /my-stats both fan out N parallel fmGetRecordById calls to
 *   enrich stream-event stats with track metadata. Many of those tracks are
 *   also fetched by /featured-albums, /new-releases, /public-playlists. This
 *   cache lets those endpoints share the same fetched records so repeat hits
 *   for hot tracks return in microseconds.
 *
 * Concurrency:
 *   Uses an in-flight Map to dedupe concurrent fetches for the same recordId.
```

## lib/file-lock.js
- Summary: (no header comment; see description below)
- Role: Library/helper module used by routes and server; encapsulates domain logic or integrations.

Header/context:
```
/**
 * lib/file-lock.js — Cross-process advisory file locking.
 * Uses O_EXCL (fail-if-exists) to atomically create lockfiles.
 * Stale locks older than LOCK_STALE_MS are automatically broken.
 */
import fs from 'node:fs/promises';
const LOCK_STALE_MS        = 10_000; // treat lock as stale after 10 seconds
const LOCK_RETRY_INTERVAL_MS = 30;
const LOCK_TIMEOUT_MS      = 8_000;
export async function acquireLock(targetPath) {
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
```

## public/app.html
- Summary: (no header comment; see description below)
- Role: Static HTML view served by the Express app; references CSS/JS assets.

Header/context:
```
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>MAD — Music Africa Direct</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/app.css?v=6">
</head>
<body>
```

## public/mobile.html
- Summary: (no header comment; see description below)
- Role: Static HTML view served by the Express app; references CSS/JS assets.

Header/context:
```
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>MASS Mobile</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
```

## public/ringtone.html
- Summary: (no header comment; see description below)
- Role: Static HTML view served by the Express app; references CSS/JS assets.

Header/context:
```
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ringtone Maker</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg:            #0d0d12;
      --surface:       #16161f;
      --surface2:      #1e1e2a;
```

## public/audio-lab.html
- Summary: (no header comment; see description below)
- Role: Static HTML view served by the Express app; references CSS/JS assets.

Header/context:
```
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Digital Cupboard Audio App</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      /* Warm amber — primary accent (replaces cold blue throughout) */
```

## public/app.min.js
- Summary: (no header comment; see description below)
- Role: JavaScript module.

Header/context:
```
    const albumsEl = document.getElementById('albums');
    const loadingIndicator = document.getElementById('loadingIndicator');
    const searchEl = document.getElementById('search');
    const searchArtistEl = document.getElementById('searchArtist');
    const searchAlbumEl = document.getElementById('searchAlbum');
    const searchTrackEl = document.getElementById('searchTrack');
    const clearEl  = document.getElementById('clear');
    const goEl  = document.getElementById('go');
    const aiSearchPanel = document.getElementById('aiSearchPanel');
    const aiSearchToggle = document.getElementById('aiSearchToggle');
    const aiSearchInput = document.getElementById('aiSearchInput');
    const aiSearchButton = document.getElementById('aiSearchButton');
```

## public/js/helpers.js
- Summary: Ensure window.MADHelpers exists
- Role: Front-end JavaScript used by public HTML pages; runs in the browser.

Header/context:
```
/**
 * MADMusic Shared Helper Functions
 * 
 * These functions are extracted from app.html and home.html/albums.html
 * to provide a shared interface for common operations.
 */
// Ensure window.MADHelpers exists
if (!window.MADHelpers) {
  window.MADHelpers = {};
}
/**
 * Get the first matching field value from a list of candidate field names
```

## public/js/auth.js
- Summary: ========= ACCESS TOKEN MANAGEMENT =========
- Role: Front-end JavaScript used by public HTML pages; runs in the browser.

Header/context:
```
  // ========= ACCESS TOKEN MANAGEMENT =========
  // IMPORTANT: This must run BEFORE app.min.js to intercept fetch calls
  (function() {
    const STORAGE_KEY = 'mass_access_token';
    const STORAGE_INFO_KEY = 'mass_access_token_info';
    const SESSION_ID_KEY = 'mass_session_id';
    // ── Paystack callback guard — MUST run before anything else ──────────────
    // If we land here with ?payment=success&token=NEW, save the new token and
    // navigate to the clean pathname BEFORE reading localStorage (which may
    // hold an old expired token).  Using location.replace() is a single atomic
    // navigation — unlike replaceState+reload() there is no window in which the
    // original URL can be re-read, preventing an infinite reload loop in browsers
```

## public/js/player.js
- Summary: public/js/player.js
- Role: Front-end JavaScript used by public HTML pages; runs in the browser.

Header/context:
```
// public/js/player.js
// Player module - manages audio playback, stream events, and shuffle
(function() {
  'use strict';
  // ---- STATE ----
      const itemsStore = new Map();
      let currentAudio = null;
      let currentTrackInfo = null;
      let isPlaying = false;
      // Shuffle queue — populated by startShufflePlay(), cleared by stopShufflePlay()
      let shuffleQueue    = [];
      let shuffleQueueIdx = 0;
```

## public/js/playlists.js
- Summary: public/js/playlists.js
- Role: Front-end JavaScript used by public HTML pages; runs in the browser.

Header/context:
```
// public/js/playlists.js
// Sidebar playlists module - manages user playlist display
(function() {
  'use strict';
  function toggleNavSection(sectionId) {
    const section = document.getElementById(sectionId);
    section.classList.toggle('collapsed');
  }
  // ---- Simple toast helper ----
  function showToast(message, type) {
    let container = document.getElementById('massToastContainer');
    if (!container) {
```

## public/js/catalog.js
- Summary: (no header comment; see description below)
- Role: Front-end JavaScript used by public HTML pages; runs in the browser.

Header/context:
```
(function() {
  'use strict';
  // ---- EXPORTED FUNCTIONS ----
// Initialize Home Page Content (Major Releases & Highlights)
    async function initializeHomePage() {
      try {
        // Fetch featured albums for Major Releases
        const response = await fetch('/api/featured-albums?limit=18');
        if (response.ok) {
          const data = await response.json();
          const items = data.items || [];
          // Transform the data to a cleaner format
```

## public/js/discovery.js
- Summary: (no header comment; see description below)
- Role: Front-end JavaScript used by public HTML pages; runs in the browser.

Header/context:
```
(function() {
  'use strict';
  // ---- DISCOVERY FUNCTIONS ----
  // In-memory trending cache — persists for the lifetime of the page session.
  // Prevents re-fetching the same 24h-server-cached data on every view switch.
  let _trendingItems   = null;
  let _trendingFetched = false;
// Access Token and Payment Handling
    const STORAGE_KEY = 'mass_access_token';
    let accessToken = localStorage.getItem(STORAGE_KEY);
    let selectedPlan     = '7-day'; // Default plan (matches server PAYSTACK_PLANS keys)
    let selectedPlanType = 'one-time'; // 'one-time' | 'subscription' (trial has its own button)
```

## scripts/smoke.js
- Summary: (no header comment; see description below)
- Role: Operational/diagnostic script runnable via npm scripts or Node.

Header/context:
```
#!/usr/bin/env node
const baseUrl = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
async function requestJson(path, label) {
  const url = baseUrl.replace(/\/$/, '') + path;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (err) {
      const parseErr = new Error(`Invalid JSON for ${label}: ${err.message}`);
```

## scripts/generate-access-token.js
- Summary: (no header comment; see description below)
- Role: Operational/diagnostic script runnable via npm scripts or Node.

Header/context:
```
#!/usr/bin/env node
/**
 * Access Token Generator for MASS
 *
 * Usage:
 *   node scripts/generate-access-token.js [options]
 *
 * Options:
 *   --days <number>    Number of days until token expires (default: 7)
 *   --unlimited        Create an unlimited access token (never expires)
 *   --notes <text>     Add notes/description for the token
 *
```
