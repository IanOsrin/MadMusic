// What plays when the music runs out (Ian, 2026-11-16): "when a client plays an album and it
// finishes you need to move on to new music". In order:
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

  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

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

  // opts: { lastId, genre }. Resolves to { source, name, items } or null (caller plays random).
  async function pick(opts) {
    opts = opts || {};
    var lastId = opts.lastId ? String(opts.lastId) : '';

    var rail = await sfyItems();
    for (var i = sfyAt + 1; i < rail.length; i++) {
      var songs = await albumSongs(rail[i]);
      if (!songs.length) continue;
      sfyAt = i;
      // The album that just ended (opened some other way than the rail): go on to the next one.
      if (lastId && songs.some(function (s) { return String(s.recordId) === lastId; })) continue;
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

  window.MADNextMusic = { pick: pick, noteSuggested: noteSuggested, noteTheme: noteTheme, _themeForGenre: themeForGenre };
})();
