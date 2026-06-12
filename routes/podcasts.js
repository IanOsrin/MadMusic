/**
 * routes/podcasts.js — Podcast section API.
 *
 * GET /api/podcasts → { ok, source, count, shows: [ { show…, episodes: […] } ] }
 *
 * FM layout API_Podcasts (FM_PODCASTS_LAYOUT) is ONE ROW PER EPISODE with the
 * show's fields denormalised onto every row (single-table design, 2026-06-11).
 * This route groups episode rows into one card per show — the same dedup
 * principle as the album rails (see .claude/skills/mad-fm-dedup-pattern) with
 * the key adapted: shows are grouped by Show Title alone. Host is NOT part of
 * the key on purpose — it's a show-level value repeated per row, and a single
 * inconsistently-entered row would otherwise split the show into two cards
 * (the same class of bug as CLAUDE.md mobile invariant #1).
 *
 * Reads go through lib/swr-cache.js per the house rule — FM is never hit on
 * the request path after warm-up. Writes: none.
 *
 * Mounted in server.js ONLY when PODCASTS_ENABLED=true (Telkom-style fence).
 */

import { Router } from 'express';
import { fmFindRecords } from '../fm-client.js';
import { createSwrCache } from '../lib/swr-cache.js';
import { createLogger } from '../lib/logger.js';

const router = Router();
const log = createLogger('podcasts');

const FM_PODCASTS_LAYOUT = process.env.FM_PODCASTS_LAYOUT || 'API_Podcasts';
const PODCASTS_TTL_MS = Number.parseInt(process.env.PODCASTS_CACHE_TTL_MS, 10) || 10 * 60 * 1000;
// Hard fetch ceiling. The podcast catalogue is expected to stay in the tens
// of episodes; if it ever approaches this, the loader logs loudly (no silent
// truncation) and the fetch needs paging like the semantic ingest.
const FETCH_LIMIT = 1000;

const str = (f, k) => String(f?.[k] ?? '').trim();

// Same semantics as the catalogue's visibility convention: empty or "show"
// (case-insensitive) is visible; anything else ("Hide") is excluded.
function isVisible(f) {
  const v = str(f, 'Visibility').toLowerCase();
  return !v || v === 'show';
}

// FM returns date fields in its display format (MM/DD/YYYY per productInfo).
// Normalise to ISO for the API; pass through anything unrecognised.
function fmDateToIso(v) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (!m) return v || '';
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/**
 * Group one-row-per-episode FM records into show cards.
 * Exported for unit tests.
 */
export function groupPodcastRecords(records = []) {
  const shows = new Map(); // showKey → show object
  let skipped = 0;

  for (const rec of records) {
    const f = rec.fieldData || rec.fields || {};
    if (!isVisible(f)) { skipped++; continue; }
    const s3Url = str(f, 'S3_URL');
    if (!/^https?:\/\//i.test(s3Url)) { skipped++; continue; } // unplayable row

    const showTitle = str(f, 'Show Title');
    if (!showTitle) { skipped++; continue; }
    const key = showTitle.toLowerCase();

    if (!shows.has(key)) {
      shows.set(key, {
        showTitle,
        host: str(f, 'Host'),
        artwork: str(f, 'Artwork_S3_URL'),
        // TODO(thumbs): podcast covers get _300.webp derivatives only after
        // scripts/artwork-resize runs over the new files — serve masters until
        // then, then route through thumbArtworkUrl like the album rails.
        category: str(f, 'Category'),
        language: str(f, 'Language Code'),
        featured: false,
        episodes: []
      });
    }
    const show = shows.get(key);
    // Fill show-level gaps from later rows (denormalised data can be patchy).
    if (!show.host) show.host = str(f, 'Host');
    if (!show.artwork) show.artwork = str(f, 'Artwork_S3_URL');
    if (str(f, 'Featured').toLowerCase() === 'yes') show.featured = true;

    show.episodes.push({
      recordId: String(rec.recordId ?? ''),
      podcastId: str(f, 'PodcastID'),
      title: str(f, 'Episode Title'),
      description: str(f, 'Description'),
      episodeNumber: Number.parseInt(f['Episode Number'], 10) || null,
      durationSec: Number.parseFloat(f['DurationSec']) || null,
      publishDate: fmDateToIso(str(f, 'PublishDate')),
      url: s3Url,
      explicit: Number(f['Explicit']) === 1
    });
  }

  const out = [...shows.values()];
  for (const show of out) {
    // Newest first — podcast convention. PublishDate primary, number fallback.
    show.episodes.sort((a, b) =>
      (b.publishDate || '').localeCompare(a.publishDate || '') ||
      (b.episodeNumber ?? 0) - (a.episodeNumber ?? 0)
    );
    show.latestPublishDate = show.episodes[0]?.publishDate || '';
    show.episodeCount = show.episodes.length;
  }
  // Featured shows first, then by most recent episode.
  out.sort((a, b) =>
    (b.featured - a.featured) ||
    (b.latestPublishDate || '').localeCompare(a.latestPublishDate || '')
  );

  return { shows: out, skipped };
}

async function fetchPodcastsFromFm() {
  const result = await fmFindRecords(FM_PODCASTS_LAYOUT, [{ 'Show Title': '*' }], { limit: FETCH_LIMIT });
  if (!result.ok) {
    // FM 401 = "no records match" — an empty catalogue, not an error.
    if (result.code === '401') return { shows: [], skipped: 0 };
    throw new Error(`Podcasts FM query failed: ${result.msg || 'FM error'}${result.code ? ` (FM ${result.code})` : ''}`);
  }
  if (result.data.length >= FETCH_LIMIT) {
    log.warn(`fetch hit the ${FETCH_LIMIT}-record ceiling — episodes beyond it are MISSING; add paging`);
  }
  const grouped = groupPodcastRecords(result.data);
  log.debug(`${grouped.shows.length} shows from ${result.data.length} rows (${grouped.skipped} skipped)`);
  return grouped;
}

const podcastsSwr = createSwrCache({
  ttlMs: PODCASTS_TTL_MS,
  max: 4,
  label: 'podcasts',
  name: 'podcasts',
  loader: () => fetchPodcastsFromFm()
});

router.get('/podcasts', async (req, res) => {
  res.setHeader('Cache-Control', 'public, s-maxage=60, max-age=60, stale-while-revalidate=300');
  try {
    const result = await podcastsSwr.get('default');
    const { shows } = result.value || { shows: [] };
    res.setHeader('X-Cache-State', result.state || 'miss');
    return res.json({ ok: true, source: 'fm', count: shows.length, shows });
  } catch (err) {
    log.error('fetch failed:', err.message);
    // Section is non-critical: degrade to empty rather than erroring the page.
    return res.json({ ok: true, source: 'error-fallback', count: 0, shows: [] });
  }
});

export default router;
