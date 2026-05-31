// Guards album grouping in public/js/helpers.js (window.MADHelpers).
//
// Regression: getArtistField was made track-first (correct for track display),
// but album grouping must key on the ALBUM artist — otherwise a compilation
// ("many artists on one album", e.g. the G100 "100 Years of Gallo") fragments
// into one card per track artist. groupByAlbum + getAlbumArtist must collapse it.
//
// helpers.js is a browser global script, so we evaluate it in a vm with a window
// shim and exercise the exposed window.MADHelpers API.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));

let H;
beforeAll(() => {
  const code = readFileSync(join(__dirname, '..', '..', 'public', 'js', 'helpers.js'), 'utf8');
  const sandbox = { localStorage: { getItem: () => null, setItem: () => {} }, console };
  sandbox.window = sandbox; // window.X and bare top-level X resolve to the same object
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  H = sandbox.window.MADHelpers;
});

const art = 'https://x.s3.amazonaws.com/cover.jpg';
const compilation = [
  { fields: { 'Album Title': '100 Years of Gallo', 'Album Artist': 'Various Artists', 'Track Artist': 'Miriam Makeba', 'Track Name': 'Pata Pata', 'Artwork_S3_URL': art } },
  { fields: { 'Album Title': '100 Years of Gallo', 'Album Artist': 'Various Artists', 'Track Artist': 'Hugh Masekela', 'Track Name': 'Grazing', 'Artwork_S3_URL': art } },
  { fields: { 'Album Title': '100 Years of Gallo', 'Album Artist': 'Various Artists', 'Track Artist': 'Lucky Dube', 'Track Name': 'Together', 'Artwork_S3_URL': art } },
];

describe('helpers album grouping', () => {
  it('collapses a many-artist album into ONE album card', () => {
    const albums = H.groupByAlbum(compilation);
    expect(albums.length, 'compilation should be one album, not one-per-track-artist').toBe(1);
    expect(albums[0].tracks.length).toBe(3);
    expect(albums[0].artist).toBe('Various Artists');
  });

  it('getAlbumArtist prefers the album artist; getArtistField prefers the track artist', () => {
    const f = compilation[0].fields;
    expect(H.getAlbumArtist(f)).toBe('Various Artists');
    expect(H.getArtistField(f)).toBe('Miriam Makeba');
  });
});
