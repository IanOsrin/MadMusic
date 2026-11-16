// Ian, 2026-11-09: "it plays then stops, we actually want it to carry on with other songs".
// Static guards; the behaviour itself needs a browser (real audio events).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p) => readFileSync(resolve(process.cwd(), p), 'utf8');
const app = read('public/app.html');
const player = read('public/js/player.js');
const phone = read('public/js/mobile/player.js');
const stream = read('routes/stream.js');

describe('music carries on when a song ends', () => {
  it('desktop falls back to more songs when nothing else has a next one', () => {
    const ended = app.slice(app.indexOf('End-of-track auto-advance for queues'));
    expect(ended.slice(0, 700)).toMatch(/_carryOn\(false\)/);
    expect(player).toMatch(/moreSongsAfter:\s*_randomSongsRefill/);
  });

  it('songs with no recordId (podcasts) are not followed by music', () => {
    expect(app).toMatch(/var lastId = _meta && _meta\.recordId;[\s\S]{0,120}if \(!lastId/);
  });

  it('a banner song drops any earlier queue, so an old album cannot resume after it', () => {
    const hero = app.slice(app.indexOf('function editorialAction(it)'));
    expect(hero.slice(0, 2000)).toMatch(/window\.MADClaimQueue\(null\);\s*\n\s*\/\/ In guest mode/);
  });

  it('a card play runs on through its rail', () => {
    expect(app).toMatch(/window\.MADClaimQueue\(_songQueue\(ids, idx\)\)/);
    expect(app).toMatch(/var q = \{ ids: ids, idx: idx, autoEnded: true \}/);
  });

  it('every row queue reports when there is no next row', () => {
    expect(app).toMatch(/if \(!rows\[i\]\) return false;/);
    expect(read('public/js/catalog.js').match(/if \(!r\) return false; r\.click\(\);/g)).toHaveLength(2);
  });

  it('guests move on at the 30-second mark too', () => {
    expect(app).toMatch(/else if \(!_advanceQueue\(\)\) setTimeout\(function \(\) \{ _carryOn\(true\); \}/);
  });

  it('a banner song supplies its genre, on both desktop and phone', () => {
    expect(stream).toMatch(/const \{ url, field, artworkUrl, genre, _cached \} = resolved;/);
    expect(player).toMatch(/\/container'\);\s*\n\s*if \(r\.ok\) genre = /);
    expect(phone).toMatch(/\/container`\);\s*\n\s*if \(r\.ok\) genre = /);
  });
});

// Ian, 2026-11-16: "move to the first album on the suggested for you rail and then stay in that
// rail ... if the customer does not have a suggested for you rail yet you go to the playlist of
// the theme he was last listening to, finally ... a random selection". Runs js/next-music.js
// against made-up answers from the server.
import vm from 'node:vm';

const THEMES = [{ name: 'Maskandi' }, { name: 'House' }, { name: 'Gospel Spirit Selects' }, { name: 'Afro Reggae' }, { name: 'Gqom' }];
const song = (id) => ({ recordId: String(id), fields: { 'Track Name': 't' + id, S3_URL: 'https://media.example/' + id + '.mp3' } });
const themeTrack = (id) => ({ recordId: String(id), name: 't' + id, resolvedSrc: 'https://media.example/' + id + '.mp3' });

function loadPicker({ rail = [], albums = {}, playlists = {}, guest = false, store = {} } = {}) {
  const calls = [];
  const win = {
    __PERSONAL_RAIL: true,
    __GUEST: guest,
    MADHelpers: { hasValidAudio: (it) => !!(it && it.fields && it.fields.S3_URL), sortTracksBySeq: (a) => a },
  };
  const json = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  const fetch = (url) => {
    calls.push(url);
    const u = new URL(url, 'http://x');
    if (u.pathname === '/api/suggested-for-you') return json({ eligible: rail.length > 0, items: rail });
    if (u.pathname === '/api/album') return json({ ok: true, items: albums[u.searchParams.get('cat')] || [] });
    if (u.searchParams.get('category') === 'Theme') return json({ playlists: THEMES });
    const name = u.searchParams.get('name');
    return json({ ok: true, tracks: playlists[name] || [] });
  };
  const localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
  vm.runInNewContext(read('public/js/next-music.js'), { window: win, fetch, localStorage, URLSearchParams, encodeURIComponent, parseInt, isFinite, String });
  return { NM: win.MADNextMusic, calls, store };
}

const RAIL = [
  { album: 'A', artist: 'x', catalogue: 'C1', artworkSrc: 'a.jpg' },
  { album: 'B', artist: 'y', catalogue: 'C2', artworkSrc: 'b.jpg' },
];

describe('what plays when the music runs out', () => {
  it('both sites ask the shared picker before random songs', () => {
    expect(app).toMatch(/MP\.musicAfter\(lastId\)/);
    expect(player).toMatch(/musicAfter:\s*_musicAfter/);
    expect(phone).toMatch(/window\.MADNextMusic\.pick\(\{ lastId, genre \}\)/);
    expect(app).toMatch(/<script src="\/js\/next-music\.js\?v=\d+"><\/script>/);
    expect(read('public/mobile.html')).toMatch(/<script src="\/js\/next-music\.js\?v=\d+"><\/script>/);
  });

  it('starts with the first Suggested for You album, then stays in the rail', async () => {
    const { NM } = loadPicker({ rail: RAIL, albums: { C1: [song(1), song(2)], C2: [song(3)] } });
    const first = await NM.pick({ lastId: '99', genre: 'Maskandi' });
    expect(first.source).toBe('suggested');
    expect(first.name).toBe('A');
    const second = await NM.pick({ lastId: '2', genre: 'Maskandi' });
    expect(second.name).toBe('B');
  });

  it('an album opened from the rail is followed by the one after it', async () => {
    const { NM } = loadPicker({ rail: RAIL, albums: { C1: [song(1)], C2: [song(3)] } });
    NM.noteSuggested(0);
    expect((await NM.pick({ lastId: '1' })).name).toBe('B');
  });

  it('after the last rail album, the Themes playlist for the genre plays', async () => {
    const { NM } = loadPicker({ rail: RAIL, albums: { C1: [song(1)], C2: [song(3)] }, playlists: { House: [themeTrack(50)] } });
    NM.noteSuggested(1);
    const r = await NM.pick({ lastId: '3', genre: 'Afro House' });
    expect(r.source).toBe('theme');
    expect(r.name).toBe('House');
  });

  it('with no rail, the genre picks the Themes playlist', async () => {
    const { NM } = loadPicker({ playlists: { Maskandi: [themeTrack(7), themeTrack(8)] } });
    const r = await NM.pick({ lastId: '1', genre: 'Maskandi' });
    expect(r.name).toBe('Maskandi');
    expect(r.items.map((s) => s.recordId)).toEqual(['7', '8']);
    expect(r.items[0].fields.S3_URL).toBe('https://media.example/7.mp3');
  });

  it('genre matching: Gospel and Reggae find their playlists, "Afro" alone finds nothing', () => {
    const { NM } = loadPicker();
    expect(NM._themeForGenre('Gospel', THEMES)).toBe('Gospel Spirit Selects');
    expect(NM._themeForGenre('Reggae', THEMES)).toBe('Afro Reggae');
    expect(NM._themeForGenre('GQOM', THEMES)).toBe('Gqom');
    expect(NM._themeForGenre('Afro', THEMES)).toBeNull();
    expect(NM._themeForGenre('Boere Musiek', THEMES)).toBeNull();
  });

  it('with no genre match, the last Themes playlist opened plays', async () => {
    const { NM } = loadPicker({ playlists: { Gqom: [themeTrack(9)] }, store: { mad_last_theme: 'Gqom' } });
    expect((await NM.pick({ lastId: '1', genre: 'Boere Musiek' })).name).toBe('Gqom');
  });

  it('a Themes playlist that has just finished does not start again: random songs instead', async () => {
    const { NM } = loadPicker({ playlists: { Maskandi: [themeTrack(7), themeTrack(8)] }, store: { mad_last_theme: 'Maskandi' } });
    expect(await NM.pick({ lastId: '8', genre: 'Maskandi' })).toBeNull();
  });

  it('a Themes playlist plays once per visit, then random songs carry on', async () => {
    const { NM } = loadPicker({ playlists: { Maskandi: [themeTrack(7), themeTrack(8)] } });
    expect((await NM.pick({ lastId: '1', genre: 'Maskandi' })).name).toBe('Maskandi');
    expect(await NM.pick({ lastId: '71', genre: 'Maskandi' })).toBeNull();
  });

  it('guests skip the rail (they have none) and never ask for it', async () => {
    const { NM, calls } = loadPicker({ guest: true, rail: RAIL, playlists: { Maskandi: [themeTrack(7)] } });
    expect((await NM.pick({ lastId: '1', genre: 'Maskandi' })).source).toBe('theme');
    expect(calls.some((u) => u.includes('suggested-for-you'))).toBe(false);
  });

  it('opening a Themes playlist is remembered on both sites', () => {
    expect(app).toMatch(/category === 'Theme' && window\.MADNextMusic\) window\.MADNextMusic\.noteTheme\(name\)/);
    expect(read('public/js/mobile/rails-g100.js')).toMatch(/category === 'Theme' && window\.MADNextMusic\) window\.MADNextMusic\.noteTheme\(pl\.name\)/);
    expect(read('public/js/discovery.js')).toMatch(/window\.MADNextMusic\.noteSuggested\(index\)/);
    expect(read('public/js/mobile/rails-suggested.js')).toMatch(/window\.MADNextMusic\.noteSuggested\(index\)/);
  });
});

// Ian, 2026-11-16: "whenever there is a change whatever is playing in the play bar must be
// displayed". What carries on plays through a page, so the screen matches the bar.
describe('the screen follows the music', () => {
  it('desktop opens what carries on on its own page and plays it from there', () => {
    expect(app).toMatch(/return _playOnPage\(found, fresh, stillOurs\)\.then/);
    // a rail album on its album page, started from its own row
    expect(app).toMatch(/window\.openAlbumByCatalogue\(a\.catalogue, a\.album, a\.artist\)/);
    expect(app).toMatch(/#playlistTrackList \.playlist-track-item/);
    // a Themes playlist, or the random songs as "More <genre>", on the playlist page
    expect(app).toMatch(/var title = theme \? found\.name : \(genre \? 'More ' \+ genre : 'More music for you'\);/);
    expect(app).toMatch(/document\.getElementById\('userPlaylistPlayBtn'\);[\s\S]{0,80}btn\.click\(\);/);
  });

  it('the phone starts a new, named queue, so Now Playing says where the music is from', () => {
    expect(phone).toMatch(/state\.playlistContext = \{ tracks: more, currentIndex: 0, name, playFn: playTrack \};/);
    expect(phone).not.toMatch(/ctx\.tracks\.push\(\.\.\.more\)/);
  });
});
