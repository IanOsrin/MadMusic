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
import { createLogger } from '../../lib/logger.js';

const router    = Router();
const log       = createLogger('genres');
const GENRE_FIELD = 'Local Genre';
const BATCH_SIZE  = 500;
const MAX_PAGES   = 20; // cap at 10 000 records
const GENRE_TTL_MS = parsePositiveInt(process.env.GENRE_LIST_CACHE_TTL_MS, 24 * 60 * 60 * 1000);

async function fetchPage(query, offset) {
  try {
    const res  = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, {
      query: [query], limit: BATCH_SIZE, offset
    });
    const json = await res.json().catch(() => ({}));
    const fmCode = String(json?.messages?.[0]?.code || '');
    if (!res.ok && fmCode !== '401') {
      log.warn(`Page offset=${offset} FM error code=${fmCode} msg=${json?.messages?.[0]?.message}`);
      return { data: [], foundCount: 0 };
    }
    return {
      data:       json?.response?.data || [],
      foundCount: json?.response?.dataInfo?.foundCount || 0
    };
  } catch (err) {
    log.warn(`Page offset=${offset} threw:`, err?.message);
    return { data: [], foundCount: 0 };
  }
}

async function fetchAllGenres() {
  const query = applyVisibility({ [GENRE_FIELD]: '*' });

  // First page — kicks off to discover foundCount
  const first = await fetchPage(query, 1);
  const foundCount = first.foundCount || first.data.length;
  const totalPages = Math.min(Math.ceil(foundCount / BATCH_SIZE), MAX_PAGES);
  log.debug(`foundCount=${foundCount} firstBatch=${first.data.length} totalPages=${totalPages}`);

  const genreSet = new Set();
  first.data.forEach(r => {
    const g = (r.fieldData?.[GENRE_FIELD] || '').trim();
    if (g) genreSet.add(g);
  });

  // Remaining pages in parallel
  if (totalPages > 1) {
    const pagePromises = [];
    for (let page = 1; page < totalPages; page++) {
      pagePromises.push(fetchPage(query, page * BATCH_SIZE + 1));
    }
    const results = await Promise.all(pagePromises);
    results.forEach(({ data }) => {
      data.forEach(r => {
        const g = (r.fieldData?.[GENRE_FIELD] || '').trim();
        if (g) genreSet.add(g);
      });
    });
  }

  return {
    genres:     Array.from(genreSet).sort((a, b) => a.localeCompare(b)),
    foundCount,
    totalPages
  };
}

// ── SWR cache ───────────────────────────────────────────────────────────────
const genresSwr = createSwrCache({
  ttlMs: GENRE_TTL_MS,
  max:   2,
  label: 'genres',
  name:  'genres',
  loader: async () => {
    const { genres, foundCount, totalPages } = await fetchAllGenres();
    log.debug(`Loaded ${genres.length} genres from ${foundCount} records across ${totalPages} pages`);
    return { genres, foundCount, totalPages };
  }
});

export const genresWarmer = () => genresSwr.get('default');

// ── GET /genres ─────────────────────────────────────────────────────────────
router.get('/genres', async (req, res) => {
  const refresh = req.query.refresh === '1';
  if (refresh) genresSwr.cache.delete('default');

  try {
    const { value, state } = await genresSwr.get('default');
    res.setHeader('X-Cache-State', state);
    if (req.query.debug === '1') {
      return res.json({ ...value, genreCount: value.genres.length });
    }
    return res.json({ genres: value.genres });
  } catch (err) {
    log.error('Error:', err);
    res.status(500).json({ error: 'Failed to fetch genres', detail: err?.message || String(err) });
  }
});

export default router;
