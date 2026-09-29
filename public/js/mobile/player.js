// Playback engine + now-playing modal for the mobile app.

import { elements, state } from './state.js?v=34';
import { formatTime, generateSessionId, showToast } from './util.js?v=34';
import { escapeHtml, getAlbumField, getArtistField, getArtworkUrl, getAudioUrl, getGenreField, getTitleField, getYearField } from './fields.js?v=34';

export function closeModal() {
      elements.modalOverlay.classList.remove('show');
      // Keep browser history in sync: pop the overlay entry this modal pushed so a
      // later Back doesn't land on a phantom entry. popstate-driven closes go through
      // the router's own path and never reach here, so there's no recursion.
      if (history.state && history.state.mad && history.state.kind === 'overlay') {
        history.back();
      }
    }

// Every play gets a number; a play whose awaited URL lookup comes back after a NEWER play has
// started is dropped, so a slow lookup can't replace the song the listener just chose.
let playSeq = 0;

// A song that can't play is skipped, not left silent — "shuffle stops after a while" (client,
// 2026-09-29) was largely one bad track ending the whole queue. Capped so a dead network or
// a run of broken tracks doesn't race through the queue; any successful play resets it.
let failuresInARow = 0;
const MAX_SKIPS = 3;
export function trackFailed(why) {
  console.warn('[Mobile] Track failed:', why);
  if (failuresInARow >= MAX_SKIPS) {
    showToast('Playback stopped — several tracks could not be played', 'error');
    return;
  }
  failuresInARow += 1;
  showToast('Track unavailable — skipping', 'error');
  stepQueue(1);
}
export function trackPlayedOk() { failuresInARow = 0; }

export async function playTrack(track) {
      const seq = ++playSeq;
      state.currentTrack = track;
      const fields = track.fields || {};

      // Get audio URL
      let audioUrl = null;

      // Guest preview mode: EVERY playback becomes the server-clipped ~30 s
      // preview stream, keyed by recordId. No recordId → no playback: a full
      // stream must never reach a guest.
      if (window.__GUEST) {
        if (!track.recordId) {
          showToast('Subscribe to play this track', 'error');
          return;
        }
        audioUrl = `/api/preview/${encodeURIComponent(track.recordId)}`;
      } else {
        const mp3Field = getAudioUrl(fields);
        // "direct-playable": bucket S3 or the media CDN that fronts it
        const isS3 = (u) => /\.s3[.-]/.test(u || '') || !!(window.__MEDIA_CDN && (u || '').includes('//' + window.__MEDIA_CDN + '/'));
        const isFmUrl = (u) => /RCType=|\/Streaming_SSL\//i.test(u || '');

        if (mp3Field && isS3(mp3Field) && !isFmUrl(mp3Field)) {
          // S3 URLs are stable and the bucket is public — play DIRECT, no
          // proxy hop, no resolution round-trip. Nothing plays from FileMaker.
          audioUrl = mp3Field;
        } else if (mp3Field && /^https?:/.test(mp3Field) && !isFmUrl(mp3Field)) {
          audioUrl = `/api/container?u=${encodeURIComponent(mp3Field)}`;
        } else {
          // Missing or session-scoped FM streaming URL → re-resolve by
          // recordId (PG-mirror-backed server-side).
          try {
            const response = await fetch(`/api/track/${track.recordId}/container`);
            // A 401/404/500 has no url — treat it as "not available" (skip), not as a crash.
            const data = response.ok ? await response.json() : {};
            if (data.url) {
              audioUrl = isS3(data.url) ? data.url : `/api/container?u=${encodeURIComponent(data.url)}`;
            }
          } catch (err) {
            console.error('Failed to get audio URL', err);
          }
        }
      }

      if (seq !== playSeq) return;   // the listener has already moved on to another track

      if (!audioUrl) {
        trackFailed('no audio URL');
        return;
      }

      // Music never plays from the bucket host directly: CDN host when
      // configured (window.__MEDIA_CDN), else the path-style S3 origin whose
      // connection pool artwork can't saturate — same rules as desktop
      // playTrack ("songs hang", 2026-07-27).
      audioUrl = audioUrl.replace(
        /^https:\/\/mass-music-audio-files\.s3\.eu-north-1\.amazonaws\.com\//,
        window.__MEDIA_CDN
          ? 'https://' + window.__MEDIA_CDN + '/'
          : 'https://s3.eu-north-1.amazonaws.com/mass-music-audio-files/'
      );

      // Play audio. play() rejects on a rapid src switch (AbortError — benign)
      // or a load failure; catch it so it isn't an unhandled rejection. Real
      // load failures still surface via the audio 'error' listener (toast +
      // stream ERROR event). The desktop player likewise catches play().
      elements.audio.src = audioUrl;
      elements.audio.play().catch((err) => {
        if (!err || err.name === 'AbortError') return;
        console.warn('Audio play() failed:', err.name || err);
        // Blocked from starting while the phone is locked/backgrounded (autoplay rules):
        // start it the moment the listener comes back, instead of staying silently paused.
        if (err.name === 'NotAllowedError' && document.hidden) resumeWhenVisible = true;
      });

      // Update UI
      updateFloatingPlayer();
      updatePlayerModal();
      updateMediaSession();          // lock screen, Control Centre, car stereo
      state.playerBubble.visible = true;
      elements.floatingPlayer.classList.add('visible', 'playing');

      // Generate a new session ID for this track — stream event fired by the audio 'play' listener
      state.streamSessionId = generateSessionId();

      // "Pick up where you left off" (continue.js) remembers every play.
      window.dispatchEvent(new CustomEvent('mad:played', { detail: { track } }));
    }

// ── Lock-screen / Control Centre playback controls ──────────────────────────
// navigator.mediaSession puts the track title, artist, album and artwork on the
// lock screen, in Control Centre and on a car stereo, and routes the hardware
// play/pause/next/prev — headphone buttons, steering-wheel controls, Bluetooth.
//
// Without it a locked phone gives a MUSIC app no controls at all, which is the
// single most-missed thing in a web-wrapped player. It also matters for the App
// Store: an app that behaves like a media app, rather than a website in a
// frame, is the answer to Apple's "minimum functionality" objection.
//
// Guarded because support is uneven: absent in some WebViews, and individual
// setActionHandler calls throw for actions a browser does not implement, which
// would otherwise take the whole player down with them.
function mediaSessionSupported() {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

export function updateMediaSession() {
  if (!mediaSessionSupported() || !state.currentTrack) return;
  const fields = state.currentTrack.fields || {};
  const artwork = getArtworkUrl(fields);
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title:  getTitleField(fields) || 'MAD Music',
      artist: getArtistField(fields) || '',
      album:  getAlbumField(fields) || '',
      // Several sizes declared from one URL: the OS picks what it needs, and a
      // wrong-sized hint is better than no artwork on the lock screen.
      artwork: artwork ? [
        { src: artwork, sizes: '256x256', type: 'image/jpeg' },
        { src: artwork, sizes: '512x512', type: 'image/jpeg' },
      ] : [],
    });
  } catch (e) { /* MediaMetadata missing — controls still work, just unlabelled */ }
}

// Called once at startup. Each handler is set separately: one unsupported
// action must not stop the rest being registered.
export function initMediaSession() {
  if (!mediaSessionSupported()) return;
  const audio = elements.audio || document.getElementById('audio');
  if (!audio) return;

  const set = (action, fn) => {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) {}
  };

  set('play',  () => audio.play().catch(() => {}));
  set('pause', () => audio.pause());
  set('previoustrack', () => stepQueue(-1));
  set('nexttrack',     () => stepQueue(1));
  // Seeking is offered because a lock screen shows a scrubber; guests are on a
  // 30-second clip, where it is harmless either way.
  set('seekbackward', (d) => { audio.currentTime = Math.max(0, audio.currentTime - (d?.seekOffset || 10)); });
  set('seekforward',  (d) => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d?.seekOffset || 10)); });
  set('seekto', (d) => { if (d && d.fastSeek && audio.fastSeek) audio.fastSeek(d.seekTime); else if (d) audio.currentTime = d.seekTime; });
  // Deliberately NOT 'stop': iOS then shows a stop button in place of pause,
  // which reads as "quit" and loses the queue.

  // Keep the OS in step with the actual element, not with what we think we did:
  // playback can start or stop from the lock screen, a headset, or an autoplay
  // block, and the widget must not claim otherwise.
  const sync = () => { try { navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing'; } catch (e) {} };
  audio.addEventListener('play', sync);
  audio.addEventListener('pause', sync);
  audio.addEventListener('ended', sync);
}

// The scrubber on the lock screen. Skipped while the numbers are not finite —
// a live or still-loading stream reports NaN, and passing that throws.
export function updateMediaSessionPosition() {
  if (!mediaSessionSupported() || !navigator.mediaSession.setPositionState) return;
  const audio = elements.audio || document.getElementById('audio');
  if (!audio || !isFinite(audio.duration) || !isFinite(audio.currentTime) || audio.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(audio.currentTime, audio.duration),
    });
  } catch (e) {}
}

export function setArtwork(imgId, url) {
      const img = document.getElementById(imgId);
      if (!img) return;
      img.onerror = () => { img.onerror = null; img.src = '/img/placeholder.png'; };
      img.src = url;
    }

export function updateFloatingPlayer() {
      if (!state.currentTrack) return;

      const fields = state.currentTrack.fields || {};
      setArtwork('floating-artwork', getArtworkUrl(fields));
      const titleEl = document.getElementById('mini-title');
      const artistEl = document.getElementById('mini-artist');
      if (titleEl) titleEl.textContent = getTitleField(fields);
      if (artistEl) artistEl.textContent = getArtistField(fields);
    }

let resumeWhenVisible = false;
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && resumeWhenVisible) {
    resumeWhenVisible = false;
    elements.audio.play().catch(() => {});
  }
});

// Step the now-playing queue (state.playlistContext) by ±1. Shared by the
// modal's prev/next, the mini bar's next, and auto-advance on 'ended'.
// At the END of the queue, going forward keeps the music playing (client, 2026-09-29: "shuffle
// stops after an undetermined time" — every mobile queue simply ran out, and many start as 1–10
// songs): more songs in the same genre are appended, like a radio, then the next one plays.
export function stepQueue(dir) {
      const ctx = state.playlistContext;
      if (!ctx || !ctx.tracks || ctx.tracks.length === 0) return;
      if (dir > 0 && ctx.currentIndex >= ctx.tracks.length - 1) {
        continueWithMore(ctx);
        return;
      }
      const newIdx = Math.min(ctx.tracks.length - 1, Math.max(0, ctx.currentIndex + dir));
      if (newIdx !== ctx.currentIndex) {
        ctx.currentIndex = newIdx;
        (ctx.playFn || playTrack)(ctx.tracks[newIdx]);
      }
    }

let refilling = false;
async function continueWithMore(ctx) {
  if (refilling) return;
  refilling = true;
  try {
    const last = ctx.tracks[ctx.tracks.length - 1] || {};
    const genre = getGenreField(last.fields || {}) || '';
    const have = new Set(ctx.tracks.map((t) => String(t.recordId || t.trackRecordId || '')));
    const fetchSongs = async (g) => {
      const r = await fetch(`/api/random-songs?count=25${g ? `&genre=${encodeURIComponent(g)}` : ''}`);
      if (!r.ok) return [];
      const d = await r.json();
      return ((d && d.items) || []).filter((t) => t.recordId && !have.has(String(t.recordId)));
    };
    let more = genre ? await fetchSongs(genre) : [];
    if (more.length < 3) more = more.concat(await fetchSongs(''));
    if (!more.length || state.playlistContext !== ctx) return;   // nothing found, or the listener started something else
    // Refilled songs are catalogue records: they play through playTrack even when the queue
    // itself is a saved playlist (whose own tracks need playPlaylistTrack).
    const base = ctx.playFn || playTrack;
    ctx.playFn = (t) => (t && t.__more ? playTrack(t) : base(t));
    more.forEach((t) => { t.__more = true; });
    ctx.tracks.push(...more);
    ctx.currentIndex += 1;
    ctx.playFn(ctx.tracks[ctx.currentIndex]);
  } catch (err) {
    console.warn('[Mobile] Could not continue the queue:', err);
  } finally {
    refilling = false;
  }
}

// The tracklist inside the player modal: the album/playlist being played,
// with the current row highlighted (animated EQ) and tap-to-jump.
export function renderPlayerQueue() {
      const box = document.getElementById('player-queue');
      if (!box) return;
      const ctx = state.playlistContext;
      if (!ctx || !ctx.tracks || ctx.tracks.length < 2) {
        box.innerHTML = '';
        box.style.display = 'none';
        return;
      }
      const name = ctx.name || getAlbumField(state.currentTrack?.fields || {}) || 'Queue';
      box.style.display = 'block';
      box.innerHTML = `<div class="pq-header">Playing from <span>${escapeHtml(name)}</span></div>` +
        ctx.tracks.map((t, i) => {
          const f = t.fields || {};
          // Stored playlist tracks have no FM fields — they carry {name, albumArtist}
          const title = (t.fields && getTitleField(f)) || t.name || 'Unknown';
          const artist = (t.fields && getArtistField(f)) || t.albumArtist || t.albumTitle || '';
          const playing = i === ctx.currentIndex;
          return `<button class="pq-row${playing ? ' playing' : ''}" data-qi="${i}">
            <span class="pq-num">${playing ? '<span class="pq-eq"><span></span><span></span><span></span></span>' : i + 1}</span>
            <span class="pq-titles">
              <span class="pq-title">${escapeHtml(title)}</span>
              <span class="pq-artist">${escapeHtml(artist)}</span>
            </span>
          </button>`;
        }).join('');
      box.querySelectorAll('.pq-row').forEach(btn => {
        btn.addEventListener('click', () => {
          const i = parseInt(btn.dataset.qi, 10);
          ctx.currentIndex = i;
          (ctx.playFn || playTrack)(ctx.tracks[i]);
        });
      });
      const cur = box.querySelector('.pq-row.playing');
      if (cur && elements.playerModal.classList.contains('show')) {
        cur.scrollIntoView({ block: 'nearest' });
      }
    }

export function updatePlayerModal() {
      if (!state.currentTrack) return;

      const fields = state.currentTrack.fields || {};
      const artwork = getArtworkUrl(fields);
      const title = getTitleField(fields);
      const artist = getArtistField(fields);
      const album = getAlbumField(fields);
      const year = getYearField(fields);

      setArtwork('player-artwork', artwork);
      document.getElementById('player-title').textContent = title;
      document.getElementById('player-artist').textContent = artist;
      document.getElementById('player-album').textContent = album;
      // "NOW PLAYING / <where from>": the queue's name (album, playlist, Global Favourites…)
      const ctx = document.getElementById('player-context');
      if (ctx) ctx.textContent = (state.playlistContext && state.playlistContext.name) || album || '';

      const yearElement = document.getElementById('player-year');
      if (year) {
        yearElement.textContent = year;
        yearElement.style.display = 'block';
      } else {
        yearElement.style.display = 'none';
      }

      renderPlayerQueue();
    }

export function updateProgress() {
      const current = elements.audio.currentTime || 0;
      const total = elements.audio.duration || 0;

      // Guest preview: the clipped stream keeps the FULL track's header, so
      // audio.duration reads e.g. 6:08 while only ~30 s of audio exists. The
      // bar fills against the preview length; the label sells the full song.
      const GUEST_PREVIEW_SECS = 30;
      const isPreview = window.__GUEST && total > GUEST_PREVIEW_SECS + 1;
      const effTotal = isPreview ? GUEST_PREVIEW_SECS : total;

      if (effTotal > 0) {
        const percent = Math.min(100, (current / effTotal) * 100);
        document.getElementById('progress-fill').style.width = `${percent}%`;
        const mini = document.getElementById('mini-progress-fill');
        if (mini) mini.style.width = `${percent}%`;
      }

      document.getElementById('current-time').textContent = formatTime(current);
      document.getElementById('total-time').textContent = isPreview
        ? `${formatTime(GUEST_PREVIEW_SECS)} of ${formatTime(total)}`
        : formatTime(total);
    }

export async function sendStreamEvent(eventType) {
      if (!state.currentTrack || !state.streamSessionId) return;

      const currentTime = Math.floor(elements.audio.currentTime || 0);
      const duration = Math.floor(elements.audio.duration || 0);

      try {
        await fetch('/api/access/stream-events', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-ID': state.streamSessionId
          },
          body: JSON.stringify({
            eventType: eventType,
            trackRecordId: state.currentTrack.recordId,
            trackISRC: (state.currentTrack?.fields?.['ISRC'] || '').trim(),
            positionSec: currentTime,
            durationSec: duration,
            deltaSec: 0,
            // Guest plays are 30 s previews — see PlaybackMode in stream events
            playbackMode: window.__GUEST ? 'PREVIEW' : 'FULL'
          })
        });
        console.log('[Stream Event]', eventType, 'at', currentTime, 'sec');
      } catch (err) {
        console.warn('[Stream Event] Failed:', err);
      }
    }


// ── Buffering feedback (2026-07-18, focus-group finding: long silent waits) ──
// Surface fetch state on the player modal title so a slow network never looks
// dead. Class toggles on <body>; CSS lives in css/mobile.css.
(function wireBuffering() {
  const audio = elements?.audio || document.getElementById('audio');
  if (!audio) return;
  const on = () => document.body.classList.add('audio-buffering');
  const off = () => document.body.classList.remove('audio-buffering');
  audio.addEventListener('loadstart', on);
  audio.addEventListener('waiting', on);
  audio.addEventListener('stalled', on);
  audio.addEventListener('playing', off);
  audio.addEventListener('canplay', off);
  audio.addEventListener('pause', off);
  audio.addEventListener('error', off);
})();
