// Playback engine + now-playing modal for the mobile app.

import { elements, state } from './state.js';
import { formatTime, generateSessionId, showToast } from './util.js';
import { getAlbumField, getArtistField, getArtworkUrl, getAudioUrl, getTitleField, getYearField } from './fields.js';

export function closeModal() {
      elements.modalOverlay.classList.remove('show');
    }

export async function playTrack(track) {
      state.currentTrack = track;
      const fields = track.fields || {};

      // Get audio URL
      let audioUrl = null;
      const mp3Field = getAudioUrl(fields);

      if (mp3Field && (mp3Field.startsWith('http') || mp3Field.startsWith('https'))) {
        audioUrl = `/api/container?u=${encodeURIComponent(mp3Field)}`;
      } else {
        try {
          const response = await fetch(`/api/track/${track.recordId}/container`);
          const data = await response.json();
          if (data.url) {
            audioUrl = `/api/container?u=${encodeURIComponent(data.url)}`;
          }
        } catch (err) {
          console.error('Failed to get audio URL', err);
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

      if (total > 0) {
        const percent = (current / total) * 100;
        document.getElementById('progress-fill').style.width = `${percent}%`;
      }

      document.getElementById('current-time').textContent = formatTime(current);
      document.getElementById('total-time').textContent = formatTime(total);
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
            deltaSec: 0
          })
        });
        console.log('[Stream Event]', eventType, 'at', currentTime, 'sec');
      } catch (err) {
        console.warn('[Stream Event] Failed:', err);
      }
    }
