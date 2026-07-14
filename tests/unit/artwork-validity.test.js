// hasValidArtwork (2026-07-11): was `url.includes('gmvi')`, which hid every
// non-GMVi-named sleeve (e.g. the DGS_ Discogs uploads) from the rails — and
// doubled as the broken-placeholder filter. Now: named-file check + explicit
// placeholder rejection.
import { describe, it, expect } from 'vitest';
import { hasValidArtwork } from '../../lib/track.js';

const S3 = 'https://mass-music-audio-files.s3.eu-north-1.amazonaws.com';
const withArt = (url) => ({ 'Artwork_S3_URL': url });

describe('hasValidArtwork', () => {
  it('accepts GMVi-named scans (the historical convention)', () => {
    expect(hasValidArtwork(withArt(`${S3}/artwork/GMVi4460.jpg`))).toBe(true);
  });

  it('accepts DGS_ Discogs sleeves and any other properly-named artwork file', () => {
    expect(hasValidArtwork(withArt(`${S3}/artwork/DGS_BL_392.jpg`))).toBe(true);
    expect(hasValidArtwork(withArt(`${S3}/artwork/GMVc100000.jpg`))).toBe(true); // the typo stray
    expect(hasValidArtwork(withArt(`${S3}/artwork/Playlist_Jazz.png`))).toBe(true);
  });

  it('accepts pre-resized derivative URLs', () => {
    expect(hasValidArtwork(withArt(`${S3}/artwork/resized/GMVi4460_300.webp`))).toBe(true);
    expect(hasValidArtwork(withArt(`${S3}/artwork/resized/DGS_BL_392_300.webp`))).toBe(true);
  });

  it('REJECTS the broken ingest placeholder (no filename) — 2,360 records carry it', () => {
    expect(hasValidArtwork(withArt(`${S3}/artwork/.jpg`))).toBe(false);
  });

  it('rejects empty/missing/off-prefix values', () => {
    expect(hasValidArtwork(withArt(''))).toBe(false);
    expect(hasValidArtwork({})).toBe(false);
    expect(hasValidArtwork(withArt('https://elsewhere.example.com/cover.jpg'))).toBe(false);
  });

  it('falls back to the Tape Files:: related field', () => {
    expect(hasValidArtwork({ 'Tape Files::Artwork_S3_URL': `${S3}/artwork/DGS_ERH_2044.jpg` })).toBe(true);
  });
});
