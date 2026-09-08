// Guards the catalogue slug INDEX BUILD (SEO tier 2) — not just slugify().
//
// Why this file exists: on 2 Sep 2026 recordIsVisible() grew an eligibility
// check needing ISRC, UPC and artwork. buildIndex() was filtering with a stub
// object carrying only Visibility, so every album failed, the index built
// empty, and /browse, /album/:slug, /artist/:slug and the sitemap were dead for
// six days. Nothing failed — catalog-slugs.test.js only covered slugify(), which
// kept passing throughout. These tests exercise the real build against a mocked
// Postgres so a caller that stops passing whole records fails here instead.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const rows = [];
vi.mock('../../lib/pg.js', () => ({
  query: async () => ({ rows }),
  isPgEnabled: () => true,
}));

const { getIndex, _resetIndexForTests } = await import('../../lib/catalog-slugs.js');

// A row shaped like the mirror's columns, eligible by default.
const track = (over = {}) => ({
  title: 'Dancing Round The World',
  artist: 'Dan Hill and His Orchestra',
  cat: 'FCL 5216',
  artwork: 'https://media.example.com/artwork/GMVi5276.jpg',
  year: '1963',
  genre: 'Instrumental',
  visibility: 'Show',
  isrc: 'ZAC032412542',
  upc: '6009555162274',
  ...over,
});

const build = async (data) => {
  rows.length = 0;
  rows.push(...data);
  _resetIndexForTests();
  return getIndex();
};

describe('catalog slug index build', () => {
  beforeEach(() => _resetIndexForTests());

  it('builds an album from eligible tracks — the regression guard', async () => {
    const idx = await build([track(), track({ isrc: 'ZAC032412543' })]);
    expect(idx.albums.size).toBe(1);
    expect(idx.artists.size).toBe(1);

    const album = idx.albums.get('dancing-round-the-world-dan-hill-and-his-orchestra');
    expect(album).toBeDefined();
    expect(album.tracks).toBe(2);
    expect(album.year).toBe('1963');
    expect(album.cat).toBe('FCL 5216');
  });

  it('NEVER builds empty from a populated mirror', async () => {
    const idx = await build([track(), track({ title: 'Strictly Cha Cha' })]);
    // The exact symptom of the Sep 2026 outage: rows in, nothing out.
    expect(idx.albums.size).toBeGreaterThan(0);
    expect(idx.artists.size).toBeGreaterThan(0);
  });

  it('excludes albums whose tracks all fail eligibility', async () => {
    const idx = await build([
      track({ isrc: '' }),
      track({ upc: '', isrc: 'ZAC1' }),
      track({ artwork: '', isrc: 'ZAC2' }),
    ]);
    expect(idx.albums.size).toBe(0);
  });

  it('keeps an album with one eligible track, and counts only eligible tracks', async () => {
    const idx = await build([
      track(),
      track({ isrc: '' }),          // ineligible — must not be counted
      track({ upc: '' }),           // ineligible — must not be counted
    ]);
    const album = idx.albums.get('dancing-round-the-world-dan-hill-and-his-orchestra');
    expect(album).toBeDefined();
    expect(album.tracks).toBe(1);
  });

  it('fills album fields from whichever track carries them', async () => {
    // The old min() aggregate returned '' whenever ANY track had the field blank.
    const idx = await build([
      track({ cat: '', year: '', genre: '', artwork: 'https://media.example.com/artwork/x.jpg' }),
      track({ isrc: 'ZAC2' }),
    ]);
    const album = idx.albums.get('dancing-round-the-world-dan-hill-and-his-orchestra');
    expect(album.cat).toBe('FCL 5216');
    expect(album.year).toBe('1963');
    expect(album.genre).toBe('Instrumental');
  });

  it('separates albums that share a title but not an artist', async () => {
    const idx = await build([
      track(),
      track({ artist: 'Someone Else', isrc: 'ZAC9' }),
    ]);
    expect(idx.albums.size).toBe(2);
    expect(idx.artists.size).toBe(2);
    // Collision resolution: first claimant (sorted) keeps the bare slug.
    expect([...idx.albums.keys()].every((s) => s.startsWith('dancing-round-the-world'))).toBe(true);
  });

  it('counts each genre once per album', async () => {
    const idx = await build([
      track(), track({ isrc: 'ZAC2' }),
      track({ title: 'Strictly Cha Cha', isrc: 'ZAC3' }),
      track({ title: 'Hits Electronic', genre: 'Jazz', isrc: 'ZAC4' }),
    ]);
    expect(idx.genres.get('instrumental').albums).toBe(2);
    expect(idx.genres.get('jazz').albums).toBe(1);
  });
});
