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
import { hasValidAudio, hasValidArtwork } from '../../lib/track.js';
import {
  recordIsVisible, recordIsFeatured, isMissingFieldError,
  FM_LAYOUT, FM_FEATURED_VALUE, FEATURED_FIELD_CANDIDATES,
  G100_FIELD_CANDIDATES, G100_VALUE, G100_VALUE_LC
} from '../../lib/fm-fields.js';
import { parsePositiveInt } from '../../lib/format.js';
import { createSwrCache } from '../../lib/swr-cache.js';
import { createLogger } from '../../lib/logger.js';

const router = Router();
const log    = createLogger('featured');

// Aggressive TTLs — SWR serves stale instantly while refreshing in background.
const FEATURED_TTL_MS     = parsePositiveInt(process.env.FEATURED_ALBUM_CACHE_TTL_MS, 10 * 60 * 1000);
const NEW_RELEASES_TTL_MS = parsePositiveInt(process.env.NEW_RELEASES_CACHE_TTL_MS,   10 * 60 * 1000);
const G100_TTL_MS         = parsePositiveInt(process.env.G100_CACHE_TTL_MS,           10 * 60 * 1000);

const NEW_RELEASES_FIELD_CANDIDATES = ['Tape Files::New_Release', 'New_Release'];
const NEW_RELEASES_VALUE            = 'Yes';

// Track which field candidate last succeeded so we skip the probe on steady state.
let cachedFeaturedFieldName = null;
let cachedG100FieldName     = null;

function cloneRecordsForLimit(records = [], count = records.length) {
  return records.slice(0, Math.min(count, records.length)).map((record) => ({
    recordId: record.recordId,
    modId:    record.modId,
    fields:   { ...(record.fields || record.fieldData || {}) }
  }));
}

// ── Featured album fetch ────────────────────────────────────────────────────
async function fetchFeaturedAlbumRecords(limit = 400) {
  if (!FEATURED_FIELD_CANDIDATES.length) return [];
  const normalizedLimit = Math.max(1, Math.min(1000, limit));

  const tryField = async (field) => {
    if (!field) return null;
    const query = { [field]: FM_FEATURED_VALUE };
    const payload = { query: [query], limit: normalizedLimit, offset: 1 };
    try {
      const response = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, payload);
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (isMissingFieldError(json)) return null;
        const fmCode = json?.messages?.[0]?.code;
        if (String(fmCode) === '401') return null;
        const msg = json?.messages?.[0]?.message || 'FM error';
        log.warn('Album fetch failed', { field, status: response.status, msg, code: fmCode });
        return [];
      }
      const rawData = json?.response?.data || [];
      const filtered = rawData
        .filter(record => recordIsVisible(record.fieldData || {}))
        .filter(record => hasValidAudio(record.fieldData || {}))
        .filter(record => hasValidArtwork(record.fieldData || {}))
        .filter(record => recordIsFeatured(record.fieldData || {}));
      if (filtered.length) {
        log.debug(`Field "${field}" returned ${filtered.length}/${rawData.length} records`);
        cachedFeaturedFieldName = field;
        return filtered;
      }
      return null;
    } catch (err) {
      log.warn(`Fetch threw for field "${field}"`, err?.message || err);
      return null;
    }
  };

  if (cachedFeaturedFieldName) {
    const result = await tryField(cachedFeaturedFieldName);
    if (result?.length > 0) return result;
    cachedFeaturedFieldName = null;
  }

  for (const field of FEATURED_FIELD_CANDIDATES) {
    const result = await tryField(field);
    if (result?.length > 0) return result;
    if (Array.isArray(result) && result.length === 0) return [];
  }
  return [];
}

// ── New-releases fetch ──────────────────────────────────────────────────────
async function tryNewReleaseField(field, normalizedLimit) {
  const query   = { [field]: NEW_RELEASES_VALUE };
  const payload = { query: [query], limit: normalizedLimit, offset: 1 };
  log.debug(`Trying field "${field}"`);
  const response = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, payload);
  const json     = await response.json().catch(() => ({}));
  const fmCode   = String(json?.messages?.[0]?.code ?? '');
  if (!response.ok) {
    if (isMissingFieldError(json) || fmCode === '401') return null;
    log.warn(`Field "${field}" HTTP ${response.status} code=${fmCode}`);
    return null;
  }
  const rawData  = json?.response?.data || [];
  const filtered = rawData.filter(r => recordIsVisible(r.fieldData || {}));
  if (filtered.length > 0) {
    log.debug(`Field "${field}" → ${filtered.length} records`);
    return filtered;
  }
  return null;
}

async function fetchNewReleaseRecords(limit = 200) {
  const normalizedLimit = Math.max(1, Math.min(1000, limit));
  for (const field of NEW_RELEASES_FIELD_CANDIDATES) {
    if (!field) continue;
    try {
      const result = await tryNewReleaseField(field, normalizedLimit);
      if (result !== null) return result;
    } catch (err) {
      log.warn(`Fetch threw for field "${field}"`, err?.message || err);
    }
  }
  return [];
}

// ── G100 fetch ──────────────────────────────────────────────────────────────
async function fetchG100Records(limit = 400) {
  const normalizedLimit = Math.max(1, Math.min(1000, limit));

  const tryField = async (field) => {
    const query   = { [field]: G100_VALUE };
    const payload = { query: [query], limit: normalizedLimit, offset: 1 };
    try {
      const response = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, payload);
      const json     = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (isMissingFieldError(json)) return null;
        const fmCode = json?.messages?.[0]?.code;
        if (String(fmCode) === '401') return null;
        log.warn('G100 fetch failed', { field, status: response.status });
        return null;
      }
      const rawData      = json?.response?.data || [];
      const afterAudio   = rawData.filter(r => hasValidAudio(r.fieldData || {}));
      const afterArtwork = afterAudio.filter(r => hasValidArtwork(r.fieldData || {}));
      const filtered     = afterArtwork.filter(r => {
        const val = (r.fieldData?.[field] || '').toLowerCase().trim();
        return val === G100_VALUE_LC;
      });
      log.debug(`G100 field "${field}" → audio:${afterAudio.length} artwork:${afterArtwork.length} match:${filtered.length}`);
      if (filtered.length) {
        cachedG100FieldName = field;
        return filtered;
      }
      return null;
    } catch (err) {
      log.warn(`G100 fetch threw for field "${field}"`, err?.message || err);
      return null;
    }
  };

  if (cachedG100FieldName) {
    const result = await tryField(cachedG100FieldName);
    if (result?.length > 0) return result;
    cachedG100FieldName = null;
  }

  for (const field of G100_FIELD_CANDIDATES) {
    const result = await tryField(field);
    if (result?.length > 0) return result;
  }
  return [];
}

// ── SWR caches ──────────────────────────────────────────────────────────────
// One cache entry per endpoint (key = 'default'). Loader returns the full
// materialised list; route handlers slice to the requested limit.

const featuredSwr = createSwrCache({
  ttlMs: FEATURED_TTL_MS,
  max:   4,
  label: 'featured',
  name:  'featured',
  loader: async () => {
    const records = await fetchFeaturedAlbumRecords(400);
    log.debug(`Loaded ${records.length} featured albums`);
    return records.map(r => ({ recordId: r.recordId, modId: r.modId, fields: r.fieldData || {} }));
  }
});

const newReleasesSwr = createSwrCache({
  ttlMs: NEW_RELEASES_TTL_MS,
  max:   4,
  label: 'new-releases',
  name:  'newReleases',
  loader: async () => {
    const records = await fetchNewReleaseRecords(1000);
    // Dedupe by album-artist + album-title so we don't return every track of an album.
    const seen    = new Set();
    const deduped = [];
    for (const r of records) {
      const f      = r.fieldData || {};
      const artist = (f['Album Artist'] || f['Tape Files::Album Artist'] || '').toLowerCase().trim();
      const album  = (f['Album Title']  || f['Tape Files::Album_Title']  || '').toLowerCase().trim();
      const key    = album ? `${artist}|||${album}` : r.recordId;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(r);
    }
    log.debug(`New releases: ${deduped.length} unique albums from ${records.length} tracks`);
    return deduped.map(r => ({ recordId: r.recordId, modId: r.modId, fields: r.fieldData || {} }));
  }
});

const g100Swr = createSwrCache({
  ttlMs: G100_TTL_MS,
  max:   4,
  label: 'g100',
  name:  'g100',
  loader: async () => {
    const records = await fetchG100Records(400);
    log.debug(`Loaded ${records.length} G100 albums`);
    return records.map(r => ({ recordId: r.recordId, modId: r.modId, fields: r.fieldData || {} }));
  }
});

// Export SWR caches + loaders so the cluster pre-warm step can prime them
// without needing to hit the HTTP layer.
export const featuredWarmers = {
  featured:    () => featuredSwr.get('default'),
  newReleases: () => newReleasesSwr.get('default'),
  g100:        () => g100Swr.get('default')
};

// ── Route: GET /featured-albums ─────────────────────────────────────────────
router.get('/featured-albums', async (req, res) => {
  try {
    const limit   = Math.max(1, Math.min(1000, Number.parseInt(req.query.limit || '400', 10)));
    const refresh = req.query.refresh === '1';
    if (refresh) featuredSwr.cache.delete('default');

    const { value: items, state } = await featuredSwr.get('default');
    res.setHeader('X-Cache-State', state);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.json({ ok: true, items: cloneRecordsForLimit(items, limit), total: items.length });
  } catch (err) {
    log.error('Failed to load featured albums', err);
    return res.status(500).json({ ok: false, error: 'Failed to load featured albums' });
  }
});

// ── Route: GET /releases/latest ─────────────────────────────────────────────
router.get('/releases/latest', async (req, res) => {
  try {
    const limit   = Math.max(1, Math.min(1000, Number.parseInt(req.query.limit || '1', 10)));
    const refresh = req.query.refresh === '1';
    if (refresh) featuredSwr.cache.delete('default');

    const { value: items, state } = await featuredSwr.get('default');
    res.setHeader('X-Cache-State', state);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.json({ ok: true, items: cloneRecordsForLimit(items, limit), total: items.length });
  } catch (err) {
    log.error('Failed to load latest releases', err);
    return res.status(500).json({ ok: false, error: 'Failed to load latest releases' });
  }
});

// ── Route: GET /new-releases ────────────────────────────────────────────────
router.get('/new-releases', async (req, res) => {
  try {
    const limit   = Math.max(1, Math.min(100, Number.parseInt(req.query.limit || '20', 10)));
    const refresh = req.query.refresh === '1';
    if (refresh) newReleasesSwr.cache.delete('default');

    const { value: items, state } = await newReleasesSwr.get('default');
    res.setHeader('X-Cache-State', state);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.json({ ok: true, items: cloneRecordsForLimit(items, limit), total: items.length });
  } catch (err) {
    log.error('Failed to load new releases', err);
    return res.status(500).json({ ok: false, error: 'Failed to load new releases' });
  }
});

// ── Route: GET /g100-albums ─────────────────────────────────────────────────
router.get('/g100-albums', async (req, res) => {
  try {
    const limit   = Math.max(1, Math.min(200, Number.parseInt(req.query.limit || '100', 10)));
    const refresh = req.query.refresh === '1';
    if (refresh) g100Swr.cache.delete('default');

    const { value: items, state } = await g100Swr.get('default');
    res.setHeader('X-Cache-State', state);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.json({ ok: true, items: cloneRecordsForLimit(items, limit), total: items.length });
  } catch (err) {
    log.error('G100 failed', err);
    return res.status(500).json({ ok: false, error: 'Failed to load G100 albums' });
  }
});

export default router;
