// Trending per-album cap (2026-07-11): at low traffic, one listener repeating
// an album filled every trending slot with the same cover. The rail keeps the
// TOP-ranKED track per album and backfills with other albums.
import { describe, it, expect, beforeAll } from 'vitest';

let collectValidResults, trendingAlbumKey;

beforeAll(async () => {
  const mod = await import('../../routes/catalog/trending.js');
  ({ collectValidResults, trendingAlbumKey } = mod);
});

// Minimal valid track record: visible, has audio + artwork.
function rec(id, { album, artist, cat, title }) {
  return {
    stat: { trackRecordId: id, playCount: 5, sessionIds: new Set(['s1']), lastEvent: 1700000000000 },
    record: {
      recordId: id,
      modId: '1',
      fieldData: {
        'Track Name': title || `Track ${id}`,
        'Album Title': album,
        'Album Artist': artist,
        'Album Catalogue Number': cat || '',
        'S3_URL': `https://s3.example.com/audio/${id}.mp3`,
        // NOTE: hasValidArtwork requires 'gmvi' in the URL (scan naming) —
        // see lib/track.js. Discogs 'DGS_*' sleeves fail this check (flagged
        // to Ian 2026-07-11).
        'Artwork_S3_URL': `https://s3.example.com/artwork/GMVi${id}.jpg`
      }
    }
  };
}

describe('trendingAlbumKey', () => {
  it('keys on catalogue number when present', () => {
    expect(trendingAlbumKey({ 'Album Catalogue Number': 'BL 480', 'Album Title': 'X' })).toBe('cat:bl 480');
  });
  it('falls back to title|||album-artist', () => {
    expect(trendingAlbumKey({ 'Album Title': 'Izulu', 'Album Artist': 'Amaswazi' })).toBe('ta:izulu|||amaswazi');
  });
  it('returns null when identity is unknowable (no accidental grouping)', () => {
    expect(trendingAlbumKey({})).toBeNull();
  });
});

describe('collectValidResults per-album cap', () => {
  it('keeps only the top-ranked track per album and backfills with other albums', () => {
    const fetched = [
      rec('1', { album: 'Repeat LP', artist: 'One Band', cat: 'RL 1' }),   // #1 — kept
      rec('2', { album: 'Repeat LP', artist: 'One Band', cat: 'RL 1' }),   // same album — dropped
      rec('3', { album: 'Repeat LP', artist: 'One Band', cat: 'RL 1' }),   // dropped
      rec('4', { album: 'Repeat LP', artist: 'One Band', cat: 'RL 1' }),   // dropped
      rec('5', { album: 'Other Album', artist: 'Two Band', cat: 'OA 2' }), // backfills #2
      rec('6', { album: 'Third Album', artist: 'Three Band', cat: 'TA 3' })// backfills #3
    ];
    const out = collectValidResults(fetched, 3);
    expect(out.map((r) => r.recordId)).toEqual(['1', '5', '6']);
  });

  it('ranking order decides WHICH track of the album survives (the first seen)', () => {
    const fetched = [
      rec('9', { album: 'Repeat LP', artist: 'One Band', cat: 'RL 1', title: 'Hit Song' }),
      rec('8', { album: 'Repeat LP', artist: 'One Band', cat: 'RL 1', title: 'Album Cut' })
    ];
    const out = collectValidResults(fetched, 5);
    expect(out).toHaveLength(1);
    expect(out[0].fields['Track Name']).toBe('Hit Song');
  });

  it('albums with unknowable identity are never grouped together', () => {
    const fetched = [
      { ...rec('1', { album: '', artist: '' }) },
      { ...rec('2', { album: '', artist: '' }) }
    ];
    const out = collectValidResults(fetched, 5);
    expect(out).toHaveLength(2); // both kept — no shared key
  });
});
