import { Router } from 'express';
import { fmPost, fmWithAuth, ensureToken, fmFindRecords, fmGetRecordById } from '../fm-client.js';
import { searchCache, exploreCache, albumCache, publicPlaylistsCache, trendingCache, genreCache } from '../cache.js';
import {
  hasValidAudio, hasValidArtwork, recordIsVisible, recordIsFeatured, isMissingFieldError, applyVisibility,
  firstNonEmptyFast, AUDIO_FIELD_CANDIDATES, ARTWORK_FIELD_CANDIDATES, CATALOGUE_FIELD_CANDIDATES,
  parsePositiveInt, validators, formatTimestampUTC, normalizeRecordId, toCleanString,
  normalizeSeconds, parseFileMakerTimestamp, pickFieldValueCaseInsensitive, composersFromFields,
  parseTrackSequence, resolvePlayableSrc, resolveArtworkSrc, fmErrorToHttpStatus,
  makeAlbumKey, normTitle, firstNonEmpty, validateQueryString
} from '../helpers.js';

const router = Router();

const FM_LAYOUT = process.env.FM_LAYOUT || 'API_Album_Songs';
const FM_STREAM_EVENTS_LAYOUT = process.env.FM_STREAM_EVENTS_LAYOUT || 'Stream_Events';
const TRENDING_LOOKBACK_HOURS = parsePositiveInt(process.env.TRENDING_LOOKBACK_HOURS, 168);
const TRENDING_FETCH_LIMIT = parsePositiveInt(process.env.TRENDING_FETCH_LIMIT, 400);
const TRENDING_MAX_LIMIT = parsePositiveInt(process.env.TRENDING_MAX_LIMIT, 20);

const FM_FEATURED_FIELD = (process.env.FM_FEATURED_FIELD || 'Tape Files::featured').trim();
const FM_FEATURED_VALUE = (process.env.FM_FEATURED_VALUE || 'yes').trim();
const FEATURED_ALBUM_CACHE_TTL_MS = parsePositiveInt(process.env.FEATURED_ALBUM_CACHE_TTL_MS, 30 * 1000);
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
const STREAM_TIME_FIELD = 'TimeStreamed';

let yearFieldCache = null;
let publicPlaylistFieldCache = null;
let featuredAlbumCache = { items: [], total: 0, updatedAt: 0 };
let cachedFeaturedFieldName = null;

// ---- featured-albums helpers ----

function cloneRecordsForLimit(records = [], count = records.length) {
  return records.slice(0, Math.min(count, records.length)).map((record) => ({
    recordId: record.recordId,
    modId: record.modId,
    fields: { ...(record.fieldData || record.fields || {}) }
  }));
}

async function fetchFeaturedAlbumRecords(limit = 400) {
  if (!FEATURED_FIELD_CANDIDATES.length) return [];
  const normalizedLimit = Math.max(1, Math.min(1000, limit));

  const tryField = async (field) => {
    if (!field) return null;
    const query = applyVisibility({ [field]: FM_FEATURED_VALUE });
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
    if (result && result.length > 0) return result;
    console.warn(`[featured] Cached field "${cachedFeaturedFieldName}" failed, trying all candidates`);
    cachedFeaturedFieldName = null;
  }

  for (const field of FEATURED_FIELD_CANDIDATES) {
    const result = await tryField(field);
    if (result && result.length > 0) return result;
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

// ---- trending helpers ----

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
    const detail = `${findResult.msg || 'FM error'}${findResult.code ? ` (FM ${findResult.code})` : ''}`;
    throw new Error(`Trending stream query failed: ${detail}`);
  }

  const statsByTrack = new Map();
  for (const entry of findResult.data) {
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

  if (!statsByTrack.size) return [];

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

const begins = (s) => (s ? `${s}*` : '');

function normalizeAiValue(value) {
  if (value === undefined || value === null) return '';
  const str = String(value).trim();
  if (!str || str.toLowerCase() === 'null') return '';
  return str;
}

router.get('/wake', async (req, res) => {
  try {
    await ensureToken();
    res.json({
      status: 'ok',
      timestamp: Date.now(),
      tokenValid: !!fmWithAuth
    });
  } catch (err) {
    console.error('[MASS] Wake endpoint error:', err);
    res.status(500).json({
      status: 'error',
      error: err.message
    });
  }
});

router.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const artist = (req.query.artist || '').toString().trim();
    const album = (req.query.album || '').toString().trim();
    const track = (req.query.track || '').toString().trim();
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '10', 10)));
    const uiOff0 = Math.max(0, parseInt(req.query.offset || '0', 10));
    const fmOff = uiOff0 + 1;

    const cacheKey = `search:v1:${q}:${artist}:${album}:${track}:${limit}:${uiOff0}`;
    const cached = searchCache.get(cacheKey);
    if (cached) {
      console.log(`[CACHE HIT] search`);
      res.setHeader('X-Cache-Hit', 'true');
      return res.json(cached);
    }

    const SEARCH_FIELDS_BASE = ['Album Artist', 'Album Title', 'Track Name'];
    const SEARCH_FIELDS_OPTIONAL = ['Year of Release', 'Local Genre', 'Language Code', 'Track Artist', 'Genre'];
    const SEARCH_FIELDS_DEFAULT = [...SEARCH_FIELDS_BASE, ...SEARCH_FIELDS_OPTIONAL];

    const buildQueries = ({ q, artist, album, track }) => {
      const queries = [];
      if (artist) {
        SEARCH_FIELDS_BASE.forEach(f => queries.push({ [f]: begins(artist) }));
      }
      if (album) {
        SEARCH_FIELDS_BASE.forEach(f => queries.push({ [f]: begins(album) }));
      }
      if (track) {
        SEARCH_FIELDS_BASE.forEach(f => queries.push({ [f]: begins(track) }));
      }
      if (q && !artist && !album && !track) {
        return SEARCH_FIELDS_DEFAULT.map(f => ({ [f]: begins(q) }));
      }
      return queries.length ? queries : [{ 'Album Title': '*' }];
    };

    const queries = buildQueries({ q, artist, album, track });
    const payload = { query: queries, limit: Math.min(500, limit * 10), offset: fmOff };

    const response = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, payload);
    const json = await response.json().catch(() => ({}));

    if (!response.ok) {
      const msg = json?.messages?.[0]?.message || 'FM error';
      const code = json?.messages?.[0]?.code;
      const httpStatus = fmErrorToHttpStatus(code, response.status);
      return res.status(httpStatus).json({ error: 'Album search failed', status: httpStatus, detail: `${msg} (FM ${code})` });
    }

    const rawData = json?.response?.data || [];
    const validRecords = rawData.filter(r => hasValidAudio(r.fieldData || {}) && hasValidArtwork(r.fieldData || {}));

    const response_obj = {
      items: validRecords.slice(0, limit).map((d) => ({ recordId: d.recordId, modId: d.modId, fields: d.fieldData || {} })),
      total: json?.response?.dataInfo?.foundCount || validRecords.length,
      offset: uiOff0,
      limit
    };

    searchCache.set(cacheKey, response_obj);
    res.json(response_obj);
  } catch (err) {
    const detail = err?.message || String(err);
    res.status(500).json({ error: 'Album search failed', status: 500, detail });
  }
});

router.get('/ai-search', async (req, res) => {
  try {
    const query = (req.query.q || '').toString().trim();

    if (!query) {
      return res.status(400).json({ error: 'Query parameter required' });
    }

    if (query.length > 500) {
      return res.status(400).json({ error: 'Query too long (max 500 characters)' });
    }

    const cacheKey = `ai-search:${query}`;
    const cached = searchCache.get(cacheKey);
    if (cached) {
      console.log(`[CACHE HIT] ai-search: ${query}`);
      res.setHeader('X-Cache-Hit', 'true');
      return res.json(cached);
    }

    console.log(`[AI SEARCH] Query: "${query}"`);
    res.status(501).json({ error: 'AI search not yet implemented in routes' });
  } catch (err) {
    console.error('[AI SEARCH] Error:', err);
    const detail = err?.message || String(err);
    res.status(500).json({ error: 'AI search failed', status: 500, detail });
  }
});

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

router.get('/random-songs', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');

    const countParam = Number.parseInt(req.query.count || '12', 10);
    const count = Number.isFinite(countParam) ? Math.max(1, Math.min(100, countParam)) : 12;

    const genreParam = (req.query.genre || req.query.genres || '').toString().trim();
    const genres = genreParam.split(',').map(g => g.trim()).filter(Boolean);

    console.log(`[RANDOM SONGS] Requesting ${count} songs${genres.length ? ` (genres: ${genres.join(', ')})` : ''}`);

    let data = [];
    const fetchLimit = count * 3;

    if (genres.length > 0) {
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
        }
      }

      if (!foundField) {
        console.error('[RANDOM SONGS] No valid genre field found on layout');
        return res.status(500).json({ ok: false, error: 'Genre filtering not supported on this layout' });
      }
    } else {
      const query = [{ 'Album Title': '*' }];
      const countResponse = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, { query, limit: 1 });
      const countJson = await countResponse.json().catch(() => ({}));

      if (!countResponse.ok) {
        const msg = countJson?.messages?.[0]?.message || 'FM error';
        const code = countJson?.messages?.[0]?.code;
        console.error(`[RANDOM SONGS] FileMaker error: ${msg} (${code})`);
        return res.status(500).json({ ok: false, error: msg, code });
      }

      const totalRecords = countJson?.response?.dataInfo?.foundCount || 0;
      const windowSize = Math.min(Math.max(500, count * 50), 1000);
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
      console.log(`[RANDOM SONGS] FileMaker returned ${data.length} records`);
    }

    const validRecords = data.filter(record => {
      const fields = record.fieldData || {};
      return hasValidAudio(fields) && hasValidArtwork(fields);
    });

    const shuffled = validRecords.sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, count);

    const items = selected.map(record => {
      const fields = record.fieldData || {};
      const recordId = String(record.recordId || '');
      const albumArtist = firstNonEmpty(fields, ['Album Artist', 'Tape Files::Album Artist', 'Artist']);
      const albumTitle = firstNonEmpty(fields, ['Album Title', 'Tape Files::Album Title', 'Album']);
      const trackName = firstNonEmpty(fields, ['Track Name', 'Tape Files::Track Name', 'Song Title', 'Title']);
      const catalogue = firstNonEmpty(fields, CATALOGUE_FIELD_CANDIDATES);
      const genre = firstNonEmpty(fields, ['Local Genre', 'Tape Files::Local Genre', 'Genre']);
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
          [audioInfo.field]: audioInfo.value,
          [artworkInfo.field]: artworkInfo.value
        },
        audioSrc,
        artworkSrc
      };
    }).filter(item => item.audioSrc && item.artworkSrc);

    console.log(`[RANDOM SONGS] Returning ${items.length} songs`);
    res.json({ ok: true, items, count: items.length });
  } catch (err) {
    console.error('[RANDOM SONGS] Error:', err);
    const detail = err?.message || String(err);
    res.status(500).json({ ok: false, error: 'Failed to fetch random songs', detail });
  }
});

router.get('/public-playlists', async (req, res) => {
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

    const finalPayload = { ok: true, playlists: [] };
    publicPlaylistsCache.set(cacheKey, finalPayload);
    res.json(finalPayload);
  } catch (err) {
    console.error('[MASS] Public playlists fetch failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load public playlists' });
  }
});

router.get('/featured-albums', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit || '400', 10)));
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

router.get('/releases/latest', async (req, res) => {
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

router.get('/missing-audio-songs', async (req, res) => {
  try {
    const count = Math.max(1, Math.min(50, parseInt(req.query.count || '12', 10)));

    await ensureToken();

    const fetchLimit = count * 20;
    const maxOffset = 10000;
    const randomOffset = Math.floor(Math.random() * maxOffset) + 1;

    console.log(`[missing-audio-songs] Fetching ${fetchLimit} records from offset ${randomOffset}`);

    const json = await fmFindRecords(FM_LAYOUT, [{ 'Album Title': '*' }], {
      limit: fetchLimit,
      offset: randomOffset
    });

    const rawData = json?.data || [];
    console.log(`[missing-audio-songs] Fetched ${rawData.length} total records`);

    const missingAudioRecords = rawData.filter(record => {
      const fields = record.fieldData || {};
      const hasAudio = hasValidAudio(fields);
      return !hasAudio;
    });

    console.log(`[missing-audio-songs] Found ${missingAudioRecords.length} songs without audio out of ${rawData.length} total`);

    const shuffled = missingAudioRecords.sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, count);

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

router.get('/album', async (req, res) => {
  try {
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

    const cacheKey = `album:${cat}:${title}:${artist}:${limit}`;
    const cached = albumCache.get(cacheKey);
    if (cached) {
      console.log(`[CACHE HIT] album: ${cacheKey.slice(0, 50)}...`);
      res.setHeader('X-Cache-Hit', 'true');
      return res.json(cached);
    }

    let queries = [];

    if (cat) {
      queries = [{ 'Reference Catalogue Number': cat }];
    } else if (title && artist) {
      queries = [{ 'Album Title': title, 'Album Artist': artist }];
    } else if (title) {
      queries = [{ 'Album Title': title }];
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
    const data = rawData.filter(d => hasValidAudio(d.fieldData || {}));
    const actualTotal = json?.response?.dataInfo?.foundCount ?? rawData.length;

    const response = {
      ok: true,
      items: data.map((d) => ({ recordId: d.recordId, modId: d.modId, fields: d.fieldData || {} })),
      total: actualTotal,
      offset: 0,
      limit
    };

    albumCache.set(cacheKey, response);
    return res.json(response);
  } catch (err) {
    const detail = err?.message || String(err);
    return res.status(500).json({ error: 'Album lookup failed', status: 500, detail });
  }
});

export default router;
