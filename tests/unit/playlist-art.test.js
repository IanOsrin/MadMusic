import { describe, it, expect } from 'vitest';
import { buildPlaylistArtMap, playlistArtLookup } from '../../lib/playlist.js';

const rec = (fieldData) => ({ fieldData });
const S3 = 'https://mass-music-audio-files.s3.eu-north-1.amazonaws.com/playlist-art';

describe('buildPlaylistArtMap', () => {
  it('maps Playlist_Name (slugified) → Image_S3_URL, http(s) only', () => {
    const map = buildPlaylistArtMap([
      rec({ Playlist_Name: 'Salute Lucky Dube', Image_S3_URL: `${S3}/lucky-dube.webp` }),
      rec({ Playlist_Name: 'Jazz', Image_S3_URL: `${S3}/jazz.webp` }),
      rec({ Playlist_Name: 'No URL', Image_S3_URL: '' }),          // skipped: no url
      rec({ Playlist_Name: 'Bad', Image_S3_URL: 'not-a-url' }),    // skipped: not http(s)
      rec({ Playlist_Name: '', Image_S3_URL: `${S3}/x.webp` }),    // skipped: no name
    ]);
    expect(map.size).toBe(2);
    expect(map.get('salute-lucky-dube')).toBe(`${S3}/lucky-dube.webp`);
    expect(map.get('jazz')).toBe(`${S3}/jazz.webp`);
  });

  it('first record wins on a duplicate slug', () => {
    const map = buildPlaylistArtMap([
      rec({ Playlist_Name: 'Soul', Image_S3_URL: `${S3}/first.webp` }),
      rec({ Playlist_Name: 'soul', Image_S3_URL: `${S3}/second.webp` }),
    ]);
    expect(map.get('soul')).toBe(`${S3}/first.webp`);
  });
});

describe('playlistArtLookup', () => {
  const map = buildPlaylistArtMap([
    rec({ Playlist_Name: 'Salute Lucky Dube', Image_S3_URL: `${S3}/ld.webp` }),
  ]);
  it('matches tolerantly on case/spacing (via slug)', () => {
    expect(playlistArtLookup(map, 'Salute Lucky Dube')).toBe(`${S3}/ld.webp`);
    expect(playlistArtLookup(map, '  salute   lucky dube ')).toBe(`${S3}/ld.webp`);
  });
  it('returns null for an unknown playlist or bad args', () => {
    expect(playlistArtLookup(map, 'Jazz')).toBeNull();
    expect(playlistArtLookup(null, 'Jazz')).toBeNull();
    expect(playlistArtLookup(map, '')).toBeNull();
  });
});
