// routes/catalog/genres.js — /genres
// Collects distinct Local Genre values from FM records, caches for 24 hours.
import { Router } from 'express';
import { fmPost } from '../../fm-client.js';
import { genreListCache } from '../../cache.js';
import { FM_LAYOUT, applyVisibility } from '../../lib/fm-fields.js';

const router = Router();
const GENRE_FIELD = 'Local Genre';
const BATCH_SIZE  = 500;
const MAX_PAGES   = 20; // cap at 10 000 records
const CACHE_KEY   = 'genre-value-list';

async function fetchPage(query, offset) {
  try {
    const res  = await fmPost(`/layouts/${encodeURIComponent(FM_LAYOUT)}/_find`, {
      query: [query],
      limit: BATCH_SIZE,
      offset
    });
    const json = await res.json().catch(() => ({}));
    const fmCode = String(json?.messages?.[0]?.code || '');
    if (!res.ok && fmCode !== '401') {
      console.warn(`[genres] Page offset=${offset} FM error code=${fmCode} msg=${json?.messages?.[0]?.message}`);
      return { data: [], foundCount: 0 };
    }
    return {
      data:       json?.response?.data || [],
      foundCount: json?.response?.dataInfo?.foundCount || 0
    };
  } catch (err) {
    console.warn(`[genres] Page offset=${offset} threw:`, err?.message);
    return { data: [], foundCount: 0 };
  }
}

async function fetchAllGenres() {
  const query = applyVisibility({ [GENRE_FIELD]: '*' });

  // First request — gets initial data + foundCount
  const first = await fetchPage(query, 1);
  const foundCount = first.foundCount || first.data.length;
  const totalPages = Math.min(Math.ceil(foundCount / BATCH_SIZE), MAX_PAGES);

  console.log(`[genres] foundCount=${foundCount} firstBatch=${first.data.length} totalPages=${totalPages}`);

  const genreSet = new Set();
  first.data.forEach(r => {
    const g = (r.fieldData?.[GENRE_FIELD] || '').trim();
    if (g) genreSet.add(g);
  });

  // Fetch remaining pages in parallel
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
    genres: Array.from(genreSet).sort((a, b) => a.localeCompare(b)),
    foundCount,
    totalPages
  };
}

router.get('/genres', async (req, res) => {
  console.log('[genres] Request received, refresh=', req.query.refresh);

  if (req.query.refresh !== '1') {
    const cached = genreListCache.get(CACHE_KEY);
    if (cached) {
      res.setHeader('X-Cache-Hit', 'true');
      return res.json(cached);
    }
  }

  try {
    const { genres, foundCount, totalPages } = await fetchAllGenres();
    const result = { genres };
    genreListCache.set(CACHE_KEY, result);
    console.log(`[genres] Loaded ${genres.length} distinct genres from ${foundCount} FM records across ${totalPages} page(s)`);

    // Include debug info when ?debug=1
    if (req.query.debug === '1') {
      return res.json({ genres, foundCount, totalPages, genreCount: genres.length });
    }

    res.json(result);
  } catch (err) {
    console.error('[genres] Error:', err);
    res.status(500).json({ error: 'Failed to fetch genres', detail: err?.message || String(err) });
  }
});

export default router;
