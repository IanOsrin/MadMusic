// What plays when the music runs out (Ian, 2026-11-16): "when a client plays an album and it
// finishes you need to move on to new music". In order:
//   0. when what ended was an ALBUM (or a single), however it was started: the next album by
//      the same album artist, in release-year order after the one that ended, then round to
//      the earlier ones (Ian, 2026-11-20: "at the end of any album no matter the origin play
//      the next album from the same artist if available otherwise the rules remain"). Not for
//      playlists, and not for compilations (no one artist to follow);
//   NO ALBUM EVER PLAYS TWICE in a visit (Ian: "do not repeat an album when we complete the
//   catalogue we use the rules of suggested etc") — steps 0 and 1 skip every album played;
//   1. the next album on the listener's Suggested for You rail, staying in that rail
//      (the first album to begin with; after an album opened from the rail, the one after it);
//   2. the Themes playlist that matches the genre of the song that just ended;
//   3. the last Themes playlist the listener opened;
//   4. nothing here, and the caller plays random songs (its existing fallback).
// A Themes playlist plays at most once per visit, and never when it contains the song that just
// ended, so random songs carry on after it instead of the same playlist coming round again.
// After the rail's last album, steps 2-4 take over.
//
// Shared by desktop (js/player.js) and phone (js/mobile/player.js); both load this file as a
// plain script. Songs come back as { recordId, fields } records, the shape both players play.
(function () {
  'use strict';

  var LAST_THEME_KEY = 'mad_last_theme';
  var sfyAt = -1;            // index of the last Suggested for You album played on this page
  var sfyPromise = null;
  var themesPromise = null;
  var themesPlayed = {};     // Themes playlists already played on this page
  var albumsPlayed = {};     // albums already played on this page — never queued again

  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  // One key per album: the catalogue number (spaced or not — "CDGMP 40296" = "CDGMP40296"),
  // else title + album artist. '' when there is nothing to go on.
  function albumKey(cat, title, artist) {
    if (norm(cat)) return 'c:' + norm(cat);
    if (norm(title)) return 'a:' + norm(title) + '|' + norm(artist);
    return '';
  }
  function markPlayed(key) { if (key) albumsPlayed[key] = true; }
  function wasPlayed(key) { return !!(key && albumsPlayed[key]); }

  var COMPILATION = /^(variousartists?|various|va|compilation|compilations)$/;

  function readLastTheme() {
    try { return localStorage.getItem(LAST_THEME_KEY) || ''; } catch (e) { return ''; }
  }

  function getJson(url) {
    return fetch(url).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  function hasAudio(it) {
    var H = window.MADHelpers;
    return !!(it && it.recordId && (!H || !H.hasValidAudio || H.hasValidAudio(it)));
  }

  // The same ten albums the rail shows (cached for the page; the server caches for 6 hours).
  function sfyItems() {
    if (window.__PERSONAL_RAIL !== true || window.__GUEST) return Promise.resolve([]);
    if (!sfyPromise) {
      sfyPromise = getJson('/api/suggested-for-you').then(function (d) {
        return ((d && d.eligible && d.items) || []).filter(function (it) { return it && it.artworkSrc && it.album; });
      });
      sfyPromise.then(function (list) { if (!list.length) sfyPromise = null; });   // ask again later
    }
    return sfyPromise;
  }

  function albumSongs(it) {
    var q = it.catalogue ? { cat: it.catalogue } : { title: it.album, artist: it.artist || '' };
    return getJson('/api/album?' + new URLSearchParams(q)).then(function (d) {
      var items = ((d && d.ok && d.items) || []).filter(hasAudio);
      var H = window.MADHelpers;
      if (H && H.sortTracksBySeq) H.sortTracksBySeq(items);
      return items;
    });
  }

  function themePlaylists() {
    if (!themesPromise) {
      themesPromise = getJson('/api/public-playlists?category=Theme').then(function (d) {
        return (d && d.playlists) || [];
      });
      themesPromise.then(function (list) { if (!list.length) themesPromise = null; });
    }
    return themesPromise;
  }

  function themeSongs(name) {
    return getJson('/api/public-playlists?name=' + encodeURIComponent(name)).then(function (d) {
      return ((d && d.ok && d.tracks) || []).map(function (t) {
        return {
          recordId: String(t.recordId || t.trackRecordId || ''),
          fields: {
            'Track Name': t.name || '',
            'Track Artist': t.trackArtist || '',
            'Album Artist': t.albumArtist || t.trackArtist || '',
            'Album Title': t.albumTitle || '',
            'S3_URL': t.resolvedSrc || t.mp3 || '',
            'Artwork::Picture': t.picture || t.artwork || ''
          }
        };
      }).filter(hasAudio);
    });
  }

  // "Afro House" → House, "Gospel" → Gospel Spirit Selects, "Reggae" → Afro Reggae. A short
  // word counts only as an exact match, so "Afro" alone doesn't land on Afro Reggae.
  function themeForGenre(genre, playlists) {
    var g = norm(genre);
    if (!g) return null;
    var hit = null;
    playlists.forEach(function (p) {
      if (hit) return;
      var n = norm(p.name);
      if (!n) return;
      if (n === g || (g.length >= 5 && n.indexOf(g) !== -1) || (n.length >= 5 && g.indexOf(n) !== -1)) hit = p.name;
    });
    return hit;
  }

  async function tryTheme(name, lastId) {
    if (!name || themesPlayed[name]) return null;
    var songs = await themeSongs(name);
    if (!songs.length) return null;
    themesPlayed[name] = true;
    if (lastId && songs.some(function (s) { return s.recordId === String(lastId); })) return null;
    return { source: 'theme', name: name, items: songs };
  }

  // The album the song that just ended is on (catalogue, title, album artist). Subscribers
  // only — the lookup is token-gated, so guests skip the same-artist step.
  function songAlbum(lastId) {
    if (!lastId || window.__GUEST) return Promise.resolve(null);
    return getJson('/api/track/' + encodeURIComponent(lastId) + '/container').then(function (d) {
      return d && d.ok ? d : null;
    });
  }

  function field(f, names) {
    for (var i = 0; i < names.length; i++) { var v = f[names[i]]; if (v != null && String(v).trim() !== '') return String(v).trim(); }
    return '';
  }

  // The same album artist's albums, oldest first (by release year, then title).
  async function artistAlbums(artist) {
    var d = await getJson('/api/search?' + new URLSearchParams({ artist: artist, limit: '500' }));
    var seen = {}, albums = [];
    ((d && d.items) || []).forEach(function (it) {
      var f = (it && it.fields) || {};
      var aa = field(f, ['Album Artist', 'Tape Files::Album Artist']);
      if (norm(aa) !== norm(artist)) return;            // a song by them on someone else's album
      var cat = field(f, ['Reference Catalogue Number', 'Tape Files::Reference Catalogue Number']);
      var title = field(f, ['Album Title', 'Tape Files::Album Title']);
      var key = albumKey(cat, title, aa);
      if (!key || seen[key]) return;
      seen[key] = true;
      var y = parseInt(field(f, ['Year of Release', 'Tape Files::Year of Release', 'Year Recorded']), 10);
      albums.push({ key: key, catalogue: cat, album: title, artist: aa, year: isFinite(y) ? y : 99999 });
    });
    albums.sort(function (a, b) { return a.year - b.year || a.album.localeCompare(b.album); });
    return albums;
  }

  // Step 0: the next album by the artist of the album that just ended, not played yet.
  async function sameArtistNext(info, lastId) {
    var artist = info.albumArtist || '';
    if (!norm(artist) || COMPILATION.test(norm(artist))) return null;
    var albums = await artistAlbums(artist);
    var here = albumKey(info.catalogue, info.albumTitle, artist);
    var at = -1;
    albums.forEach(function (a, i) { if (a.key === here) at = i; });
    for (var n = 1; n <= albums.length; n++) {
      var a = albums[(at + n) % albums.length];          // after the one that ended, then round
      if (wasPlayed(a.key)) continue;
      var songs = await albumSongs(a);
      if (!songs.length) continue;
      if (lastId && songs.some(function (s) { return String(s.recordId) === lastId; })) { markPlayed(a.key); continue; }
      markPlayed(a.key);
      return { source: 'artist', name: a.album, album: { catalogue: a.catalogue, album: a.album, artist: a.artist }, items: songs };
    }
    return null;
  }

  // opts: { lastId, genre, album }. album: true when what ended was an album or a single (not
  // a playlist). Resolves to { source, name, items } or null (caller plays random).
  async function pick(opts) {
    opts = opts || {};
    var lastId = opts.lastId ? String(opts.lastId) : '';

    if (opts.album) {
      var info = await songAlbum(lastId);
      if (info) {
        markPlayed(albumKey(info.catalogue, info.albumTitle, info.albumArtist));
        var next = await sameArtistNext(info, lastId);
        if (next) return next;
      }
    }

    var rail = await sfyItems();
    for (var i = sfyAt + 1; i < rail.length; i++) {
      var key = albumKey(rail[i].catalogue, rail[i].album, rail[i].artist);
      if (wasPlayed(key)) { sfyAt = i; continue; }       // never the same album twice
      var songs = await albumSongs(rail[i]);
      if (!songs.length) continue;
      sfyAt = i;
      // The album that just ended (opened some other way than the rail): go on to the next one.
      if (lastId && songs.some(function (s) { return String(s.recordId) === lastId; })) { markPlayed(key); continue; }
      markPlayed(key);
      return { source: 'suggested', name: rail[i].album, album: rail[i], items: songs };
    }

    var byGenre = themeForGenre(opts.genre, await themePlaylists());
    var r = await tryTheme(byGenre, lastId);
    if (r) { noteTheme(r.name); return r; }

    var last = readLastTheme();
    if (last && last !== byGenre) {
      r = await tryTheme(last, lastId);
      if (r) return r;
    }
    return null;
  }

  // A Suggested for You album the listener opened themselves: carry on with the one after it.
  function noteSuggested(index) {
    var i = parseInt(index, 10);
    if (isFinite(i) && i >= 0) sfyAt = i;
  }

  function noteTheme(name) {
    if (!name) return;
    try { localStorage.setItem(LAST_THEME_KEY, name); } catch (e) { /* private window: fine */ }
  }

  window.MADNextMusic = { pick: pick, noteSuggested: noteSuggested, noteTheme: noteTheme, _themeForGenre: themeForGenre, _albumKey: albumKey };
})();
