import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

// Featured artists under the song title on album pages (Ian, 2026-11-06).
// FileMaker field "Featured Artist" on API_Album_Songs → "feat. X" on the small
// line under each song's title, desktop album page and phone album sheet.

let H, html, cards;

beforeAll(async () => {
  const src = await readFile(path.resolve('public/js/helpers.js'), 'utf8');
  const ctx = { window: {}, console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  H = ctx.window.MADHelpers;
  html = await readFile(path.resolve('public/app.html'), 'utf8');
  cards = await readFile(path.resolve('public/js/mobile/cards.js'), 'utf8');
});

describe('getFeaturedArtist', () => {
  it('reads the FileMaker field', () => {
    expect(H.getFeaturedArtist({ 'Featured Artist': 'Novex' })).toBe('Novex');
  });
  it('is empty when the field is missing or blank', () => {
    expect(H.getFeaturedArtist({})).toBe('');
    expect(H.getFeaturedArtist({ 'Featured Artist': '  ' })).toBe('');
    expect(H.getFeaturedArtist(undefined)).toBe('');
  });
  it('drops a "feat." typed into the field', () => {
    expect(H.getFeaturedArtist({ 'Featured Artist': 'feat. Novex' })).toBe('Novex');
    expect(H.getFeaturedArtist({ 'Featured Artist': 'Featuring Novex' })).toBe('Novex');
  });
});

describe('withFeaturedArtist', () => {
  it('shows "feat. X" alone when the song has no line of its own', () => {
    expect(H.withFeaturedArtist('', 'Novex', 'Song')).toBe('feat. Novex');
  });
  it('adds it after the song artist', () => {
    expect(H.withFeaturedArtist('Tee', 'Novex', 'Song')).toBe('Tee · feat. Novex');
  });
  it('never names a guest twice', () => {
    expect(H.withFeaturedArtist('The Parlotones feat. Zolani Mahola', 'Zolani Mahola', 'Stardust')).toBe('The Parlotones feat. Zolani Mahola');
    expect(H.withFeaturedArtist('', 'Juma', 'Nomathemba (Feat. Juma)')).toBe('');
  });
  it('leaves the line alone when there is no guest', () => {
    expect(H.withFeaturedArtist('Tee', '', 'Song')).toBe('Tee');
    expect(H.withFeaturedArtist('', '', 'Song')).toBe('');
  });
});

describe('stripFeaturedArtist (the line comes from the Featured Artist field, not Track Artist)', () => {
  // Real test-site records, 2026-11-06.
  it('takes "Feat X" off the end', () => {
    expect(H.stripFeaturedArtist('Philisiwe Ntintili Feat Novexbeats', 'Novexbeats')).toBe('Philisiwe Ntintili');
    expect(H.stripFeaturedArtist('The Parlotones feat. Zolani Mahola', 'Zolani Mahola')).toBe('The Parlotones');
  });
  it('takes "And X" / ", X" / "& X" off', () => {
    expect(H.stripFeaturedArtist('D F W N E And Novex', 'Novex')).toBe('D F W N E');
    expect(H.stripFeaturedArtist('Tee, Facazile', 'Facazile')).toBe('Tee');
    expect(H.stripFeaturedArtist('Steve Group, Tiro & Spirit', 'Tiro')).toBe('Steve Group & Spirit');
  });
  it('handles several guests in the field', () => {
    expect(H.stripFeaturedArtist('uSingil feat. DJ Dansanie, Shakes Ngema', 'DJ Dansanie, Shakes Ngema')).toBe('uSingil');
  });
  it('does not cut a name that only contains the guest', () => {
    expect(H.stripFeaturedArtist('Novexbeats Crew', 'Novex')).toBe('Novexbeats Crew');
    expect(H.stripFeaturedArtist('Novex', 'Novex')).toBe('Novex');
  });
  it('leaves Track Artist alone without a featured artist', () => {
    expect(H.stripFeaturedArtist('Tee, Facazile', '')).toBe('Tee, Facazile');
  });
  it('end to end: the desktop line for the Novex songs', () => {
    const line = (ta, aa, feat, title) => {
      const s = H.stripFeaturedArtist(ta, feat);
      return H.withFeaturedArtist(s.toLowerCase() === aa.toLowerCase() ? '' : s, feat, title);
    };
    expect(line('Philisiwe Ntintili Feat Novexbeats', 'Philisiwe Ntintili', 'Novexbeats', 'Buya Ekhaya Bakulindile')).toBe('feat. Novexbeats');
    expect(line('D F W N E And Novex', 'D F W N E', 'Novex', 'Fettered')).toBe('feat. Novex');
    expect(line('Tee, Facazile', 'Various Artists', 'Facazile', 'Crazy')).toBe('Tee · feat. Facazile');
  });
});

describe('album pages use it', () => {
  it('desktop: every album-page track builder carries featuredArtist', () => {
    const n = (html.match(/featuredArtist:\s*window\.MADHelpers\.getFeaturedArtist\(f\)/g) || []).length;
    expect(n).toBeGreaterThanOrEqual(3);
    expect(html).toMatch(/withFeaturedArtist\(line, track\.featuredArtist, track\.name\)/);
  });
  it('phone: album sheet rows add the featured artist', () => {
    expect(cards).toMatch(/withFeaturedArtist\(/);
    expect(cards).toMatch(/getFeaturedArtist\(fields\)/);
  });
});
