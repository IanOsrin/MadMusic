// routes/suggestions.js — GET /suggestions: "Similar albums" for a seed album.
//
// Item-to-item recommendations powered by the slim semantic album index
// (lib/semantic-index.js → data/suggest.db). The lookup is a local sqlite-vec
// nearest-neighbour query over precomputed album centroids — it NEVER touches
// FileMaker, so the 10k-concurrent rule holds without an SWR/FM round-trip.
// Assembled payloads are still cached in a small LRU (the index only changes on
// a rebuild+redeploy).
//
// Feature-flagged SUGGESTIONS_ENABLED (default off) in server.js, which 404s the
// path before auth and skip-lists it only while enabled — same pattern as
// podcasts/telkom.
import { Router } from 'express';
import { LRUCache } from 'lru-cache';
import { suggestAlbums, semanticIndexStatus, initSemanticIndex } from '../lib/semantic-index.js';
import { validateQueryString } from '../lib/validators.js';
import { createLogger } from '../lib/logger.js';

const router = Router();
const log = createLogger('suggestions');

// Payloads are deterministic for a given (seed, limit) until the index is
// rebuilt, so a plain LRU with a generous TTL is enough.
const cache = new LRUCache({ max: 1000, ttl: 60 * 60 * 1000 });

router.get('/suggestions', async (req, res) => {
  try {
    // Idempotent: opens the index on first call (or downloads it once via
    // SUGGEST_DB_URL), then returns instantly. Guarantees readiness regardless
    // of boot ordering / test harness.
    await initSemanticIndex();
    const status = semanticIndexStatus();
    if (!status.ready) {
      // Index artifact absent/unreadable — degrade quietly so the album page
      // simply omits the rail rather than erroring.
      res.setHeader('X-Suggest-Index', 'unavailable');
      return res.json({ ok: true, seed: null, items: [], count: 0, indexReady: false });
    }

    const catV    = validateQueryString(req.query.cat, 'cat', 100);
    const titleV  = validateQueryString(req.query.title, 'title', 200);
    const artistV = validateQueryString(req.query.artist, 'artist', 200);
    for (const v of [catV, titleV, artistV]) {
      if (!v.ok) return res.status(400).json({ ok: false, error: v.reason });
    }
    const cat = catV.value;
    const title = titleV.value;
    const artist = artistV.value;

    if (!cat && !title) {
      return res.status(400).json({ ok: false, error: 'Provide cat, or title (+ artist)' });
    }

    const limitParam = Number.parseInt(req.query.limit || '10', 10);
    const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(20, limitParam)) : 10;

    const cacheKey = `${cat}|${title}|${artist}|${limit}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      res.setHeader('X-Cache-Hit', 'true');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.json(cached);
    }

    const result = suggestAlbums({ cat, title, artist }, limit);
    const payload = {
      ok: true,
      seed: result.seed,
      items: result.items,
      count: result.items.length,
      indexReady: true
    };

    cache.set(cacheKey, payload);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.json(payload);
  } catch (err) {
    log.error('Error:', err);
    return res.status(500).json({ ok: false, error: 'Failed to build suggestions' });
  }
});

export default router;
