// Playback engine + now-playing modal for the mobile app.

import { elements, state } from './state.js';
import { formatTime, generateSessionId, showToast } from './util.js';
import { getAlbumField, getArtistField, getArtworkUrl, getAudioUrl, getTitleField, getYearField } from './fields.js';

export function closeModal() {
      elements.modalOverlay.classList.remove('show');
      // Keep browser history in sync: pop the overlay entry this modal pushed so a
      // later Back doesn't land on a phantom entry. popstate-driven closes go through
      // the router's own path and never reach here, so there's no recursion.
      if (history.state && history.state.mad && history.state.kind === 'overlay') {
        history.back();
      }
    }

export async function playTrack(track) {
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
        const isS3 = (u) => /\.s3[.-]/.test(u || '');
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
            const data = await response.json();
            if (data.url) {
              audioUrl = isS3(data.url) ? data.url : `/api/container?u=${encodeURIComponent(data.url)}`;
            }
          } catch (err) {
            console.error('Failed to get audio URL', err);
          }
        }
      }

      if (!audioUrl) {
        showToast('Audio not available', 'error');
        return;
      }

      // Play audio. play() rejects on a rapid src switch (AbortError — benign)
      // or a load failure; catch it so it isn't an unhandled rejection. Real
      // load failures still surface via the audio 'error' listener (toast +
      // stream ERROR event). The desktop player likewise catches play().
      elements.audio.src = audioUrl;
      elements.audio.play().catch((err) => {
        if (err && err.name !== 'AbortError') console.warn('Audio play() failed:', err.name || err);
      });

      // Update UI
      updateFloatingPlayer();
      updatePlayerModal();
      state.playerBubble.visible = true;
      elements.floatingPlayer.classList.add('visible', 'playing');

      // Generate a new session ID for this track — stream event fired by the audio 'play' listener
      state.streamSessionId = generateSessionId();
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

      const yearElement = document.getElementById('player-year');
      if (year) {
        yearElement.textContent = year;
        yearElement.style.display = 'block';
      } else {
        yearElement.style.display = 'none';
      }
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
