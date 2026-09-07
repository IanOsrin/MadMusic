// User-chosen playlist icons: the url whitelist and the master→derivative
// rewrite. The whitelist matters because the value is written to FM and
// rendered into an <img> for every viewer of a shared playlist, so anything
// off-origin has to be rejected rather than stored.
import { describe, it, expect } from 'vitest';
import {
  S3_ARTWORK_BASE, normalizePlaylistArtwork, playlistThumbUrl, sanitizePlaylistForShare
} from '../../lib/playlist.js';

const ICON = `${S3_ARTWORK_BASE}playlist-icon-jazz.jpg`;

describe('normalizePlaylistArtwork', () => {
  it('accepts a url under our own artwork prefix', () => {
    expect(normalizePlaylistArtwork(ICON)).toBe(ICON);
  });

  it('accepts an already-resized derivative', () => {
    const d = `${S3_ARTWORK_BASE}resized/playlist-icon-jazz_300.webp`;
    expect(normalizePlaylistArtwork(d)).toBe(d);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizePlaylistArtwork(`  ${ICON}  `)).toBe(ICON);
  });

  it.each([
    ['off-origin host',   'https://evil.example.com/artwork/playlist-icon-jazz.jpg'],
    ['prefix as a path',  'https://evil.example.com/?x=' + S3_ARTWORK_BASE],
    ['protocol-relative', '//mass-music-audio-files.s3.eu-north-1.amazonaws.com/artwork/x.jpg'],
    ['javascript url',    'javascript:alert(1)'],
    ['a different prefix on the same bucket',
      'https://mass-music-audio-files.s3.eu-north-1.amazonaws.com/audio/track.mp3'],
    ['traversal out of the prefix', `${S3_ARTWORK_BASE}../audio/track.mp3`],
  ])('rejects %s', (_label, value) => {
    expect(normalizePlaylistArtwork(value)).toBe('');
  });

  it.each([null, undefined, 42, {}, []])('rejects non-strings (%s)', (value) => {
    expect(normalizePlaylistArtwork(value)).toBe('');
  });
});

describe('playlistThumbUrl', () => {
  it('rewrites a master to the 300px derivative', () => {
    expect(playlistThumbUrl(ICON, 300))
      .toBe(`${S3_ARTWORK_BASE}resized/playlist-icon-jazz_300.webp`);
  });

  it('rewrites to 800 when asked', () => {
    expect(playlistThumbUrl(ICON, 800))
      .toBe(`${S3_ARTWORK_BASE}resized/playlist-icon-jazz_800.webp`);
  });

  it('defaults to 300 for any other size', () => {
    expect(playlistThumbUrl(ICON, 1200)).toContain('_300.webp');
  });

  it('handles .png and .jpeg masters', () => {
    expect(playlistThumbUrl(`${S3_ARTWORK_BASE}a.png`)).toContain('a_300.webp');
    expect(playlistThumbUrl(`${S3_ARTWORK_BASE}b.jpeg`)).toContain('b_300.webp');
  });

  it('leaves an already-resized url alone', () => {
    const d = `${S3_ARTWORK_BASE}resized/playlist-icon-jazz_300.webp`;
    expect(playlistThumbUrl(d)).toBe(d);
  });

  it('passes through empty values', () => {
    expect(playlistThumbUrl('')).toBe('');
    expect(playlistThumbUrl(null)).toBe(null);
  });
});

describe('sanitizePlaylistForShare carries the icon', () => {
  it('includes a valid artwork url', () => {
    expect(sanitizePlaylistForShare({ id: 'p1', name: 'Mine', artwork: ICON }).artwork).toBe(ICON);
  });

  it('blanks an off-origin artwork url rather than passing it to viewers', () => {
    const out = sanitizePlaylistForShare({ id: 'p1', name: 'Mine', artwork: 'https://evil.example.com/x.jpg' });
    expect(out.artwork).toBe('');
  });
});
