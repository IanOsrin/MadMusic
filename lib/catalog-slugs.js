// ============================================================================
// lib/catalog-slugs.js — slug index for the public catalogue pages (SEO tier 2).
//
// One in-memory index over the Postgres mirror: every visible artist, album
// and genre gets a stable, collision-safe URL slug. Pages and sitemaps both
// read from here, so a URL printed in the sitemap is by construction a URL
// the page routes can resolve.
//
// Scale (2026-07-30): ~5k artists, ~10k albums — a few MB in memory. The index
// rebuilds in the background after TTL; requests always get the last good
// index (stale-while-revalidate, same philosophy as lib/swr-cache.js).
// ============================================================================

import { query } from './pg.js';
import { recordIsVisible } from './fm-fields.js';

const TTL_MS = 6 * 60 * 60 * 1000; // 6h — the catalogue grows weekly, not hourly

// NFC first (macOS-decomposed names), then strip diacritics for the URL.
export function slugify(s) {
  return String(s || '')
    .normalize('NFC')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

// Deterministic collision resolution: first claimant (sorted) keeps the bare
// slug, later ones get -2, -3… Sort order makes rebuilds stable.
function claim(map, baseSlug, value) {
  let slug = baseSlug;
  let n = 2;
  while (map.has(slug)) slug = `${baseSlug}-${n++}`;
  map.set(slug, value);
  return slug;
}

let _index = null;      // { artists, albums, genres, artistAlbums, builtAt }
let _building = null;   // in-flight promise — concurrent callers share one build

async function buildIndex() {
  const t0 = Date.now();
  const r = await query(`
    SELECT raw->>'Album Title'  AS title,
           raw->>'Album Artist' AS artist,
           min(raw->>'Album Catalogue Number')       AS cat,
           min(raw->>'Tape Files::Artwork_S3_URL')   AS artwork,
           min(raw->>'Year of Release')              AS year,
           min(raw->>'Local Genre')                  AS genre,
           min(coalesce(raw->>'Visibility',''))      AS visibility,
           count(*)                                  AS tracks
      FROM tracks
     WHERE coalesce(raw->>'Album Title','') <> ''
       AND coalesce(raw->>'Album Artist','') <> ''
     GROUP BY 1, 2
  `);

  // Visibility uses the same rule as every rail (recordIsVisible); an album
  // where the minimum visibility value hides the record is left out entirely.
  const rows = r.rows
    .filter((row) => recordIsVisible({ Visibility: row.visibility }))
    .sort((a, b) => (a.artist + a.title).localeCompare(b.artist + b.title));

  const artists = new Map();       // slug → { name, slug, albums: [albumSlug], tracks }
  const albums = new Map();        // slug → { title, artist, artistSlug, cat, artwork, year, genre, tracks, slug }
  const artistByName = new Map();  // canonical name → artist record

  for (const row of rows) {
    let artistRec = artistByName.get(row.artist);
    if (!artistRec) {
      artistRec = { name: row.artist, albums: [], tracks: 0 };
      artistRec.slug = claim(artists, slugify(row.artist), artistRec);
      artistByName.set(row.artist, artistRec);
    }
    const albumRec = {
      title: row.title,
      artist: row.artist,
      artistSlug: artistRec.slug,
      cat: row.cat || '',
      artwork: row.artwork || '',
      year: (row.year || '').slice(0, 4),
      genre: row.genre || '',
      tracks: Number(row.tracks) || 0,
    };
    albumRec.slug = claim(albums, slugify(`${row.title}-${row.artist}`), albumRec);
    artistRec.albums.push(albumRec.slug);
    artistRec.tracks += albumRec.tracks;
  }

  // Genres: distinct visible values with album counts (hub pages need weight
  // to order by). Multi-genre albums count once per genre.
  const genres = new Map(); // slug → { name, albums: count }
  for (const [, album] of albums) {
    const g = (album.genre || '').trim();
    if (!g) continue;
    const gSlug = slugify(g);
    const rec = genres.get(gSlug) || { name: g, slug: gSlug, albums: 0 };
    rec.albums += 1;
    genres.set(gSlug, rec);
  }

  console.log(`[catalog-slugs] index built: ${artists.size} artists, ${albums.size} albums, ${genres.size} genres in ${Date.now() - t0}ms`);
  return { artists, albums, genres, builtAt: Date.now() };
}

export async function getIndex() {
  if (_index && Date.now() - _index.builtAt < TTL_MS) return _index;
  if (_index) {
    // Stale: serve it now, refresh in the background (once).
    if (!_building) {
      _building = buildIndex()
        .then((idx) => { _index = idx; })
        .catch((e) => console.warn('[catalog-slugs] rebuild failed, serving stale:', e?.message || e))
        .finally(() => { _building = null; });
    }
    return _index;
  }
  // Cold start: everyone waits on one build.
  if (!_building) {
    _building = buildIndex()
      .then((idx) => { _index = idx; return idx; })
      .finally(() => { _building = null; });
  }
  await _building;
  if (!_index) throw new Error('catalog slug index unavailable');
  return _index;
}

// Test hook: force a fresh build on next getIndex().
export function _resetIndexForTests() { _index = null; _building = null; }
