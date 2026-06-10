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
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fmFindRecords } from '../../fm-client.js';
import { hasValidAudio, hasValidArtwork, applyArtworkThumbs } from '../../lib/track.js';
import { recordIsVisible, FM_LAYOUT, FM_STREAM_EVENTS_LAYOUT } from '../../lib/fm-fields.js';
import { parsePositiveInt, normalizeRecordId, formatTimestampUTC, toCleanString, normalizeSeconds, parseFileMakerTimestamp } from '../../lib/format.js';
import { firstNonEmpty } from '../../lib/fm-fields.js';
import { STREAM_TIME_FIELD } from '../../lib/stream-events.js';
import { getTrackRecordCached } from '../../lib/track-cache.js';
import { createSwrCache } from '../../lib/swr-cache.js';
import { createLogger } from '../../lib/logger.js';
import { fmExactMatch } from '../../lib/validators.js';
import { LRUCache } from 'lru-cache';

// In production, never leak internal/FM error detail to public catalogue callers.
const IS_PROD = process.env.NODE_ENV === 'production';
const safeDetail = (detail) => (IS_PROD ? undefined : detail);

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TRENDING_CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'trending-cache.json');

const router = Router();
const log    = createLogger('trending');

const TRENDING_LOOKBACK_HOURS = parsePositiveInt(process.env.TRENDING_LOOKBACK_HOURS, 168);
const TRENDING_FETCH_LIMIT    = parsePositiveInt(process.env.TRENDING_FETCH_LIMIT,    400);
const TRENDING_MAX_LIMIT      = parsePositiveInt(process.env.TRENDING_MAX_LIMIT,      20);
const TRENDING_TTL_MS         = parsePositiveInt(process.env.TRENDING_CACHE_TTL_MS,   24 * 60 * 60 * 1000);

// Per-token cache for /my-stats. The handler otherwise runs a 2000-record
// stream-events _find on every call; a short TTL collapses repeat hits (e.g. a
// user reopening their stats panel) to a single FM round-trip every 5 minutes.
const MY_STATS_TTL_MS = parsePositiveInt(process.env.MY_STATS_CACHE_TTL_MS, 5 * 60 * 1000);
const myStatsCache = new LRUCache({ max: 2000, ttl: MY_STATS_TTL_MS });

// ── Trending helpers ────────────────────────────────────────────────────────

// Maximum seconds we'll credit any single stream-event record toward trending.
// This guards against pre-fix anomaly records (e.g. the 735-hour outlier) that
// still exist in FileMaker and would otherwise skew the aggregated totals.
// For records that have DurationSec, we use 105% of that instead — tracks
// longer than 2 hours (concertos, DJ sets, etc.) are handled correctly.
const TRENDING_MAX_PER_RECORD_SEC = 7200; // 2-hour ceiling for unknown-duration records

function buildStatsByTrack(data) {
  const statsByTrack = new Map();
  for (const entry of data) {
    const fields = entry?.fieldData || {};
    const trackRecordId = normalizeRecordId(fields.TrackRecordID || fields['Track Record ID'] || '');
    if (!trackRecordId) continue;
    const rawTotalSeconds = normalizeSeconds(
      fields.TotalPlayedSec ?? fields[STREAM_TIME_FIELD] ?? fields.DurationSec ?? fields.DeltaSec ?? 0
    );
    // Cap each record's contribution so stale anomaly data can't inflate rankings.
    const durationSec = normalizeSeconds(fields.DurationSec || 0);
    const totalSeconds = durationSec > 0
      ? Math.min(rawTotalSeconds, Math.round(durationSec * 1.05))
      : Math.min(rawTotalSeconds, TRENDING_MAX_PER_RECORD_SEC);
    const lastEventTs = parseFileMakerTimestamp(fields.LastEventUTC || fields.TimestampUTC);
    const sessionId   = toCleanString(fields.SessionID || fields['Session ID'] || '');
    if (!statsByTrack.has(trackRecordId)) {
      statsByTrack.set(trackRecordId, { trackRecordId, totalSeconds: 0, playCount: 0, sessionIds: new Set(), lastEvent: 0 });
    }
    const stat = statsByTrack.get(trackRecordId);
    stat.totalSeconds += totalSeconds || 0;
    stat.playCount += 1;
    if (sessionId) stat.sessionIds.add(sessionId);
    if (lastEventTs > stat.lastEvent) stat.lastEvent = lastEventTs;
  }
  return statsByTrack;
}

function compareTrendingStats(a, b) {
  if (b.totalSeconds !== a.totalSeconds) return b.totalSeconds - a.totalSeconds;
  if (b.playCount    !== a.playCount)    return b.playCount    - a.playCount;
  return b.lastEvent - a.lastEvent;
}

function collectValidResults(fetched, normalizedLimit) {
  const results = [];
  for (const { stat, record } of fetched) {
    if (!record) continue;
    const fields = record.fieldData || {};
    if (!recordIsVisible(fields))  continue;
    if (!hasValidAudio(fields))    continue;
    if (!hasValidArtwork(fields))  continue;
    results.push({
      recordId: record.recordId || stat.trackRecordId,
      modId:    record.modId || '0',
      fields: applyArtworkThumbs({ ...fields }, 300),
      metrics: {
        plays:           stat.playCount,
        uniqueListeners: stat.sessionIds.size || 0,
        lastPlayedAt:    stat.lastEvent ? new Date(stat.lastEvent).toISOString() : null
      }
    });
    if (results.length >= normalizedLimit) break;
  }
  return results;
}

async function collectTrendingStats({ limit, lookbackHours, fetchLimit }) {
  const normalizedLimit = Math.max(1, limit || 5);
  const cutoffDate = lookbackHours && lookbackHours > 0
    ? new Date(Date.now() - lookbackHours * 60 * 60 * 1000)
    : null;
  const baseQuery = { TrackRecordID: '*' };
  if (cutoffDate) baseQuery.LastEventUTC = `>=${formatTimestampUTC(cutoffDate)}`;

  const findResult = await fmFindRecords(
    FM_STREAM_EVENTS_LAYOUT,
    [baseQuery],
    { limit: fetchLimit, offset: 1, sort: [{ fieldName: 'TimestampUTC', sortOrder: 'descend' }] }
  );

  if (!findResult.ok) {
    const codeStr = findResult.code ? ` (FM ${findResult.code})` : '';
    const detail  = `${findResult.msg || 'FM error'}${codeStr}`;
    throw new Error(`Trending stream query failed: ${detail}`);
  }

  const statsByTrack = buildStatsByTrack(findResult.data);
  if (!statsByTrack.size) return [];

  const sortedStats = Array.from(statsByTrack.values()).sort(compareTrendingStats);

  // Fetch a superset of candidates so that tracks failing visibility/audio/artwork
  // filters don't leave us short. 3× limit is usually enough.
  const BATCH_MULTIPLIER = 3;
  const candidates = sortedStats.slice(0, normalizedLimit * BATCH_MULTIPLIER);

  // Route through the shared track-record cache so repeat warm-ups and
  // cross-endpoint overlap don't re-hit FileMaker.
  const fetched = await Promise.all(
    candidates.map((stat) =>
      getTrackRecordCached(FM_LAYOUT, stat.trackRecordId)
        .then((record) => ({ stat, record }))
        .catch(() => ({ stat, record: null }))
    )
  );

  return collectValidResults(fetched, normalizedLimit);
}

async function fetchTrendingTracks(limit = 5) {
  const normalizedLimit = Math.max(1, Math.min(TRENDING_MAX_LIMIT, limit || 5));
  const baseFetchLimit  = Math.min(2000, Math.max(normalizedLimit * 80, TRENDING_FETCH_LIMIT));
  const attempts = [];
  if (TRENDING_LOOKBACK_HOURS > 0) {
    attempts.push({ lookbackHours: TRENDING_LOOKBACK_HOURS, fetchLimit: baseFetchLimit });
  }
  attempts.push({ lookbackHours: 0, fetchLimit: Math.min(2000, baseFetchLimit * 2) });

  // Fall back to the no-lookback attempt whenever the first pass is *short*,
  // not just empty. Otherwise one quiet day could lock the rail to e.g. 1 item
  // for the full SWR window (24 h). The fallback pulls from the full stream-
  // events history so the rail self-heals when recent activity is sparse.
  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    try {
      const items = await collectTrendingStats({
        limit:         normalizedLimit,
        lookbackHours: attempt.lookbackHours,
        fetchLimit:    attempt.fetchLimit
      });
      const haveEnough = items.length >= normalizedLimit;
      if (haveEnough || i === attempts.length - 1) return items.slice(0, normalizedLimit);
      log.warn(`Attempt ${i + 1} returned ${items.length}/${normalizedLimit} items — falling through to next attempt`);
    } catch (err) {
      if (i === attempts.length - 1) throw err;
      log.warn('Attempt failed (will retry with fallback):', err?.message || err);
    }
  }
  return [];
}

// Minimum items we'll treat as a "good" trending result worth caching for the
// full SWR window. Anything thinner gets returned to the caller (so the user
// sees *something*) but the cache entry is dropped so the next request runs
// the loader again instead of serving the thin snapshot for 24 h.
const TRENDING_MIN_USEFUL_RESULTS = 3;

// ── Disk persistence ────────────────────────────────────────────────────────
// The SWR cache lives in process memory and dies on every restart. Persist
// the result to data/trending-cache.json so the next boot picks up where
// we left off and no user pays the cold-FM cost again until the 24h TTL
// genuinely lapses.
//
// File shape:
//   { savedAt: <ms>, entries: [ { key, items, storedAt } ] }
//
// Writes are atomic via temp-file + rename so a crash mid-write can't leave
// a half-written file.

async function readTrendingFromDisk() {
  try {
    const raw = await fsp.readFile(TRENDING_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`trending-cache.json read failed: ${err.message}`);
    return null;
  }
}

async function writeTrendingToDisk(key, items) {
  try {
    // Merge with whatever's already on disk so different limits coexist.
    const existing = await readTrendingFromDisk();
    const entries  = (existing?.entries || []).filter((e) => e.key !== key);
    entries.push({ key, items, storedAt: Date.now() });

    const payload = JSON.stringify({ savedAt: Date.now(), entries });
    const tmpPath = `${TRENDING_CACHE_FILE}.tmp.${process.pid}`;

    await fsp.mkdir(path.dirname(TRENDING_CACHE_FILE), { recursive: true });
    await fsp.writeFile(tmpPath, payload, 'utf8');
    await fsp.rename(tmpPath, TRENDING_CACHE_FILE);
    log.debug(`Persisted trending (key=${key}, ${items.length} items) to disk`);
  } catch (err) {
    log.warn(`trending-cache.json write failed: ${err.message}`);
  }
}

// ── SWR cache around /trending ──────────────────────────────────────────────
// Key includes limit because different callers ask for different top-N sizes.
const trendingSwr = createSwrCache({
  ttlMs: TRENDING_TTL_MS,
  max:   10, // caps the number of distinct limit values we cache
  label: 'trending',
  name:  'trending',
  loader: async (key) => {
    const limit = Number(key.split(':')[1]) || 5;
    log.debug(`Loading trending (limit=${limit})`);
    const items = await fetchTrendingTracks(limit);
    log.debug(`Loaded ${items.length} trending tracks`);
    // Persist usable results so restarts don't reset every user to cold cache.
    if (items.length >= TRENDING_MIN_USEFUL_RESULTS) {
      writeTrendingToDisk(key, items).catch(() => { /* logged inside writer */ });
    }
    return items;
  }
});

// Seed the SWR cache synchronously on module load. Blocks the import for a few
// ms while it reads ~50 KB of JSON, then the route is immediately ready to
// serve from cache. If the file doesn't exist (first ever boot, or it was
// cleared), this is a silent no-op and the cache fills on first request as
// before.
(function seedFromDisk() {
  try {
    const raw = fs.readFileSync(TRENDING_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.entries)) return;
    let seeded = 0;
    for (const { key, items, storedAt } of parsed.entries) {
      if (!key || !Array.isArray(items)) continue;
      trendingSwr.cache.set(key, { value: items, storedAt: storedAt || 0 });
      seeded += 1;
    }
    if (seeded) log.debug(`Seeded ${seeded} trending entries from disk`);
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`trending-cache.json seed failed: ${err.message}`);
  }
})();

export const trendingWarmer = (limit = 20) => trendingSwr.get(`trending:${limit}`);

// ── GET /trending ───────────────────────────────────────────────────────────
router.get('/trending', async (req, res) => {
  try {
    const limitParam = Number.parseInt(req.query.limit || '5', 10);
    const limit      = Number.isFinite(limitParam) ? Math.max(1, Math.min(TRENDING_MAX_LIMIT, limitParam)) : 5;
    const refresh    = req.query.refresh === '1';
    const key        = `trending:${limit}`;
    if (refresh) trendingSwr.cache.delete(key);

    const { value: items, state } = await trendingSwr.get(key);
    res.setHeader('X-Cache-State', state);
    // User-agnostic catalogue data — short shared cache (see featured.js note).
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');

    // Self-healing guard: if the result is too thin to be useful (e.g. FM
    // was briefly slow, returned a partial batch, or only one track passed
    // the visibility/audio/artwork filters), drop the cache entry so the
    // *next* request triggers a fresh load instead of serving this snapshot
    // for the full 24 h SWR window. The current caller still gets `items`.
    const useful = Math.min(TRENDING_MIN_USEFUL_RESULTS, limit);
    if (items.length < useful) {
      log.warn(`Thin trending result (${items.length}/${limit}) — invalidating cache so next request retries`);
      trendingSwr.cache.delete(key);
      res.setHeader('X-Cache-Invalidated', 'thin-result');
    }

    res.json({ items });
  } catch (err) {
    log.error('Failed to load trending tracks:', err);
    const detail = err?.message || 'Trending lookup failed';
    res.status(500).json({ error: IS_PROD ? 'Failed to load trending tracks' : (detail || 'Failed to load trending tracks') });
  }
});

// ── GET /my-stats ───────────────────────────────────────────────────────────
router.get('/my-stats', async (req, res) => {
  try {
    // Use the AUTHENTICATED token from the /api/ middleware (req.accessToken),
    // never a caller-supplied ?token= — that was an IDOR (any caller could read
    // any token's listening history) and leaked the token in the URL.
    const token = (req.accessToken?.code || '').toString().trim().toUpperCase();
    if (!token) return res.status(403).json({ ok: false, error: 'Authentication required' });

    const cached = myStatsCache.get(token);
    if (cached) {
      res.setHeader('X-Cache-State', 'fresh');
      return res.json({ ok: true, tracks: cached });
    }

    const findResult = await fmFindRecords(
      FM_STREAM_EVENTS_LAYOUT,
      [{ Token_Number: fmExactMatch(req.accessToken.code) }],
      { limit: 2000, offset: 1 }
    );

    if (!findResult.ok) {
      return res.status(500).json({ ok: false, error: 'Could not fetch stream events' });
    }

    const byTrack = new Map();
    for (const entry of findResult.data || []) {
      const f       = entry.fieldData || {};
      const trackId = normalizeRecordId(f.TrackRecordID || f['Track Record ID'] || '');
      if (!trackId) continue;
      const secs = normalizeSeconds(f.TotalPlayedSec ?? f.DeltaSec ?? 0);
      if (!byTrack.has(trackId)) {
        byTrack.set(trackId, { trackId, plays: 0, totalSeconds: 0 });
      }
      const s = byTrack.get(trackId);
      s.plays        += 1;
      s.totalSeconds += secs;
    }

    if (byTrack.size === 0) return res.json({ ok: true, tracks: [] });

    const top10 = Array.from(byTrack.values())
      .sort((a, b) => b.plays === a.plays ? b.totalSeconds - a.totalSeconds : b.plays - a.plays)
      .slice(0, 10);

    // Cached track lookups — repeat calls for the same user's top tracks hit memory.
    const withDetails = await Promise.all(
      top10.map(async (s) => {
        try {
          const record = await getTrackRecordCached(FM_LAYOUT, s.trackId);
          const f = record?.fieldData || {};
          return {
            trackId:      s.trackId,
            plays:        s.plays,
            totalSeconds: s.totalSeconds,
            name:   firstNonEmpty(f, ['Track Name', 'Tape Files::Track Name', 'Song Title']) || 'Unknown Track',
            artist: firstNonEmpty(f, ['Track Artist', 'Album Artist', 'Tape Files::Album Artist', 'Artist']) || 'Unknown Artist',
            album:  f['Album Title']  || f['Tape Files::Album Title']  || ''
          };
        } catch {
          return null;
        }
      })
    );

    const tracks = withDetails.filter(Boolean);
    myStatsCache.set(token, tracks);
    return res.json({ ok: true, tracks });
  } catch (err) {
    return res.status(500).json({ ok: false, error: IS_PROD ? 'my-stats failed' : (err.message || 'my-stats failed') });
  }
});

export default router;
