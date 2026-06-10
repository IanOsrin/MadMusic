import { describe, it, expect, afterEach } from 'vitest';
import { thumbArtworkUrl, applyArtworkThumbs } from '../../lib/track.js';

const MASTER = 'https://mass-music-audio-files.s3.eu-north-1.amazonaws.com/artwork/GMVi4460.jpg';
const THUMB300 = 'https://mass-music-audio-files.s3.eu-north-1.amazonaws.com/artwork/resized/GMVi4460_300.webp';
const THUMB800 = 'https://mass-music-audio-files.s3.eu-north-1.amazonaws.com/artwork/resized/GMVi4460_800.webp';

describe('thumbArtworkUrl', () => {
  it('rewrites a master jpg to the 300px webp derivative', () => {
    expect(thumbArtworkUrl(MASTER, 300)).toBe(THUMB300);
  });
  it('rewrites to 800px when asked', () => {
    expect(thumbArtworkUrl(MASTER, 800)).toBe(THUMB800);
  });
  it('preserves a query string', () => {
    expect(thumbArtworkUrl(MASTER + '?v=2', 300)).toBe(THUMB300 + '?v=2');
  });
  it('passes through an already-resized URL unchanged', () => {
    expect(thumbArtworkUrl(THUMB300, 300)).toBe(THUMB300);
  });
  it('passes through non-master URLs (FM container, etc.) unchanged', () => {
    const fm = 'https://fm.example.com/Streaming/MainDB/abc?RCType=RCFileProcessor';
    expect(thumbArtworkUrl(fm, 300)).toBe(fm);
    expect(thumbArtworkUrl('', 300)).toBe('');
    expect(thumbArtworkUrl(null, 300)).toBe(null);
  });
});

describe('applyArtworkThumbs', () => {
  const prev = process.env.ARTWORK_THUMBS;
  afterEach(() => { process.env.ARTWORK_THUMBS = prev; });

  it('rewrites both artwork fields when the flag is on', () => {
    process.env.ARTWORK_THUMBS = 'true';
    const out = applyArtworkThumbs({ 'Artwork_S3_URL': MASTER, 'Tape Files::Artwork_S3_URL': MASTER }, 300);
    expect(out['Artwork_S3_URL']).toBe(THUMB300);
    expect(out['Tape Files::Artwork_S3_URL']).toBe(THUMB300);
  });

  it('is a no-op when the flag is off', () => {
    process.env.ARTWORK_THUMBS = 'false';
    const out = applyArtworkThumbs({ 'Artwork_S3_URL': MASTER }, 300);
    expect(out['Artwork_S3_URL']).toBe(MASTER);
  });

  it('leaves non-artwork fields untouched', () => {
    process.env.ARTWORK_THUMBS = 'true';
    const out = applyArtworkThumbs({ 'Album Title': 'X', 'Artwork_S3_URL': MASTER }, 300);
    expect(out['Album Title']).toBe('X');
  });

  it('tolerates missing/empty input', () => {
    process.env.ARTWORK_THUMBS = 'true';
    expect(applyArtworkThumbs(null, 300)).toBe(null);
    expect(applyArtworkThumbs({}, 300)).toEqual({});
  });
});
