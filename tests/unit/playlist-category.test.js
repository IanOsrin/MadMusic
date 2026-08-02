import { describe, it, expect } from 'vitest';
import { buildPlaylistCategoryMap, playlistCategoryLookup } from '../../lib/playlist.js';

const rec = (name, category) => ({ fieldData: { Playlist_Name: name, Category: category } });

describe('buildPlaylistCategoryMap', () => {
  it('keys by the same slug rule as the art map, so punctuation drift is tolerated', () => {
    const map = buildPlaylistCategoryMap([rec("MAD-About-Lucky-Dube", 'Artist')]);
    expect(playlistCategoryLookup(map, 'MAD About Lucky Dube')).toBe('Artist');
    expect(playlistCategoryLookup(map, '  mad-about-lucky-dube ')).toBe('Artist');
  });

  it('ignores records with no category, and returns "" for unknown playlists', () => {
    const map = buildPlaylistCategoryMap([rec('Mbaqanga', ''), rec('Maskandi', 'Scene')]);
    expect(map.size).toBe(1);
    expect(playlistCategoryLookup(map, 'Mbaqanga')).toBe('');
    expect(playlistCategoryLookup(map, 'Nothing')).toBe('');
    expect(playlistCategoryLookup(null, 'Maskandi')).toBe('');
  });
});

// The regression this fixes: the MAD About rail rendered every playlist that had
// a cover, so the first four Scene playlists appeared on it the moment they were
// given artwork. Mirrors the filter in routes/catalog/discovery.js.
describe('rail filtering by category', () => {
  const legacyArtist = (pl, want) =>
    !pl.category && want === 'artist' && /^MAD[\s_-]*About/i.test(pl.name || '');
  const forRail = (pls, cat) => {
    const want = cat.toLowerCase();
    return pls.filter(p => String(p.category || '').toLowerCase() === want || legacyArtist(p, want));
  };
  const PLAYLISTS = [
    { name: 'MAD-About-Lucky-Dube', category: 'Artist' },
    { name: 'MAD-About-Soul-Brothers', category: '' },   // not yet categorised
    { name: 'Mbaqanga',  category: 'Scene' },
    { name: 'Maskandi',  category: 'Scene' },
    { name: 'Afro Reggae', category: 'Scene' },
    { name: 'Gospel Spirit Selects', category: 'Scene' },
    { name: '1990s', category: '' }                       // uncategorised, not an artist
  ];

  it('keeps Scene playlists off the Artist rail', () => {
    const names = forRail(PLAYLISTS, 'Artist').map(p => p.name);
    expect(names).toContain('MAD-About-Lucky-Dube');
    expect(names).not.toContain('Mbaqanga');
    expect(names).not.toContain('Afro Reggae');
    expect(names).not.toContain('Gospel Spirit Selects');
  });

  it('still shows uncategorised MAD-About playlists, but nothing else uncategorised', () => {
    const names = forRail(PLAYLISTS, 'Artist').map(p => p.name);
    expect(names).toContain('MAD-About-Soul-Brothers');
    expect(names).not.toContain('1990s');
  });

  it('gives the Scene rail exactly the four Scene playlists', () => {
    expect(forRail(PLAYLISTS, 'Scene').map(p => p.name))
      .toEqual(['Mbaqanga', 'Maskandi', 'Afro Reggae', 'Gospel Spirit Selects']);
  });
});
