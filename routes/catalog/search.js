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

const router = Router();

// ── /wake ─────────────────────────────────────────────────────────────────────
router.get('/wake', async (req, res) => {
  try {
    await ensureToken();
    res.json({
      status: 'ok',
      timestamp: Date.now(),
      tokenValid: true
    });
  } catch (err) {
    console.error('[MASS] Wake endpoint error:', err);
    res.status(500).json({
      status: 'error',
      error: err.message
    });
  }
});

// ── /search ───────────────────────────────────────────────────────────────────

const begins = (s) => (s ? `${s}*` : '');

function normalizeAiValue(value) {
  if (value === undefined || value === null) return '';
  const str = String(value).trim();
  if (!str || str.toLowerCase() === 'null') return '';
  return str;
}

router.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const artist = (req.query.artist || '').toString().trim();
    const album = (req.query.album || '').toString().trim();
    const track = (req.query.track || '').toString().trim();

    // Handle genre as array (?genre=Rock&genre=Jazz) or comma-separated string (?genre=Rock,Jazz)
    const genreRaw = req.query.genre;
    const genres = Array.isArray(genreRaw)
      ? genreRaw.map(g => g.toString().trim()).filter(Boolean)
      : (genreRaw || '').toString().trim().split(',').map(g => g.trim()).filter(Boolean);
    const genre = genres.join(','); // single string for cache key + legacy filter

    const limit = Math.max(1, Math.min(500, Number.parseInt(req.query.limit || '10', 10)));
    const uiOff0 = Math.max(0, Number.parseInt(req.query.offset || '0', 10));
    const fmOff = uiOff0 + 1;

    const cacheKey = `search:v2:${q}:${artist}:${album}:${track}:${genres.sort().join('|')}:${limit}:${uiOff0}`;
    const cached = searchCache.get(cacheKey);
    if (cached) {
      console.log(`[CACHE HIT] search`);
      res.setHeader('X-Cache-Hit', 'true');
      return res.json(cached);
    }

    const SEARCH_FIELDS_BASE = ['Album Artist', 'Album Title', 'Track Name'];
    const SEARCH_FIELDS_OPTIONAL = ['Year of Release', 'Local Genre', 'Language Code', 'Track Artist'];
    const SEARCH_FIELDS_DEFAULT = [...SEARCH_FIELDS_BASE, ...SEARCH_FIELDS_OPTIONAL];
    const GENRE_FIELDS = ['Local Genre', 'Song Files::Local Genre'];

    const buildQueries = ({ q, artist, album, track, genre, genres }) => {
      // Genre-only search: build one OR clause per genre × per field candidate
      if (genres.length && !q && !artist && !album && !track) {
        return genres.flatMap(g => GENRE_FIELDS.map(f => ({ [f]: `*${g}*` })));
      }
      const queries = [];
      if (artist) {
        ['Album Artist', 'Track Artist'].forEach(f => queries.push({ [f]: begins(artist) }));
      }
      if (album) {
        ['Album Title'].forEach(f => queries.push({ [f]: begins(album) }));
      }
      if (track) {
        ['Track Name'].forEach(f => queries.push({ [f]: begins(track) }));
      }
      if (q && !artist && !album && !track) {
        return SEARCH_FIELDS_DEFAULT.map(f => ({ [f]: begins(q) }));
      }
      return queries.length ? queries : [{ 'Album Title': '*' }];
    };

    const queries = buildQueries({ q, artist, album, track, genre, genres });
    const payload = { query: queries, limit: Math.min(500, limit * 10), offset: fmOff };

    const response = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, payload);
    const json = await response.json().catch(() => ({}));

    if (!response.ok) {
      const msg = json?.messages?.[0]?.message || 'FM error';
      const code = json?.messages?.[0]?.code;
      const httpStatus = fmErrorToHttpStatus(code, response.status);
      return res.status(httpStatus).json({ error: 'Album search failed', status: httpStatus, detail: `${msg} (FM ${code})` });
    }

    let rawData = json?.response?.data || [];

    // Save the raw FM count BEFORE any post-filtering — this is what the frontend uses to
    // advance genreOffset so pagination doesn't re-request the same FM window.
    const fmReturnedCount = rawData.length;

    // Post-filter for ALL genre searches.
    // FM's OR query on the related field "Song Files::Local Genre" can return a parent record
    // whenever ANY related child matches, even if the parent's own Local Genre is unrelated
    // (e.g. a Pop album with one incorrectly-tagged Song File entry labelled "Marabi").
    // Filtering here ensures only records whose fieldData actually contains the genre pass through.
    if (genres.length) {
      const before = rawData.length;
      rawData = rawData.filter(r => {
        const f = r.fieldData || {};
        return genres.some(g =>
          GENRE_FIELDS.some(field => (f[field] || '').toLowerCase().includes(g.toLowerCase()))
        );
      });
      if (rawData.length < before) {
        console.log(`[GENRE POST-FILTER] FM returned ${before}, kept ${rawData.length} — removed ${before - rawData.length} false positive(s) for genre(s): ${genres.join(', ')}`);
      }
    }

    const validRecords = rawData.filter(r => hasValidAudio(r.fieldData || {}) && hasValidArtwork(r.fieldData || {}));

    const needle = (artist || q).toLowerCase();
    if (needle) {
      validRecords.sort((a, b) => {
        const aAlbumArtist = (a.fieldData?.['Album Artist'] || '').toLowerCase();
        const bAlbumArtist = (b.fieldData?.['Album Artist'] || '').toLowerCase();
        const rank = (s) => { if (s.startsWith(needle)) { return 0; } return s.includes(needle) ? 1 : 2; };
        return rank(aAlbumArtist) - rank(bAlbumArtist);
      });
    }

    const response_obj = {
      items: validRecords.slice(0, limit).map((d) => ({ recordId: d.recordId, modId: d.modId, fields: d.fieldData || {} })),
      rawReturnedCount: fmReturnedCount, // raw FM record count (before genre post-filter + audio/artwork filter) — used by frontend to advance genreOffset so pagination doesn't re-request the same FM window
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

// ── /explore — browse albums by decade ───────────────────────────────────────

const YEAR_FIELD_CANDIDATES = [
  'Year of Release',
  'Tape Files::Year of Release',
  'Year',
  'Year Recorded',
  'Year_Recorded',
  'Release Year',
  'Release_Year',
  'Tape Files::Year',
];

async function fetchRecordsForYearRange(start, end, limit, offset) {
  let rawData = [];
  console.log(`[explore] Searching ${start}..${end} across candidates: ${YEAR_FIELD_CANDIDATES.join(', ')}`);
  for (const field of YEAR_FIELD_CANDIDATES) {
    const query = applyVisibility({ [field]: `${start}..${end}` });
    const payload = { query: [query], limit: Math.min(500, limit + offset + 1), offset: 1 };
    try {
      const response = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, payload);
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        const code = json?.messages?.[0]?.code;
        const msg  = json?.messages?.[0]?.message || '';
        if (isMissingFieldError(json)) { console.log(`[explore] field "${field}" → missing (102), skipping`); continue; }
        if (String(code) === '401') { console.log(`[explore] field "${field}" → no records (401), skipping`); continue; }
        console.warn(`[explore] field "${field}" → FM error ${response.status} code=${code} msg=${msg}`);
        continue;
      }
      rawData = json?.response?.data || [];
      console.log(`[explore] field "${field}" → ${rawData.length} records ✓`);
      break;
    } catch (err) {
      console.warn(`[explore] field "${field}" threw`, err.message);
    }
  }
  return rawData;
}

router.get('/explore', async (req, res) => {
  try {
    const start  = Number.parseInt(req.query.start  || '0',    10);
    const end    = Number.parseInt(req.query.end    || '9999', 10);
    const limit  = Math.max(1, Math.min(500, Number.parseInt(req.query.limit  || '400', 10)));
    const offset = Math.max(0,              Number.parseInt(req.query.offset || '0',    10));
    const refresh = req.query.refresh === '1';

    if (!start || start < 1900 || start > 2100) {
      return res.status(400).json({ error: 'Invalid start year' });
    }

    const cacheKey = `explore:v1:${start}:${end}:${limit}:${offset}`;
    if (!refresh) {
      const cached = exploreCache.get(cacheKey);
      if (cached) {
        res.setHeader('X-Cache-Hit', 'true');
        return res.json(cached);
      }
    }

    const rawData = await fetchRecordsForYearRange(start, end, limit, offset);
    console.log(`[explore] Total raw records: ${rawData.length}`);

    const valid = rawData.filter(r => hasValidAudio(r.fieldData || {}) && hasValidArtwork(r.fieldData || {}));
    const total = valid.length;
    const page  = valid.slice(offset, offset + limit);
    const hasMore = offset + limit < total;

    const result = {
      items:      page.map(d => ({ recordId: d.recordId, modId: d.modId, fields: d.fieldData || {} })),
      total,
      hasMore,
      nextOffset: hasMore ? offset + limit : null
    };

    exploreCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('[explore] failed', err);
    res.status(500).json({ error: 'Explore failed', detail: err?.message || String(err) });
  }
});

// ── /ai-search ────────────────────────────────────────────────────────────────
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

// Export normalizeAiValue so other modules can reuse it if needed
export { normalizeAiValue };
export default router;
