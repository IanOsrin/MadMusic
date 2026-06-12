// lib/album-dedup.js — collapse one-row-per-track FM results to one row per album.
//
// FM layouts return one row per track, so a rail fetch is N albums × M tracks.
// The rules here come from real catalogue data (see docs/FM-MAP.md):
//
//  - Artist is resolved album-first: `Tape Files::Album Artist` is curated per
//    album, while the base `Album Artist` drifts per row — a single stray
//    "Various Artists" row used to split Victims/Lucky Dube into two cards.
//  - "Various Artists" (and variants) is a wildcard, not an identity: a Various
//    row folds into the album's named artist when the title has exactly one.
//    True compilations — no named album artist at all, or several named artists
//    sharing the title — keep a single Various Artists card.
//  - Catalogue number is deliberately NOT the key: the same album can ship as
//    several releases (Victims = CDLUCKY 08 + GMI 0017) that must stay one card.

const VARIOUS_RE = /^(various(\s+artists?)?|va|v\.a\.?)$/i;

export function isVariousArtists(name) {
  return VARIOUS_RE.test(String(name || '').trim());
}

function albumOf(f) {
  return String(
    f['Album Title'] || f['Tape Files::Album Title'] || f['Tape Files::Album_Title'] || ''
  ).toLowerCase().trim();
}

function artistOf(f) {
  return String(f['Tape Files::Album Artist'] || f['Album Artist'] || '').toLowerCase().trim();
}

export function dedupRecordsByAlbum(records = []) {
  // Pass 1: per album title, the distinct named (non-Various) album artists.
  const namedByTitle = new Map();
  for (const r of records) {
    const f      = r.fieldData || {};
    const album  = albumOf(f);
    if (!album) continue;
    const artist = artistOf(f);
    if (!artist || isVariousArtists(artist)) continue;
    if (!namedByTitle.has(album)) namedByTitle.set(album, new Set());
    namedByTitle.get(album).add(artist);
  }

  // Pass 2: group. The representative row prefers a named-artist row over a
  // Various one, so downstream display/grouping (frontend getAlbumArtist reads
  // the base field only) never sees the dirty artist value.
  const groups = new Map(); // key → { record, clean }
  const order  = [];
  for (const r of records) {
    const f       = r.fieldData || {};
    const album   = albumOf(f);
    const rawArtist = artistOf(f);
    const various = !rawArtist || isVariousArtists(rawArtist);
    // Base-field dirtiness matters separately: the related field can be clean
    // while base `Album Artist` says Various (the Victims case).
    const clean   = !various && !isVariousArtists(f['Album Artist']);

    let key;
    if (!album) {
      key = `rec|||${r.recordId}`;
    } else if (various) {
      const named = namedByTitle.get(album);
      const owner = (named && named.size === 1) ? [...named][0] : 'various artists';
      key = `${owner}|||${album}`;
    } else {
      key = `${rawArtist}|||${album}`;
    }

    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { record: r, clean });
      order.push(key);
    } else if (clean && !existing.clean) {
      groups.set(key, { record: r, clean });
    }
  }

  return order.map(key => groups.get(key).record);
}
