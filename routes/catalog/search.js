// routes/catalog/search.js — /wake, /search, /explore, /ai-search
import { Router } from 'express';
import { fmPost, ensureToken } from '../../fm-client.js';
import { searchCache, exploreCache } from '../../cache.js';
import { createSwr, registerSwrCache } from '../../lib/swr-cache.js';
import { hasValidAudio, hasValidArtwork, applyArtworkThumbs } from '../../lib/track.js';
import {
  isMissingFieldError, applyVisibility,
  FM_LAYOUT
} from '../../lib/fm-fields.js';
import { fmErrorToHttpStatus } from '../../lib/http.js';
import { createLogger } from '../../lib/logger.js';
import { validators } from '../../lib/validators.js';
import { suggestNames } from '../../lib/name-index.js';
import { usePostgresMetadata } from '../../lib/metadata-source.js';
import { pgFind } from '../../lib/catalog-store-pg.js';

const router = Router();

// In production, never leak internal/FM error detail to public catalogue
// callers. Returns the detail in non-prod for debugging.
const IS_PROD = process.env.NODE_ENV === 'production';
const safeDetail = (detail) => (IS_PROD ? undefined : detail);
const logSearch  = createLogger('search');
const logExplore = createLogger('explore');
const logAi      = createLogger('ai-search');

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
    logSearch.error('Wake endpoint error:', err);
    res.status(500).json({
      status: 'error',
      error: err.message
    });
  }
});

// ── /search ───────────────────────────────────────────────────────────────────

const begins = (s) => (s ? `${s}*` : '');
// "Contains" match — used for the unified free-text box so a query matches anywhere
// in the field, not just the start. Each word is wrapped in wildcards and ANDed, so
// "lucky dube" -> "*lucky* *dube*" (contains both words, any order/position) and a
// single word "slave" -> "*slave*". Relevance sorting below still ranks begins-with
// hits ahead of mid-string ones.
const contains = (s) =>
  (s ? s.trim().split(/\s+/).filter(Boolean).map(w => `*${w}*`).join(' ') : '');

function normalizeAiValue(value) {
  if (value === undefined || value === null) return '';
  const str = String(value).trim();
  if (!str || str.toLowerCase() === 'null') return '';
  return str;
}

const SEARCH_FIELDS_BASE = ['Album Artist', 'Album Title', 'Track Name'];
const SEARCH_FIELDS_OPTIONAL = ['Year of Release', 'Local Genre', 'Language Code'];
const SEARCH_FIELDS_DEFAULT = [...SEARCH_FIELDS_BASE, ...SEARCH_FIELDS_OPTIONAL];
// 'Local Genre' is the only populated genre field (Song Files::Local Genre is
// empty for every row and has no trigram index, so ORing it in forces the whole
// genre query into a full seq scan — ~4 s vs ~ms — while matching nothing).
const GENRE_FIELDS = ['Local Genre'];

// Artist can live on either the album header or the individual track.
// When a caller sends ?artist=X we need to match both so that cards whose
// displayed artist came from "Track Artist" (e.g. New Releases) still
// resolve to the right album.
const ARTIST_FIELDS = ['Album Artist', 'Track Artist'];

const buildQueries = ({ q, artist, album, track, genres }) => {
  // Genre-only search: build one OR clause per genre × per field candidate
  if (genres.length && !q && !artist && !album && !track) {
    return genres.flatMap(g => GENRE_FIELDS.map(f => ({ [f]: `*${g}*` })));
  }
  // Structured search — artist/album/track must AND together, not OR.
  // FileMaker's _find treats each object in the array as an OR clause, so
  // conditions that must apply together have to live inside ONE object.
  // To also allow artist to match either "Album Artist" OR "Track Artist",
  // we emit one AND object per artist field candidate so the final query
  // reads as:  (Album Artist=X AND …) OR (Track Artist=X AND …)
  const baseAnd = {};
  if (album) baseAnd['Album Title'] = begins(album);
  if (track) baseAnd['Track Name']  = begins(track);

  if (artist) {
    return ARTIST_FIELDS.map(f => ({ ...baseAnd, [f]: begins(artist) }));
  }
  if (Object.keys(baseAnd).length) {
    return [baseAnd];
  }
  if (q) {
    return SEARCH_FIELDS_DEFAULT.map(f => ({ [f]: contains(q) }));
  }
};

// RELAXED free-text fallback: match ANY query word in ANY field (OR over
// field×word), used only when the strict "all words in one field" query above
// dead-ends. e.g. "Thandiswa Mazwai" — her records store Album Artist just as
// "Thandiswa", so the strict query needs both words in one field and finds
// nothing; relaxed matches the "Thandiswa" records (1 of 2 words) which
// runSearch then ranks to the top by word-match count.
const buildRelaxedQueries = (q) => {
  const words = (q || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
  return SEARCH_FIELDS_DEFAULT.flatMap(f => words.map(w => ({ [f]: `*${w}*` })));
  return [{ 'Album Title': '*' }];
};

// FM fetch + post-processing for one search query. Throws a tagged error on FM
// failure so the SWR layer does NOT cache it and the route can map the code to
// the right HTTP status. The returned object is the exact response shape the
// frontend expects (do not change without checking pagination/genreOffset).
async function runSearch({ q, artist, album, track, genres, yearRange, limit, uiOff0, fmOff }) {
  const fmLimit = Math.min(500, limit * 10);

  // One FM _find + the post-filters (genre false-positive prune, audio/artwork
  // validity). Returns the kept records plus the raw count the frontend needs
  // to advance genreOffset. Throws a tagged error on FM failure (SWR won't cache).
  async function fetchFiltered(queries) {
    let rawData, foundCount;
    if (usePostgresMetadata()) {
      // Decade filter ANDs natively into every OR clause (uses the partial
      // year expression index). The FM path skips this — 'Year of Release'
      // may be absent from the layout and would fail the whole _find — and
      // relies on the uniform post-filter below instead.
      const pgQueries = yearRange
        ? queries.map(qo => ({ ...qo, 'Year of Release': `${yearRange.start}..${yearRange.end}` }))
        : queries;
      const result = await pgFind(pgQueries, { limit: fmLimit, offset: fmOff });
      rawData = result.data;
      foundCount = result.foundCount;
    } else {
      const payload = { query: queries, limit: fmLimit, offset: fmOff };
      const response = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, payload);
      const json = await response.json().catch(() => ({}));

      if (!response.ok) {
        const msg = json?.messages?.[0]?.message || 'FM error';
        const code = json?.messages?.[0]?.code;
        // FM "no records match" (401) is not an error for a search — return empty.
        if (String(code) === '401') {
          return { validRecords: [], fmReturnedCount: 0, foundCount: 0 };
        }
        const err = new Error(`Album search failed: ${msg} (FM ${code})`);
        err.httpStatus = fmErrorToHttpStatus(code, response.status);
        err.clientDetail = `${msg} (FM ${code})`;
        throw err;
      }
      rawData = json?.response?.data || [];
      foundCount = json?.response?.dataInfo?.foundCount;
    }

    // Raw FM count BEFORE post-filtering — frontend uses it to advance genreOffset.
    const fmReturnedCount = rawData.length;

    // Post-filter for ALL genre searches: FM's OR query on the related field
    // "Song Files::Local Genre" can return a parent whenever ANY related child
    // matches, even if the parent's own Local Genre is unrelated.
    if (genres.length) {
      const before = rawData.length;
      rawData = rawData.filter(r => {
        const f = r.fieldData || {};
        return genres.some(g =>
          GENRE_FIELDS.some(field => (f[field] || '').toLowerCase().includes(g.toLowerCase()))
        );
      });
      if (rawData.length < before) {
        logSearch.debug(`genre post-filter: FM returned ${before}, kept ${rawData.length} — removed ${before - rawData.length} false positive(s) for genre(s): ${genres.join(', ')}`);
      }
    }

    // Decade post-filter — the real filter on the FM path, a harmless no-op on
    // Postgres (records already match the ANDed year range).
    if (yearRange) {
      rawData = rawData.filter(r => {
        const y = Number.parseInt((r.fieldData || {})['Year of Release'], 10);
        return Number.isFinite(y) && y >= yearRange.start && y <= yearRange.end;
      });
    }

    const validRecords = rawData.filter(r => hasValidAudio(r.fieldData || {}) && hasValidArtwork(r.fieldData || {}));
    return { validRecords, fmReturnedCount, foundCount };
  }

  let { validRecords, fmReturnedCount, foundCount } = await fetchFiltered(buildQueries({ q, artist, album, track, genres }));
  let relaxed = false;

  // Multi-word dead-end rescue. The strict q query requires EVERY word in ONE
  // field, so a real-world multi-word name dead-ends when the catalogue stores
  // only part of it. Retry matching ANY word and rank by word-match count.
  // Plain free-text q only — structured artist/album/track/genre keep precise semantics.
  const words = (q || '').trim().split(/\s+/).filter(Boolean);
  if (q && words.length > 1 && !artist && !album && !track && !genres.length && validRecords.length === 0) {
    const r = await fetchFiltered(buildRelaxedQueries(q));
    validRecords = r.validRecords;
    fmReturnedCount = r.fmReturnedCount;
    foundCount = r.foundCount;
    relaxed = true;
    const lowWords = words.map(w => w.toLowerCase());
    // Relevance for the relaxed (any-word) pass. A query word that the artist
    // name *is* — or begins with — is a far stronger signal than a word that
    // merely appears somewhere. This is what makes a full real-world name find
    // the partial we actually store: the catalogue has only "Thandiswa" (no
    // surname), so "Thandiswa Mazwai" must rank artist=="Thandiswa" (exact
    // first-word match, +3) ABOVE "Ntsiki Mazwai" (only contains "Mazwai", +1),
    // even though no "Thandiswa Mazwai" record exists.
    const relevance = (fd) => {
      const artist = (fd['Album Artist'] || fd['Track Artist'] || '').toLowerCase().trim();
      const blob = SEARCH_FIELDS_DEFAULT.map(f => (fd[f] || '')).join(' ').toLowerCase();
      let score = 0;
      for (const w of lowWords) {
        if (artist === w) score += 3;
        else if (w.length >= 3 && artist.startsWith(w)) score += 2;
        else if (blob.includes(w)) score += 1;
      }
      return score;
    };
    validRecords.sort((a, b) => relevance(b.fieldData || {}) - relevance(a.fieldData || {}));
  } else {
    const needle = (artist || q).toLowerCase();
    if (needle) {
      validRecords.sort((a, b) => {
        const aAlbumArtist = (a.fieldData?.['Album Artist'] || '').toLowerCase();
        const bAlbumArtist = (b.fieldData?.['Album Artist'] || '').toLowerCase();
        const rank = (s) => { if (s.startsWith(needle)) { return 0; } return s.includes(needle) ? 1 : 2; };
        return rank(aAlbumArtist) - rank(bAlbumArtist);
      });
    }
  }

  return {
    items: validRecords.slice(0, limit).map((d) => ({ recordId: d.recordId, modId: d.modId, fields: applyArtworkThumbs({ ...(d.fieldData || {}) }, 300) })),
    rawReturnedCount: fmReturnedCount, // raw FM record count (before post-filters) — frontend advances genreOffset with this
    total: foundCount || validRecords.length,
    offset: uiOff0,
    limit,
    relaxed
  };
}

// SWR getter over searchCache: concurrent identical queries dedupe to ONE FM
// round-trip (thundering-herd protection at the 10k-concurrent target), and a
// hot query is served instantly while it refreshes in the background.
const SEARCH_TTL_MS = 5 * 60 * 1000; // soft freshness; searchCache hard TTL (1h) governs eviction
const searchSwr = createSwr({
  cache: searchCache,
  ttlMs: SEARCH_TTL_MS,
  label: 'search',
  loader: (_key, params) => runSearch(params)
});
registerSwrCache('search', { cache: searchCache, ttlMs: SEARCH_TTL_MS, label: 'search' });

router.get('/search', async (req, res) => {
  try {
    // Validate + sanitize the free-text search inputs. searchQuery rejects FM
    // find-operator characters and over-long values; we use the sanitized value.
    const SEARCH_INPUTS = { q: req.query.q, artist: req.query.artist, album: req.query.album, track: req.query.track };
    const sanitized = {};
    for (const [field, raw] of Object.entries(SEARCH_INPUTS)) {
      const val = (raw === undefined || raw === null) ? '' : String(raw).trim();
      if (val) {
        const check = validators.searchQuery(val);
        if (!check.valid) {
          return res.status(400).json({ error: `Invalid ${field}: ${check.error}` });
        }
        sanitized[field] = check.value;
      } else {
        sanitized[field] = '';
      }
    }
    const q = sanitized.q;
    const artist = sanitized.artist;
    const album = sanitized.album;
    const track = sanitized.track;

    // Handle genre as array (?genre=Rock&genre=Jazz) or comma-separated string (?genre=Rock,Jazz)
    const genreRaw = req.query.genre;
    const genres = Array.isArray(genreRaw)
      ? genreRaw.map(g => g.toString().trim()).filter(Boolean)
      : (genreRaw || '').toString().trim().split(',').map(g => g.trim()).filter(Boolean);

    const limit = Math.max(1, Math.min(500, Number.parseInt(req.query.limit || '10', 10)));
    const uiOff0 = Math.max(0, Number.parseInt(req.query.offset || '0', 10));
    const fmOff = uiOff0 + 1;

    // Decade filter — the frontend sends "1980s"-style values from the
    // #searchDecade dropdown; anything else is ignored (never an error, so a
    // malformed value degrades to the unfiltered search).
    const decadeMatch = (req.query.decade || '').toString().trim().match(/^(\d{4})s$/);
    const yearRange = decadeMatch
      ? { start: Number.parseInt(decadeMatch[1], 10), end: Number.parseInt(decadeMatch[1], 10) + 9 }
      : null;

    const cacheKey = `search:v2:${q}:${artist}:${album}:${track}:${genres.sort().join('|')}:${limit}:${uiOff0}` + (yearRange ? `:d${yearRange.start}` : '');
    const { value, state } = await searchSwr(cacheKey, { q, artist, album, track, genres, yearRange, limit, uiOff0, fmOff });

    res.setHeader('X-Cache-State', state);
    res.setHeader('X-Cache-Hit', state === 'fresh' || state === 'stale' ? 'true' : 'false');
    // Catalogue search carries no per-user data (public, auth-skipped) → safe to
    // let the browser/CDN cache popular queries briefly and serve stale while
    // revalidating, mirroring the featured rails.
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=300');

    // "Did you mean…" — when a free-text query dead-ends (zero results) or only
    // matched after relaxing the word constraint, offer fuzzy name corrections
    // from the in-memory catalogue index (no FM on this path). Computed here,
    // not inside the SWR value, so the cached payload stays canonical.
    if (q && (value.items?.length === 0 || value.relaxed)) {
      const sug = suggestNames(q, { limit: 4 }).map(s => s.name);
      if (sug.length) {
        return res.json({ ...value, suggestions: sug });
      }
    }
    res.json(value);
  } catch (err) {
    if (err && err.httpStatus) {
      return res.status(err.httpStatus).json({ error: 'Album search failed', status: err.httpStatus, detail: safeDetail(err.clientDetail || err.message) });
    }
    const detail = err?.message || String(err);
    res.status(500).json({ error: 'Album search failed', status: 500, detail: safeDetail(detail) });
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

// Cache the first year-field candidate that returned data. Same pattern as
// cachedFeaturedFieldName — turns up-to-8 serial FM round-trips into 1 on the
// steady-state path. Cleared on first failure so a layout change can recover.
let cachedYearField = null;

async function tryYearField(field, start, end, limit, offset) {
  const query   = applyVisibility({ [field]: `${start}..${end}` });
  const payload = { query: [query], limit: Math.min(500, limit + offset + 1), offset: 1 };
  try {
    const response = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, payload);
    const json     = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (isMissingFieldError(json))          return { ok: false, kind: 'missing' };
      const code = json?.messages?.[0]?.code;
      if (String(code) === '401')              return { ok: false, kind: 'empty' };
      return { ok: false, kind: 'error' };
    }
    return { ok: true, data: json?.response?.data || [] };
  } catch (err) {
    return { ok: false, kind: 'throw', err };
  }
}

async function fetchRecordsForYearRange(start, end, limit, offset) {
  // Fast path — try the cached working field first.
  if (cachedYearField) {
    const result = await tryYearField(cachedYearField, start, end, limit, offset);
    if (result.ok && result.data.length > 0) return result.data;
    // Fall through and re-probe — layout may have changed.
    cachedYearField = null;
  }

  for (const field of YEAR_FIELD_CANDIDATES) {
    const result = await tryYearField(field, start, end, limit, offset);
    if (result.ok) {
      if (result.data.length > 0) {
        cachedYearField = field; // remember for subsequent calls
        return result.data;
      }
      // Field exists but returned no records for this range — keep trying
      // other candidates, but this could still legitimately be empty.
      continue;
    }
  }
  return [];
}

async function runExplore({ start, end, limit, offset, genre = '' }) {
  if (usePostgresMetadata()) {
    // True offset pagination: fetch `limit` raw rows at `offset` and use the
    // real match count, so hasMore/nextOffset walk the WHOLE decade (and
    // decade+genre) pool. The old shape fetched one capped window with no
    // offset — total maxed out at ~500 raw rows and "load more" dead-ended
    // after the first page. Genre ANDs natively (trgm index on Local Genre).
    const query = { 'Year of Release': `${start}..${end}` };
    if (genre) query['Local Genre'] = `*${genre}*`;
    const { data, foundCount } = await pgFind(
      [query],
      { limit: Math.min(500, limit), offset: offset + 1 } // pgFind offset is FM-style 1-based
    );
    const valid = data.filter(r => hasValidAudio(r.fieldData || {}) && hasValidArtwork(r.fieldData || {}));
    const consumed = offset + data.length;
    const hasMore = consumed < foundCount;
    return {
      items:      valid.map(d => ({ recordId: d.recordId, modId: d.modId, fields: applyArtworkThumbs({ ...(d.fieldData || {}) }, 300) })),
      total:      foundCount, // raw match count — frontend advances exploreOffset via nextOffset, not this
      hasMore,
      nextOffset: hasMore ? consumed : null
    };
  }

  // Legacy FileMaker path — single capped fetch, valid-slice pagination.
  let rawData = await fetchRecordsForYearRange(start, end, limit, offset);
  logExplore.debug(`Total raw records: ${rawData.length}`);

  // Genre post-filter (the year-field candidate probing can't safely AND an
  // extra field into the FM query). Same contains semantics as /search.
  if (genre) {
    const g = genre.toLowerCase();
    rawData = rawData.filter(r =>
      GENRE_FIELDS.some(field => (((r.fieldData || {})[field]) || '').toLowerCase().includes(g))
    );
  }

  const valid = rawData.filter(r => hasValidAudio(r.fieldData || {}) && hasValidArtwork(r.fieldData || {}));
  const total = valid.length;
  const page  = valid.slice(offset, offset + limit);
  const hasMore = offset + limit < total;

  return {
    items:      page.map(d => ({ recordId: d.recordId, modId: d.modId, fields: applyArtworkThumbs({ ...(d.fieldData || {}) }, 300) })),
    total,
    hasMore,
    nextOffset: hasMore ? offset + limit : null
  };
}

const EXPLORE_TTL_MS = 10 * 60 * 1000; // soft freshness; exploreCache hard TTL (1h) governs eviction
const exploreSwr = createSwr({
  cache: exploreCache,
  ttlMs: EXPLORE_TTL_MS,
  label: 'explore',
  loader: (_key, params) => runExplore(params)
});
registerSwrCache('explore', { cache: exploreCache, ttlMs: EXPLORE_TTL_MS, label: 'explore' });

// Pre-warm every decade the frontend's random-album view can request
// (loadRandomAlbums picks one of these 8 at random with limit=150 on EVERY
// page load — a cold decade was an 8-11s wait for the album grid, measured on
// prod 2026-07-19). Key/params must mirror the /explore handler exactly.
const EXPLORE_WARM_DECADES = [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020];
export async function exploreWarmer() {
  for (const start of EXPLORE_WARM_DECADES) {
    const end = start + 9;
    const params = { start, end, limit: 150, offset: 0 };
    const cacheKey = `explore:v1:${start}:${end}:150:0`;
    try {
      await exploreSwr(cacheKey, params);
    } catch (err) {
      logExplore.warn(`decade warm ${start}s failed: ${err?.message || err}`);
    }
  }
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

    // Optional genre filter (decade + genre combined browse). Sanitized like
    // the /search inputs; an invalid value is a 400, an absent one a plain
    // decade browse. Key suffix only when present so the exploreWarmer's
    // pre-warmed no-genre keys keep matching.
    let genre = '';
    const genreRaw = (req.query.genre || '').toString().trim();
    if (genreRaw) {
      const check = validators.searchQuery(genreRaw);
      if (!check.valid) {
        return res.status(400).json({ error: `Invalid genre: ${check.error}` });
      }
      genre = check.value;
    }

    const cacheKey = `explore:v1:${start}:${end}:${limit}:${offset}` + (genre ? `:g:${genre.toLowerCase()}` : '');
    // ?refresh=1 forces a fresh load: drop the cached entry so the SWR getter
    // takes the synchronous miss path instead of serving a stale value.
    if (refresh) exploreCache.delete(cacheKey);

    const { value, state } = await exploreSwr(cacheKey, { start, end, limit, offset, genre });
    res.setHeader('X-Cache-State', state);
    res.setHeader('X-Cache-Hit', state === 'fresh' || state === 'stale' ? 'true' : 'false');
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.json(value);
  } catch (err) {
    logExplore.error('failed', err);
    res.status(500).json({ error: 'Explore failed', detail: safeDetail(err?.message || String(err)) });
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
      logAi.debug('cache hit:', query);
      res.setHeader('X-Cache-Hit', 'true');
      return res.json(cached);
    }

    logAi.debug(`Query: "${query}"`);
    res.status(501).json({ error: 'AI search not yet implemented in routes' });
  } catch (err) {
    logAi.error('Error:', err);
    const detail = err?.message || String(err);
    res.status(500).json({ error: 'AI search failed', status: 500, detail: safeDetail(detail) });
  }
});

// Export normalizeAiValue so other modules can reuse it if needed
export { normalizeAiValue, buildQueries, buildRelaxedQueries, SEARCH_FIELDS_DEFAULT };
export default router;
