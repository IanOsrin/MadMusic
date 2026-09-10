// The artist view must show ONE card per album, however FileMaker spells the
// title.
//
// Reported as "one record in Streamer but two on the website": the artist page
// for Ricky showed "2 ALBUMS", both "Mama Said To Me + Bump Baby" (catalogue
// EN 12, a 2-track release). The data was clean at every layer — the two track
// rows are byte-identical on every album field.
//
// The cause was a trailing space. `Album Title` in FileMaker is
// "Mama Said To Me + Bump Baby " (note the space). detectArtistMatch TRIMS the
// clicked title, while showAlbumDetailView's album list kept the raw field — so
// `a.title === album.title` never matched, the clicked album was unshift()ed as
// a second entry, and the extra card rendered with no artwork or genre because
// clickedEntry is constructed with picture:'' / genre:''. That empty card is
// what made it look like a rendering quirk rather than a duplicate.
//
// These are static source scans: the logic lives in an inline <script> in
// app.html, so it cannot be imported. The behavioural half is covered by
// reproducing the grouping against the real field shape below.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appHtml = readFileSync(join(root, 'public', 'app.html'), 'utf8');

describe('artist view album de-duplication (app.html)', () => {
  it('defines a normalising album key', () => {
    expect(appHtml).toMatch(/const albumKey = \(s\) =>/);
  });

  it('compares the clicked album on the NORMALISED key, not raw equality', () => {
    expect(appHtml).toMatch(
      /findIndex\(\s*a\s*=>\s*albumKey\(a\.title\)\s*===\s*albumKey\(album\.title\)\s*\)/
    );
    // The exact-equality form is what produced the duplicate card.
    expect(appHtml).not.toMatch(/findIndex\(\s*a\s*=>\s*a\.title\s*===\s*album\.title\s*\)/);
  });

  it('keys the artist album map on the normalised key too', () => {
    expect(appHtml).toMatch(/albumsMap\.set\(key,/);
    expect(appHtml).toMatch(/albumsMap\.get\(key\)\.tracks\.push/);
    // Keying the map on the raw title re-opens the same class of split.
    expect(appHtml).not.toMatch(/albumsMap\.(set|get)\(albumTitle[,)]/);
  });
});

describe('the grouping behaviour itself', () => {
  // Mirrors the shipped logic; the real EN 12 field shape, trailing space included.
  const albumKey = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();

  const EN12 = [
    { fields: { 'Album Title': 'Mama Said To Me + Bump Baby ', 'Album Artist': 'Ricky', 'Track Name': 'Mama Said to Me ' } },
    { fields: { 'Album Title': 'Mama Said To Me + Bump Baby ', 'Album Artist': 'Ricky', 'Track Name': 'Bump Baby ' } },
  ];

  const build = (items, clickedTitle) => {
    const map = new Map();
    for (const it of items) {
      const f = it.fields || {};
      const title = String(f['Album Title'] || 'Unknown Album').trim() || 'Unknown Album';
      const key = albumKey(title);
      if (!map.has(key)) map.set(key, { title, tracks: [] });
      map.get(key).tracks.push(f['Track Name']);
    }
    const albums = [...map.values()];
    const idx = albums.findIndex((a) => albumKey(a.title) === albumKey(clickedTitle));
    if (idx === -1) albums.unshift({ title: clickedTitle, tracks: [] });
    return albums;
  };

  it('EN 12 is one album, not two', () => {
    // detectArtistMatch hands over a TRIMMED title — the mismatch that caused it.
    const albums = build(EN12, 'Mama Said To Me + Bump Baby');
    expect(albums).toHaveLength(1);
    expect(albums[0].tracks).toHaveLength(2);
  });

  it('no empty phantom card is created', () => {
    const albums = build(EN12, 'Mama Said To Me + Bump Baby');
    expect(albums.every((a) => a.tracks.length > 0)).toBe(true);
  });

  it('tolerates case and internal whitespace differences', () => {
    const messy = [
      { fields: { 'Album Title': 'The  Best   Of', 'Track Name': 'A' } },
      { fields: { 'Album Title': 'the best of ', 'Track Name': 'B' } },
    ];
    expect(build(messy, 'The Best Of')).toHaveLength(1);
  });

  it('still separates genuinely different albums', () => {
    const two = [
      { fields: { 'Album Title': 'Album One', 'Track Name': 'A' } },
      { fields: { 'Album Title': 'Album Two', 'Track Name': 'B' } },
    ];
    expect(build(two, 'Album One')).toHaveLength(2);
  });
});
