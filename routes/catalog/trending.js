// routes/catalog/trending.js — /trending, /my-stats
import { Router } from 'express';
import { fmFindRecords, fmGetRecordById } from '../../fm-client.js';
import { trendingCache } from '../../cache.js';
import { hasValidAudio, hasValidArtwork } from '../../lib/track.js';
import { recordIsVisible, FM_LAYOUT, FM_STREAM_EVENTS_LAYOUT } from '../../lib/fm-fields.js';
import { parsePositiveInt, normalizeRecordId, formatTimestampUTC, toCleanString, normalizeSeconds, parseFileMakerTimestamp } from '../../lib/format.js';
import { firstNonEmpty } from '../../lib/fm-fields.js';
import { STREAM_TIME_FIELD } from '../../lib/stream-events.js';

const router = Router();

const TRENDING_LOOKBACK_HOURS = parsePositiveInt(process.env.TRENDING_LOOKBACK_HOURS, 168);
const TRENDING_FETCH_LIMIT    = parsePositiveInt(process.env.TRENDING_FETCH_LIMIT, 400);
const TRENDING_MAX_LIMIT      = parsePositiveInt(process.env.TRENDING_MAX_LIMIT, 20);

// ── Trending helpers ──────────────────────────────────────────────────────────

function buildStatsByTrack(data) {
  const statsByTrack = new Map();
  for (const entry of data) {
    const fields = entry?.fieldData || {};
    const trackRecordId = normalizeRecordId(fields.TrackRecordID || fields['Track Record ID'] || '');
    if (!trackRecordId) continue;
    const totalSeconds = normalizeSeconds(
      fields.TotalPlayedSec ?? fields[STREAM_TIME_FIELD] ?? fields.DurationSec ?? fields.DeltaSec ?? 0
    );
    const lastEventTs = parseFileMakerTimestamp(fields.LastEventUTC || fields.TimestampUTC);
    const sessionId = toCleanString(fields.SessionID || fields['Session ID'] || '');
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
  if (b.playCount !== a.playCount) return b.playCount - a.playCount;
  return b.lastEvent - a.lastEvent;
}

function collectValidResults(fetched, normalizedLimit) {
  const results = [];
  for (const { stat, record } of fetched) {
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
    const detail = `${findResult.msg || 'FM error'}${codeStr}`;
    throw new Error(`Trending stream query failed: ${detail}`);
  }

  const statsByTrack = buildStatsByTrack(findResult.data);
  if (!statsByTrack.size) return [];

  const sortedStats = Array.from(statsByTrack.values()).sort(compareTrendingStats);

  const BATCH_MULTIPLIER = 3;
  const candidates = sortedStats.slice(0, normalizedLimit * BATCH_MULTIPLIER);
  const fetched = await Promise.all(
    candidates.map((stat) =>
      fmGetRecordById(FM_LAYOUT, stat.trackRecordId)
        .then((record) => ({ stat, record }))
        .catch(() => ({ stat, record: null }))
    )
  );

  return collectValidResults(fetched, normalizedLimit);
}

async function fetchTrendingTracks(limit = 5) {
  const normalizedLimit = Math.max(1, Math.min(TRENDING_MAX_LIMIT, limit || 5));
  const baseFetchLimit = Math.min(2000, Math.max(normalizedLimit * 80, TRENDING_FETCH_LIMIT));
  const attempts = [];
  if (TRENDING_LOOKBACK_HOURS > 0) {
    attempts.push({ lookbackHours: TRENDING_LOOKBACK_HOURS, fetchLimit: baseFetchLimit });
  }
  attempts.push({ lookbackHours: 0, fetchLimit: Math.min(2000, baseFetchLimit * 2) });

  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    try {
      const items = await collectTrendingStats({ limit: normalizedLimit, lookbackHours: attempt.lookbackHours, fetchLimit: attempt.fetchLimit });
      if (items.length || i === attempts.length - 1) return items.slice(0, normalizedLimit);
    } catch (err) {
      if (i === attempts.length - 1) throw err;
      console.warn('[TRENDING] Attempt failed (will retry with fallback):', err?.message || err);
    }
  }
  return [];
}

// ── GET /trending ─────────────────────────────────────────────────────────────
router.get('/trending', async (req, res) => {
  try {
    const limitParam = Number.parseInt(req.query.limit || '5', 10);
    const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(TRENDING_MAX_LIMIT, limitParam)) : 5;
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

// ── GET /my-stats ─────────────────────────────────────────────────────────────
router.get('/my-stats', async (req, res) => {
  try {
    const token = (req.query.token || '').toString().trim().toUpperCase();
    if (!token) return res.status(400).json({ ok: false, error: 'token param required' });

    const findResult = await fmFindRecords(
      FM_STREAM_EVENTS_LAYOUT,
      [{ Token_Number: `==${token}` }],
      { limit: 2000, offset: 1 }
    );

    if (!findResult.ok) {
      return res.status(500).json({ ok: false, error: 'Could not fetch stream events' });
    }

    const byTrack = new Map();
    for (const entry of findResult.data || []) {
      const f = entry.fieldData || {};
      const trackId = normalizeRecordId(f.TrackRecordID || f['Track Record ID'] || '');
      if (!trackId) continue;
      const secs = normalizeSeconds(f.TotalPlayedSec ?? f.DeltaSec ?? 0);
      if (!byTrack.has(trackId)) {
        byTrack.set(trackId, { trackId, plays: 0, totalSeconds: 0 });
      }
      const s = byTrack.get(trackId);
      s.plays += 1;
      s.totalSeconds += secs;
    }

    if (byTrack.size === 0) return res.json({ ok: true, tracks: [] });

    const top10 = Array.from(byTrack.values())
      .sort((a, b) => b.plays === a.plays ? b.totalSeconds - a.totalSeconds : b.plays - a.plays)
      .slice(0, 10);

    const withDetails = await Promise.all(
      top10.map(async (s) => {
        try {
          const record = await fmGetRecordById(FM_LAYOUT, s.trackId);
          const f = record?.fieldData || {};
          return {
            trackId: s.trackId,
            plays: s.plays,
            totalSeconds: s.totalSeconds,
            name: firstNonEmpty(f, ['Track Name', 'Tape Files::Track Name', 'Song Title']) || 'Unknown Track',
            artist: f['Album Artist'] || f['Tape Files::Album Artist'] || f['Track Artist'] || 'Unknown Artist',
            album: f['Album Title'] || f['Tape Files::Album Title'] || ''
          };
        } catch {
          return null;
        }
      })
    );

    const tracks = withDetails.filter(Boolean);
    return res.json({ ok: true, tracks });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'my-stats failed' });
  }
});

export default router;
