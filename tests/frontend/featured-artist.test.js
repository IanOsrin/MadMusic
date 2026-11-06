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
