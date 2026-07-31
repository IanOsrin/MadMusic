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
