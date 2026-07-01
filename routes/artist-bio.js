/**
 * routes/artist-bio.js — Artist biography endpoint (FM-backed, SWR-cached).
 *
 * Reads the FM `API_Artist_Bio` layout. The loader fetches ALL Active=1 records
 * once per TTL and builds a name+alias lookup index, so a single FM query serves
 * every artist lookup (O(1)). Sized for a curated set (launch ~20 artists, grows
 * to hundreds); if it ever reaches thousands, switch to per-name FM finds with a
 * per-name SWR key. This route is SEPARATE from the catalog read path, so it works
 * identically on Service A (FileMaker) and Service B (Postgres) with no mirroring.
 *
 * Feature flag: ARTIST_BIO_ENABLED=true (default OFF — the FM layout may not exist
 * yet; ships dark and returns { found: false } until enabled). SWR never blocks the
 * request path on FileMaker; FM outage → last good value; cold-miss failure →
 * graceful empty.
 *
 * GET /api/artist-bio?name=<artist>
 *   → { ok, enabled, found, artist?: { name, bio, imageUrl, country } }
 *
 * (Social/streaming links are deferred from v1 — see docs/memory plan.)
 */
import { Router } from 'express';
import { fmFindRecords } from '../fm-client.js';
import { FM_ARTIST_BIO_LAYOUT } from '../lib/fm-fields.js';
import { createSwrCache } from '../lib/swr-cache.js';

const router = Router();
const ENABLED = process.env.ARTIST_BIO_ENABLED === 'true';

// Normalize an artist name for matching: lowercase, trim, collapse inner whitespace.
export function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Split an Aliases field (newline- or pipe-separated) into individual names.
function parseAliases(raw) {
  return String(raw || '')
    .split(/[\n|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Map one FM record → the artist bio payload, plus the normalized keys it answers to.
export function mapRecord(r) {
  const f = r.fieldData || {};
  const name = String(f.Artist_Name || '').trim();
  const bio = String(f.Bio || '').trim();
  const keys = [normalizeName(name), ...parseAliases(f.Aliases).map(normalizeName)].filter(Boolean);
  return {
    name,
    bio,
    imageUrl: String(f.Image_S3_URL || '').trim() || null,
    country: String(f.Country || '').trim() || null,
    _keys: [...new Set(keys)],
  };
}

// Build the lookup index from FM records. Requires a name + bio (never index a
// blank record). First writer wins on a key collision (earlier record kept).
export function buildIndex(records) {
  const index = new Map();
  for (const rec of records || []) {
    const artist = mapRecord(rec);
    if (!artist.name || !artist.bio) continue;
    for (const key of artist._keys) if (!index.has(key)) index.set(key, artist);
  }
  return index;
}

async function fetchFromFm() {
  const result = await fmFindRecords(FM_ARTIST_BIO_LAYOUT, [{ Active: '1' }], { limit: 500 });
  // fmFindRecords returns { ok, data, ... }; missing layout (FM 102) → ok:false → empty.
  return buildIndex(result?.data || []);
}

const bioSwr = createSwrCache({
  ttlMs: 300_000, // 5 min soft freshness — bios change rarely
  max: 2,
  label: 'artist-bio',
  name: 'artist-bio',
  loader: () => fetchFromFm(),
});

router.get('/artist-bio', async (req, res) => {
  res.setHeader('Cache-Control', 'public, s-maxage=300, max-age=300, stale-while-revalidate=1800');
  if (!ENABLED) return res.json({ ok: true, enabled: false, found: false });

  const name = normalizeName(req.query.name);
  if (!name) return res.status(400).json({ ok: false, error: 'name is required' });

  try {
    const result = await bioSwr.get('default');
    const index = result.value || new Map();
    res.setHeader('X-Cache-State', result.state || 'miss');
    const artist = index.get(name) || null;
    if (!artist) return res.json({ ok: true, enabled: true, found: false });
    const { _keys, ...payload } = artist; // don't leak internal match keys
    return res.json({ ok: true, enabled: true, found: true, artist: payload });
  } catch (err) {
    console.warn('[artist-bio] fetch failed:', err.message);
    return res.json({ ok: true, enabled: true, found: false });
  }
});

export default router;
