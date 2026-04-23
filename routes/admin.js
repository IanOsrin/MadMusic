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
  exploreCache,
  albumCache,
  tokenValidationCache,
  streamRecordLRU,
  playlistImageLRU,
  pendingPaymentsCache,
  containerUrlCache,
  trackRecordCache,
} from '../cache.js';
import { listSwrCaches, getSwrCacheByName, flushAllSwrCaches } from '../lib/swr-cache.js';
import { SERVER_START_TIME } from '../lib/server-start-time.js';

const router = Router();

// ── Admin-key guard ───────────────────────────────────────────────────────────

const ADMIN_SECRET = (process.env.ADMIN_SECRET || '').trim();

function requireAdminKey(req, res, next) {
  if (!ADMIN_SECRET) {
    // No secret configured — lock down the endpoint entirely rather than leave it open.
    console.warn('[admin] ADMIN_SECRET not set — rejecting request');
    return res.status(503).json({ ok: false, error: 'Admin endpoints disabled: ADMIN_SECRET not configured' });
  }
  const provided = (req.headers['x-admin-key'] || '').trim();
  if (!provided || provided !== ADMIN_SECRET) {
    console.warn('[admin] Invalid or missing X-Admin-Key');
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  return next();
}

// ── Named cache registry ──────────────────────────────────────────────────────
//
// "content" caches are safe to flush at any time — they only hold search results
// and derived catalog data.  "sensitive" caches (token validation, payments) can
// be flushed explicitly but are excluded from the default "all" flush to avoid
// disrupting active user sessions or creating payment replay windows.

const CONTENT_CACHES = {
  search:         searchCache,
  explore:        exploreCache,
  album:          albumCache,
  containerUrl:   containerUrlCache,
  trackRecord:    trackRecordCache,
  playlistImage:  playlistImageLRU,
};

const SENSITIVE_CACHES = {
  tokenValidation: tokenValidationCache,
  streamRecord:    streamRecordLRU,
  pendingPayments: pendingPaymentsCache,
};

const ALL_CACHES = { ...CONTENT_CACHES, ...SENSITIVE_CACHES };

// Returns a plain stats object for a single LRU cache instance.
function cacheStats(cache) {
  return {
    size:    cache.size,
    max:     cache.max,
    ttlMs:   cache.ttl ?? null,
    fillPct: cache.max > 0 ? +(cache.size / cache.max * 100).toFixed(1) : 0,
  };
}

// ── GET /health ───────────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  const uptimeMs  = Date.now() - SERVER_START_TIME;
  const uptimeSec = Math.floor(uptimeMs / 1000);
  res.json({
    status:    'ok',
    uptime:    uptimeSec,
    timestamp: new Date().toISOString(),
  });
});

// ── GET /health/detailed ──────────────────────────────────────────────────────
// Protected — exposes FM latency, queue depth, and per-cache fill levels.
router.get('/health/detailed', requireAdminKey, async (req, res) => {
  const uptimeMs = Date.now() - SERVER_START_TIME;

  // Probe FM — just ensure we have a valid token (no FM query needed)
  let fmStatus = 'ok';
  let fmLatencyMs = null;
  let fmError = null;
  try {
    const t0 = Date.now();
    await ensureToken();
    fmLatencyMs = Date.now() - t0;
  } catch (err) {
    fmStatus = 'error';
    fmError  = err.message || String(err);
  }

  const queue = fmQueueStats();
  const caches = Object.fromEntries(
    Object.entries(ALL_CACHES).map(([k, c]) => [k, cacheStats(c)])
  );
  const swrCaches = listSwrCaches();

  res.json({
    ok:     fmStatus === 'ok',
    server: {
      status:    'ok',
      uptimeSec: Math.floor(uptimeMs / 1000),
      timestamp: new Date().toISOString(),
    },
    filemaker: {
      status:         fmStatus,
      latencyMs:      fmLatencyMs,
      queueDepth:     queue.queueDepth,
      activeRequests: queue.activeRequests,
      maxConcurrent:  queue.maxConcurrent,
      consecutive401s: queue.consecutive401s,
      ...(fmError ? { error: fmError } : {}),
    },
    caches,
    swrCaches,
  });
});

// ── GET /cache/stats ──────────────────────────────────────────────────────────
router.get('/cache/stats', (req, res) => {
  try {
    const content   = Object.fromEntries(Object.entries(CONTENT_CACHES).map(([k, c])   => [k, cacheStats(c)]));
    const sensitive = Object.fromEntries(Object.entries(SENSITIVE_CACHES).map(([k, c]) => [k, cacheStats(c)]));
    const swr       = listSwrCaches();
    res.json({ ok: true, content, sensitive, swr, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[admin] Failed to retrieve cache stats:', err);
    res.status(500).json({ ok: false, error: 'Failed to retrieve cache stats' });
  }
});

// ── POST /cache/flush ─────────────────────────────────────────────────────────
//
// Query params:
//   ?cache=all            — flush all content caches (sensitive excluded)
//   ?cache=search,album   — flush named caches (comma-separated)
//   ?cache=tokenValidation — flush a sensitive cache by explicit name
//
// Always returns a summary of what was flushed and the sizes before flush.
router.post('/cache/flush', requireAdminKey, (req, res) => {
  try {
    const param = (req.query.cache || 'all').toString().trim();
    // "all" flushes every content cache plus every SWR cache
    // (sensitive caches are skipped to avoid nuking active sessions / payment replay windows).
    if (param.toLowerCase() === 'all') {
      const flushed = [];
      for (const [name, cache] of Object.entries(CONTENT_CACHES)) {
        const size = cache.size;
        cache.clear();
        flushed.push({ name, cleared: size, kind: 'lru' });
      }
      for (const entry of flushAllSwrCaches()) {
        flushed.push({ ...entry, kind: 'swr' });
      }
      const totalCleared = flushed.reduce((sum, f) => sum + f.cleared, 0);
      console.log(`[admin] Flush all — ${totalCleared} entries cleared across ${flushed.length} cache(s)`);
      return res.json({ ok: true, flushed, totalCleared, timestamp: new Date().toISOString() });
    }

    const names = param.split(',').map(s => s.trim()).filter(Boolean);
    const unknown = names.filter(n => !ALL_CACHES[n] && !getSwrCacheByName(n));
    if (unknown.length) {
      return res.status(400).json({
        ok: false,
        error: `Unknown cache name(s): ${unknown.join(', ')}`,
        validLru: Object.keys(ALL_CACHES),
        validSwr: listSwrCaches().map(c => c.name),
      });
    }

    const flushed = [];
    for (const name of names) {
      if (ALL_CACHES[name]) {
        const cache = ALL_CACHES[name];
        const sizeBefore = cache.size;
        cache.clear();
        flushed.push({ name, cleared: sizeBefore, kind: 'lru' });
        console.log(`[admin] LRU cache "${name}" flushed (${sizeBefore} entries cleared)`);
      } else {
        const entry = getSwrCacheByName(name);
        const sizeBefore = entry.cache.size;
        entry.cache.clear();
        flushed.push({ name, cleared: sizeBefore, kind: 'swr' });
        console.log(`[admin] SWR cache "${name}" flushed (${sizeBefore} entries cleared)`);
      }
    }

    const totalCleared = flushed.reduce((sum, f) => sum + f.cleared, 0);
    console.log(`[admin] Flush complete — ${totalCleared} entries cleared across ${flushed.length} cache(s)`);

    res.json({
      ok: true,
      flushed,
      totalCleared,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[admin] Cache flush failed:', err);
    res.status(500).json({ ok: false, error: 'Cache flush failed' });
  }
});

// ── POST /tokens/resync ───────────────────────────────────────────────────────
//
// Pushes any tokens that failed to write to FileMaker at creation time
// (fmSynced=false in the JSON store) back to FM.
// Call this after a FileMaker outage to restore sync.
//
// Usage:
//   curl -X POST https://your-app.onrender.com/api/admin/tokens/resync \
//        -H "X-Admin-Key: <your ADMIN_SECRET>"
//
router.post('/tokens/resync', requireAdminKey, async (req, res) => {
  try {
    // Show a quick count of what's pending before we start
    const tokenData = await loadAccessTokens();
    const pendingCount = tokenData.tokens.filter(t => !t.fmSynced).length;
    console.log(`[admin] Resync requested — ${pendingCount} unsynced token(s) found`);

    const result = await resyncUnsyncedTokens();

    res.json({
      ok:        result.failed === 0,
      ...result,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[admin] Token resync failed:', err);
    res.status(500).json({ ok: false, error: 'Resync failed: ' + (err?.message || String(err)) });
  }
});

// ── POST /tokens/clear-trials ─────────────────────────────────────────────────
// Removes trial-type tokens from the JSON store so those emails can claim again.
// Optional body: { email: "specific@email.com" } to clear one address only.
// Without a body, clears ALL trial records.
router.post('/tokens/clear-trials', requireAdminKey, async (req, res) => {
  try {
    const { email } = req.body || {};
    const tokenData  = await loadAccessTokens();
    const before     = tokenData.tokens.length;

    if (email) {
      const normalised  = email.trim().toLowerCase();
      tokenData.tokens  = tokenData.tokens.filter(
        t => !(t.type === 'trial' && t.email && t.email.toLowerCase() === normalised)
      );
    } else {
      tokenData.tokens = tokenData.tokens.filter(t => t.type !== 'trial');
    }

    const removed = before - tokenData.tokens.length;
    await saveAccessTokens(tokenData);

    console.log(`[admin] Cleared ${removed} trial token(s)${email ? ` for ${email}` : ''}`);
    res.json({ ok: true, removed, remaining: tokenData.tokens.length });
  } catch (err) {
    console.error('[admin] Failed to clear trial tokens:', err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// ── GET /tokens/unsynced ──────────────────────────────────────────────────────
// Returns a list of tokens that haven't been written to FileMaker yet.
// Useful for checking before running a resync.
router.get('/tokens/unsynced', requireAdminKey, async (req, res) => {
  try {
    const tokenData = await loadAccessTokens();
    const unsynced  = tokenData.tokens
      .filter(t => !t.fmSynced)
      .map(({ code, type, email, issuedDate, expirationDate, notes }) =>
        ({ code, type, email, issuedDate, expirationDate, notes })
      );
    res.json({ ok: true, count: unsynced.length, tokens: unsynced });
  } catch (err) {
    console.error('[admin] Failed to list unsynced tokens:', err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

export default router;
