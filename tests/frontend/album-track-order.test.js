import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Guard for the album track-order bug (2026-07-31).
//
// /api/search sorts results by RELEVANCE to the query (routes/catalog/search.js),
// never by position on the record. The album detail view read that response
// straight into album.tracks, never looked at the sequence field at all, and
// numbered the rendered rows 1..n by array index. So an album whose API response
// came back as 7,11,12,3,10,1,... was displayed in that order and labelled
// 1,2,3,... — every number wrong, and the running order wrong with it.
//
// Verified against production data before the fix: "Uhambo Lwami" by Mahlathini
// and the Mahotella Queens returns 7,11,12,3,10,1,9,4,2,8,6,5.

let html;

beforeAll(async () => {
  html = await readFile(path.resolve('public/app.html'), 'utf8');
});

describe('album tracks carry their sequence number', () => {
  it('reads a sequence field when building tracks', () => {
    expect(html).toMatch(/const _trackSeq = /);
    expect(html).toContain("f['Sequence Number']");
  });

  it('attaches seq to every track object the album view builds', () => {
    // Both builders: the artist-search grouping and the by-title fallback.
    const matches = html.match(/seq:\s*_trackSeq\(f\)/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe('album tracks render in album order', () => {
  it('sorts in place before rendering', () => {
    // In place matters: rendered rows carry data-track-index values that index
    // back into this same array, so sorting a copy would mis-wire play buttons.
    expect(html).toMatch(/const _sortByTrackSeq = /);
    expect(html).toMatch(/_sortByTrackSeq\(album\.tracks\)/);
  });

  it('sorts before any consumer reads the array', () => {
    const panel = html.indexOf('window.showAlbumDetailPanel = async function(album)');
    const sort = html.indexOf('_sortByTrackSeq(album.tracks)', panel);
    const render = html.indexOf('trackList.innerHTML = album.tracks.map', panel);
    expect(panel).toBeGreaterThan(-1);
    expect(sort).toBeGreaterThan(panel);
    expect(sort).toBeLessThan(render);
  });

  it('displays the real track number, not the row position', () => {
    // `${index + 1}` alone was the bug — it renumbers whatever order it is given.
    expect(html).toMatch(/playlist-track-number">\$\{Number\.isFinite\(track\.seq\)/);
  });

  it('falls back to row position when a track has no sequence', () => {
    const span = html.match(/playlist-track-number">\$\{[^}]*\}/);
    expect(span).not.toBeNull();
    expect(span[0]).toContain('index + 1');
  });
});

describe('mobile album lists share the same ordering logic', () => {
  // Mobile has its own playback engine and its own album grouping in FOUR
  // places. It showed the same scrambled order as desktop, just without visible
  // track numbers to make it obvious.
  let helpers, mobileFields;

  beforeAll(async () => {
    helpers = await readFile(path.resolve('public/js/helpers.js'), 'utf8');
    mobileFields = await readFile(path.resolve('public/js/mobile/fields.js'), 'utf8');
  });

  it('the canonical implementation lives in MADHelpers', () => {
    expect(helpers).toMatch(/function getTrackSeq\(/);
    expect(helpers).toMatch(/function sortTracksBySeq\(/);
    expect(helpers).toMatch(/window\.MADHelpers\.getTrackSeq\s*=/);
    expect(helpers).toMatch(/window\.MADHelpers\.sortTracksBySeq\s*=/);
  });

  it('mobile delegates rather than growing a local copy', () => {
    // CLAUDE.md invariant: mobile field helpers are thin delegations. A local
    // reimplementation is how the two apps drifted apart before.
    expect(mobileFields).toMatch(/export function sortTracksBySeq\(tracks\)\s*\{\s*return window\.MADHelpers\.sortTracksBySeq\(tracks\);/);
    expect(mobileFields).toMatch(/export function getTrackSeq\(fields\)\s*\{\s*return window\.MADHelpers\.getTrackSeq\(fields\);/);
  });

  it('every mobile album-grouping site sorts its tracks', async () => {
    const sites = [
      'public/js/mobile/fields.js',          // groupTracksByAlbum (shared)
      'public/js/mobile/rails-discover.js',
      'public/js/mobile/rails-newreleases.js',
      'public/js/mobile/rails-g100.js',
    ];
    for (const site of sites) {
      const code = await readFile(path.resolve(site), 'utf8');
      expect(code, `${site} must sort album tracks`).toMatch(/sortTracksBySeq\(/);
    }
  });

  it('sorts in place so data-track-index and playlistContext stay aligned', () => {
    // Returning a sorted COPY would leave rendered rows and the now-playing
    // queue pointing at the old order (mobile invariant 4).
    const fn = helpers.slice(helpers.indexOf('function sortTracksBySeq('), helpers.indexOf('function sortTracksBySeq(') + 700);
    expect(fn).toMatch(/tracks\.sort\(/);
    expect(fn).not.toMatch(/\[\.\.\.tracks\]|tracks\.slice\(\)/);
  });
});
