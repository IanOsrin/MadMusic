import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

// Featured artists under the song title on album pages (Ian, 2026-11-06).
// FileMaker field "Featured Artist" on API_Album_Songs → "feat. A & B" on the small
// line under each song's title, desktop album page and phone album sheet.
// Cases below are real test-site records from that day.

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

// Desktop line = albumTrackLine without alwaysArtist.
const D = (trackArtist, albumArtist, featured, title) => H.albumTrackLine({ trackArtist, albumArtist, featured, title });

describe('albumTrackLine — desktop album page', () => {
  it('guest written into Track Artist: shows only "feat."', () => {
    expect(D('Philisiwe Ntintili Feat Novexbeats', 'Philisiwe Ntintili', 'Novexbeats', 'Buya Ekhaya Bakulindile')).toBe('feat. Novexbeats');
    expect(D('D F W N E And Novex', 'D F W N E', 'Novex', 'Fettered')).toBe('feat. Novex');
  });
  it('";" lists from FileMaker (the Lelowhatsgood album)', () => {
    const AA = 'Lelowhatsgood';
    expect(D('Lelowhatsgood And DJ Emotic And Kiing Bhutie', AA, 'DJ Emotic; Kiing Bhutie', 'HypnoSIS')).toBe('feat. DJ Emotic & Kiing Bhutie');
    expect(D('Lelowhatsgood And Lazarusman Feat Kiing Bhutie', AA, 'Kiing Bhutie; Lazarusman', 'Mind ur Business')).toBe('feat. Kiing Bhutie & Lazarusman');
    expect(D('Lelowhatsgood And Unkle Ken And Rifle Deep Feat Thobeka And SunOrnza', AA, 'Unkle Ken; Rifle Deep; Thobeka; SunOrnza', 'Ngiwlomn Gogo'))
      .toBe('feat. Unkle Ken, Rifle Deep, Thobeka & SunOrnza');
    expect(D('Lelowhatsgood And Joshua Futura And Omagoqa Feat Larny And Naitor', AA, 'Omagoqa; Larny; Naitor; Joshua Futura', 'Ten Toes'))
      .toBe('feat. Omagoqa, Larny, Naitor & Joshua Futura');
  });
  it("drops field names that are the album's own artists", () => {
    const AA = 'Lelowhatsgood And Dee Traits';
    expect(D('Lelowhatsgood And Dee Traits', AA, 'Lelowhatsgood', 'Voices')).toBe('');
    expect(D('Lelowhatsgood And Dee Traits Feat Omagoqa', AA, 'Omagoqa; Lelowhatsgood', 'Ngaze Ngasha')).toBe('feat. Omagoqa');
    expect(D('Babes Wodumo And Lelowhatsgood And Unkle Ken Feat Madanon And Rifle Deep', 'Babes Wodumo And Lelowhatsgood And Unkle Ken',
      'Madanon; Lelowhatsgood; Unkle Ken; Rifle Deep', 'Ekhoneni')).toBe('feat. Madanon & Rifle Deep');
  });
  it('compilation: keeps the song artist, then the guest', () => {
    expect(D('Tee, Facazile', 'Various Artists', 'Facazile', 'Crazy')).toBe('Tee · feat. Facazile');
  });
  it('several guests separated by commas', () => {
    expect(D('uSingil feat. DJ Dansanie, Shakes Ngema', 'uSingil', 'DJ Dansanie, Shakes Ngema', 'Bra Wami')).toBe('feat. DJ Dansanie & Shakes Ngema');
  });
  it('guest already in the title is not repeated', () => {
    expect(D('Joe Nina', 'Joe Nina', 'Juma', 'Nomathemba (Feat. Juma)')).toBe('');
  });
  it('no featured artist: as before (track artist only when it differs)', () => {
    expect(D('Joe Nina', 'Joe Nina', '', 'Song')).toBe('');
    expect(D('Tee, Facazile', 'Various Artists', '', 'Crazy')).toBe('Tee, Facazile');
  });
  it('does not cut a name that only contains the guest', () => {
    expect(H.stripFeaturedArtist('Novexbeats Crew', ['Novex'])).toBe('Novexbeats Crew');
    expect(H.stripFeaturedArtist('Novex', ['Novex'])).toBe('Novex');
  });
});

describe('albumTrackLine — phone album sheet', () => {
  it('always shows the artist, then the guests', () => {
    expect(H.albumTrackLine({ trackArtist: 'Lelowhatsgood And DJ Emotic And Kiing Bhutie', albumArtist: 'Lelowhatsgood',
      featured: 'DJ Emotic; Kiing Bhutie', title: 'HypnoSIS', alwaysArtist: true })).toBe('Lelowhatsgood · feat. DJ Emotic & Kiing Bhutie');
  });
  it('artist page: album name, then the guests', () => {
    expect(H.albumTrackLine({ line: 'Some Album', albumArtist: 'Lelowhatsgood', featured: 'DJ Emotic', title: 'HypnoSIS' })).toBe('Some Album · feat. DJ Emotic');
  });
});

describe('album pages use it', () => {
  it('desktop: every album-page track builder carries featuredArtist', () => {
    const n = (html.match(/featuredArtist:\s*window\.MADHelpers\.getFeaturedArtist\(f\)/g) || []).length;
    expect(n).toBeGreaterThanOrEqual(3);
    expect(html).toMatch(/albumTrackLine\(\{[\s\S]{0,160}featured: track\.featuredArtist/);
  });
  it('phone: album sheet rows add the featured artist', () => {
    expect(cards).toMatch(/albumTrackLine\(/);
    expect(cards).toMatch(/getFeaturedArtist\(fields\)/);
  });
});
