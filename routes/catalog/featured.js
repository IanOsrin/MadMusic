// routes/catalog/featured.js — /featured-albums, /releases/latest, /new-releases, /g100-albums
import { Router } from 'express';
import { fmPost } from '../../fm-client.js';
import { hasValidAudio, hasValidArtwork } from '../../lib/track.js';
import {
  recordIsVisible, recordIsFeatured, isMissingFieldError,
  FM_LAYOUT, FM_FEATURED_VALUE, FEATURED_FIELD_CANDIDATES,
  G100_FIELD_CANDIDATES, G100_VALUE, G100_VALUE_LC
} from '../../lib/fm-fields.js';
import { parsePositiveInt } from '../../lib/format.js';

const router = Router();

const FEATURED_ALBUM_CACHE_TTL_MS   = parsePositiveInt(process.env.FEATURED_ALBUM_CACHE_TTL_MS, 30 * 1000);
const NEW_RELEASES_CACHE_TTL_MS     = 60 * 1000; // 1 min
const NEW_RELEASES_FIELD_CANDIDATES = ['Tape Files::New_Release', 'New_Release'];
const NEW_RELEASES_VALUE            = 'Yes';

// ── Featured helpers ──────────────────────────────────────────────────────────

let featuredAlbumCache    = { items: [], total: 0, updatedAt: 0 };
let cachedFeaturedFieldName = null;
let newReleasesCache      = { items: [], total: 0, updatedAt: 0 };

function cloneRecordsForLimit(records = [], count = records.length) {
  return records.slice(0, Math.min(count, records.length)).map((record) => ({
    recordId: record.recordId,
    modId: record.modId,
    fields: { ...(record.fieldData || record.fields) }
  }));
}

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
        console.warn('[featured] Album fetch failed', { field, status: response.status, msg, code: fmCode });
        return [];
      }
      const rawData = json?.response?.data || [];
      const filtered = rawData
        .filter(record => recordIsVisible(record.fieldData || {}))
        .filter(record => hasValidAudio(record.fieldData || {}))
        .filter(record => hasValidArtwork(record.fieldData || {}))
        .filter(record => recordIsFeatured(record.fieldData || {}));
      if (filtered.length) {
        console.log(`[featured] Field "${field}" returned ${filtered.length}/${rawData.length} records`);
        cachedFeaturedFieldName = field;
        return filtered;
      }
      return null;
    } catch (err) {
      console.warn(`[featured] Fetch threw for field "${field}"`, err);
      return null;
    }
  };

  if (cachedFeaturedFieldName) {
    console.log(`[featured] Trying cached field: "${cachedFeaturedFieldName}"`);
    const result = await tryField(cachedFeaturedFieldName);
    if (result?.length > 0) return result;
    console.warn(`[featured] Cached field "${cachedFeaturedFieldName}" failed, trying all candidates`);
    cachedFeaturedFieldName = null;
  }

  for (const field of FEATURED_FIELD_CANDIDATES) {
    const result = await tryField(field);
    if (result?.length > 0) return result;
    if (Array.isArray(result) && result.length === 0) return [];
  }
  return [];
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
    return { items: cloneRecordsForLimit(featuredAlbumCache.items, limit), total: featuredAlbumCache.total };
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
  if (items.length > 0) {
    console.log('[featured] Sample albums:');
    items.slice(0, 5).forEach((item, i) => {
      const title = item.fields['Album Title'] || item.fields['Tape Files::Album_Title'] || 'Unknown';
      const artist = item.fields['Album Artist'] || item.fields['Tape Files::Album Artist'] || 'Unknown';
      const featuredValue = item.fields['Tape Files::featured'] || item.fields['featured'] || 'N/A';
      console.log(`[featured]   ${i + 1}. "${title}" by ${artist} (featured=${featuredValue})`);
    });
  }

  featuredAlbumCache = { items, total: items.length, updatedAt: now };
  return { items: cloneRecordsForLimit(items, limit), total: items.length };
}

// ── New-releases helpers ──────────────────────────────────────────────────────

async function tryNewReleaseField(field, normalizedLimit) {
  const query = { [field]: NEW_RELEASES_VALUE };
  const payload = { query: [query], limit: normalizedLimit, offset: 1 };
  console.log(`[new-releases] Trying field "${field}" with query:`, JSON.stringify(query));
  const response = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, payload);
  const json = await response.json().catch(() => ({}));
  const fmCode = String(json?.messages?.[0]?.code ?? '');
  const fmMsg  = json?.messages?.[0]?.message ?? '';
  if (!response.ok) {
    console.log(`[new-releases] Field "${field}" HTTP ${response.status} code=${fmCode} msg=${fmMsg}`);
    if (isMissingFieldError(json)) { console.log(`[new-releases] Field "${field}" missing, skipping`); }
    else if (fmCode === '401') { console.log(`[new-releases] Field "${field}" returned 0 matches (401)`); }
    return null;
  }
  const rawData = json?.response?.data || [];
  console.log(`[new-releases] Field "${field}" raw=${rawData.length} records`);
  if (rawData.length > 0) {
    const sample = rawData[0]?.fieldData || {};
    const nrValue    = sample['Tape Files::New_Release'] ?? sample['New_Release'] ?? '(not present)';
    const albumTitle = sample['Album Title'] || sample['Tape Files::Album_Title'] || '(unknown)';
    console.log(`[new-releases] Sample record — album="${albumTitle}", New_Release value="${nrValue}"`);
    console.log(`[new-releases] Sample record field keys: ${Object.keys(sample).join(', ')}`);
  }
  const filtered = rawData.filter(r => recordIsVisible(r.fieldData || {}));
  console.log(`[new-releases] After visibility filter: ${filtered.length}`);
  if (filtered.length > 0) {
    console.log(`[new-releases] SUCCESS — returning ${filtered.length} records via field "${field}"`);
    const titles = filtered.map(r => r.fieldData?.['Album Title'] || r.fieldData?.['Tape Files::Album_Title'] || r.recordId).slice(0, 10);
    console.log(`[new-releases] Matched albums: ${titles.join(' | ')}`);
    return filtered;
  }
  return null;
}

async function fetchNewReleaseRecords(limit = 200) {
  const normalizedLimit = Math.max(1, Math.min(1000, limit));
  console.log(`[new-releases] Searching Tape Files::New_Release == "${NEW_RELEASES_VALUE}"`);

  for (const field of NEW_RELEASES_FIELD_CANDIDATES) {
    if (!field) continue;
    try {
      const result = await tryNewReleaseField(field, normalizedLimit);
      if (result !== null) return result;
    } catch (err) {
      console.warn(`[new-releases] Fetch threw for field "${field}"`, err);
    }
  }
  console.warn('[new-releases] All field candidates exhausted — returning []');
  return [];
}

async function loadNewReleases({ limit = 200, refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && newReleasesCache.items.length && now - newReleasesCache.updatedAt < NEW_RELEASES_CACHE_TTL_MS) {
    return { items: cloneRecordsForLimit(newReleasesCache.items, limit), total: newReleasesCache.total };
  }

  const records = await fetchNewReleaseRecords(1000);

  const seenAlbums = new Set();
  const deduped = [];
  for (const r of records) {
    const f = r.fieldData || {};
    const artist = (f['Album Artist'] || f['Tape Files::Album Artist'] || '').toLowerCase().trim();
    const album  = (f['Album Title']  || f['Tape Files::Album_Title']  || '').toLowerCase().trim();
    const key = album ? `${artist}|||${album}` : r.recordId;
    if (seenAlbums.has(key)) continue;
    seenAlbums.add(key);
    deduped.push(r);
  }

  console.log(`[new-releases] After album dedup: ${deduped.length} unique albums from ${records.length} tracks`);
  const items = deduped.map(r => ({ recordId: r.recordId, modId: r.modId, fields: r.fieldData || {} }));
  newReleasesCache = { items, total: items.length, updatedAt: now };
  console.log(`[new-releases] Cached ${items.length} records`);
  return { items: cloneRecordsForLimit(items, limit), total: items.length };
}

// ── GET /featured-albums ──────────────────────────────────────────────────────
router.get('/featured-albums', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(1000, Number.parseInt(req.query.limit || '400', 10)));
    const refresh = req.query.refresh === '1';
    console.log(`[featured] GET /api/featured-albums limit=${limit} refresh=${refresh}`);
    const result = await loadFeaturedAlbumRecords({ limit, refresh });
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.json({ ok: true, items: result.items, total: result.total });
  } catch (err) {
    console.error('[featured] Failed to load albums', err);
    return res.status(500).json({ ok: false, error: 'Failed to load featured albums' });
  }
});

// ── GET /releases/latest ──────────────────────────────────────────────────────
router.get('/releases/latest', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(1000, Number.parseInt(req.query.limit || '1', 10)));
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

// ── GET /new-releases ─────────────────────────────────────────────────────────
router.get('/new-releases', async (req, res) => {
  try {
    const limit   = Math.max(1, Math.min(100, Number.parseInt(req.query.limit || '20', 10)));
    const refresh = req.query.refresh === '1';
    const result  = await loadNewReleases({ limit, refresh });
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.json({ ok: true, items: result.items, total: result.total });
  } catch (err) {
    console.error('[new-releases] Failed', err);
    return res.status(500).json({ ok: false, error: 'Failed to load new releases' });
  }
});

// ── G100 helpers ──────────────────────────────────────────────────────────────

let g100Cache = { items: [], total: 0, updatedAt: 0 };
let cachedG100FieldName = null;
let g100RefreshInFlight = false;
const G100_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function fetchG100Records(limit = 400) {
  const normalizedLimit = Math.max(1, Math.min(1000, limit));

  const tryField = async (field) => {
    const query = { [field]: G100_VALUE };
    const payload = { query: [query], limit: normalizedLimit, offset: 1 };
    try {
      const response = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, payload);
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (isMissingFieldError(json)) return null;
        const fmCode = json?.messages?.[0]?.code;
        if (String(fmCode) === '401') return null;
        // Transient FM error — return null (not []) so other field candidates are still tried
        console.warn('[g100] Fetch failed', { field, status: response.status });
        return null;
      }
      const rawData = json?.response?.data || [];
      console.log(`[g100] Field "${field}" raw=${rawData.length} records`);
      if (rawData.length > 0) {
        const sample = rawData[0]?.fieldData || {};
        const g100Val = sample[field] ?? '(field not present)';
        const albumTitle = sample['Album Title'] || sample['Tape Files::Album_Title'] || '(unknown)';
        console.log(`[g100] Sample — album="${albumTitle}", ${field}="${g100Val}" (type: ${typeof g100Val})`);
        console.log(`[g100] Sample field keys with G100: ${Object.keys(sample).filter(k => /g100/i.test(k)).join(', ') || 'none found'}`);
      }
      const afterAudio   = rawData.filter(r => hasValidAudio(r.fieldData || {}));
      const afterArtwork = afterAudio.filter(r => hasValidArtwork(r.fieldData || {}));
      const filtered = afterArtwork.filter(r => {
          const val = (r.fieldData?.[field] || '').toLowerCase().trim();
          return val === G100_VALUE_LC;
        });
      console.log(`[g100] After filters — audio:${afterAudio.length} artwork:${afterArtwork.length} g100match:${filtered.length}`);
      if (filtered.length) {
        console.log(`[g100] Field "${field}" returned ${filtered.length}/${rawData.length} records`);
        cachedG100FieldName = field;
        return filtered;
      }
      return null;
    } catch (err) {
      console.warn(`[g100] Fetch threw for field "${field}"`, err);
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
    // null means "field not found or transient error" — continue to next candidate
  }
  return [];
}

async function loadG100Albums({ limit = 400, refresh = false } = {}) {
  const now = Date.now();
  const cacheAge = now - g100Cache.updatedAt;
  const cacheValid = g100Cache.items.length > 0 && cacheAge < G100_CACHE_TTL_MS;

  // Serve from cache if still fresh
  if (!refresh && cacheValid) {
    return { items: g100Cache.items.slice(0, limit), total: g100Cache.total };
  }

  // If stale cache exists but a refresh is already in flight, serve stale to avoid piling up requests
  if (!refresh && g100Cache.items.length > 0 && g100RefreshInFlight) {
    console.log('[g100] Refresh in flight — serving stale cache');
    return { items: g100Cache.items.slice(0, limit), total: g100Cache.total };
  }

  // If stale cache exists (but no refresh in flight), kick off background refresh and serve stale immediately
  if (!refresh && g100Cache.items.length > 0 && !g100RefreshInFlight) {
    console.log('[g100] Cache stale — serving stale data and refreshing in background');
    g100RefreshInFlight = true;
    fetchG100Records(400)
      .then(records => {
        if (records.length > 0) {
          const items = records.map(r => ({ recordId: r.recordId, modId: r.modId, fields: r.fieldData || {} }));
          g100Cache = { items, total: items.length, updatedAt: Date.now() };
          console.log(`[g100] Background refresh complete — cached ${items.length} albums`);
        } else {
          // Keep existing cache rather than replacing with empty
          console.warn('[g100] Background refresh returned 0 records — keeping existing cache');
          g100Cache = { ...g100Cache, updatedAt: Date.now() };
        }
      })
      .catch(err => console.error('[g100] Background refresh failed', err))
      .finally(() => { g100RefreshInFlight = false; });
    return { items: g100Cache.items.slice(0, limit), total: g100Cache.total };
  }

  // No cache yet (first load) — must fetch synchronously
  g100RefreshInFlight = true;
  try {
    const records = await fetchG100Records(400);
    if (records.length > 0) {
      const items = records.map(r => ({ recordId: r.recordId, modId: r.modId, fields: r.fieldData || {} }));
      g100Cache = { items, total: items.length, updatedAt: Date.now() };
      console.log(`[g100] Cached ${items.length} G100 albums`);
      return { items: items.slice(0, limit), total: items.length };
    }
    // FM returned 0 records — if we have stale cache, use it rather than showing nothing
    if (g100Cache.items.length > 0) {
      console.warn('[g100] Fetch returned 0 records — serving stale cache');
      return { items: g100Cache.items.slice(0, limit), total: g100Cache.total };
    }
    return { items: [], total: 0 };
  } finally {
    g100RefreshInFlight = false;
  }
}

// ── GET /g100-albums ──────────────────────────────────────────────────────────
router.get('/g100-albums', async (req, res) => {
  try {
    const limit   = Math.max(1, Math.min(200, Number.parseInt(req.query.limit || '100', 10)));
    const refresh = req.query.refresh === '1';
    const result  = await loadG100Albums({ limit, refresh });
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.json({ ok: true, items: result.items, total: result.total });
  } catch (err) {
    console.error('[g100] Failed', err);
    return res.status(500).json({ ok: false, error: 'Failed to load G100 albums' });
  }
});

export default router;
