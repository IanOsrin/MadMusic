// public/js/player.js
// Player module - manages audio playback, stream events, and shuffle functionality

(function() {
  'use strict';

  // ---- STATE ----

      const itemsStore = new Map();
      let currentAudio = null;
      let currentTrackInfo = null;
      let isPlaying = false;
  
      // Shuffle play queue
      let shuffleQueue = [];
      let shuffleQueueIndex = 0;
      let isShuffleActive = false;
  
      // Stream Event Tracking
      const STREAM_EVENTS_ENDPOINT = '/api/access/stream-events';
      const STREAM_SESSION_STORAGE_KEY = 'mass.session';
      const STREAM_PROGRESS_INTERVAL_MS = 30 * 1000; // 30 seconds
      let streamSessionId = null;
      try {
        streamSessionId = localStorage.getItem(STREAM_SESSION_STORAGE_KEY);
      } catch {
        streamSessionId = null;
      }
      if (!streamSessionId) {
        const fallbackId = (window.crypto && typeof window.crypto.randomUUID === 'function')
          ? window.crypto.randomUUID()
          : Math.random().toString(36).slice(2);
        streamSessionId = fallbackId;
        try {
          localStorage.setItem(STREAM_SESSION_STORAGE_KEY, streamSessionId);
        } catch {
          // ignore storage failures
        }
      }
      let lastStreamReportTs = 0;
      let lastStreamReportPos = 0;
      let lastProgressSentAt = 0;
      let progressInterval = null;
      let hasReportedPlay = false; // Flag to prevent duplicate PLAY events
      let isSwitchingTracks = false; // Flag to prevent events when switching tracks

  // ---- CONSTANTS & UTILITIES ----

      function toSeconds(value) {
        const numeric = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(numeric)) return 0;
        return Math.max(0, Math.round(numeric));
      }
  

      function getCurrentTrackMeta() {
        if (!currentTrackInfo || !currentTrackInfo.recordId) return {};
        return {
          trackRecordId: currentTrackInfo.recordId,
          trackISRC: currentTrackInfo.isrc || '',
          title: currentTrackInfo.title || '',
          artist: currentTrackInfo.artist || '',
          album: currentTrackInfo.album || ''
        };
      }
  

  // ---- STREAM EVENTS ----

      async function sendStreamEvent(type, positionOverride, durationOverride, deltaOverride) {
        if (typeof fetch !== 'function') return false;
        const requestTs = Date.now();
        const meta = getCurrentTrackMeta();
  
        if (!meta.trackRecordId) {
          console.warn('[Stream Event] No track record ID available');
          return false;
        }
  
        const rawPos = typeof positionOverride === 'number' ? positionOverride : currentAudio?.currentTime || 0;
        const rawDur = typeof durationOverride === 'number' ? durationOverride : currentAudio?.duration || 0;
        const normalizedPos = toSeconds(rawPos);
        const normalizedDur = toSeconds(rawDur);
        const hasOverride = Number.isFinite(deltaOverride);
        const overrideDelta = hasOverride ? Math.max(0, Math.round(deltaOverride)) : 0;
        const deltaFromPos = Math.max(0, normalizedPos - (Number.isFinite(lastStreamReportPos) ? lastStreamReportPos : 0));
        const deltaFromTime = lastStreamReportTs ? Math.max(0, Math.round((requestTs - lastStreamReportTs) / 1000)) : 0;
        const normalizedDelta = hasOverride ? overrideDelta : (deltaFromPos || deltaFromTime);
  
        const body = {
          eventType: type,
          trackRecordId: meta.trackRecordId,
          trackISRC: meta.trackISRC || '',
          positionSec: normalizedPos,
          durationSec: normalizedDur,
          deltaSec: normalizedDelta
        };
  
        try {
          const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-Session-ID': streamSessionId
          };
  
          if (currentAccessToken) {
            headers['X-Access-Token'] = currentAccessToken;
          }
  
          const response = await fetch(STREAM_EVENTS_ENDPOINT, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(body)
          });
  
          if (!response.ok) {
            console.warn('[Stream Event] Request failed:', response.status);
            return false;
          }
  
          const responseJson = await response.json().catch(() => null);
          if (!responseJson?.ok) {
            console.warn('[Stream Event] Server reported failure');
            return false;
          }
  
          console.log('[Stream Event] Sent:', type, meta.title);
          lastStreamReportTs = requestTs;
          lastStreamReportPos = normalizedPos;
          return true;
        } catch (err) {
          console.error('[Stream Event] Error:', err);
          return false;
        }
      }
  

      function startProgressTracking() {
        if (progressInterval) {
          clearInterval(progressInterval);
        }
        progressInterval = setInterval(() => {
          if (currentAudio && !currentAudio.paused) {
            const now = Date.now();
            if (now - lastProgressSentAt >= STREAM_PROGRESS_INTERVAL_MS) {
              sendStreamEvent('PROGRESS');
              lastProgressSentAt = now;
            }
          }
        }, 5000); // Check every 5 seconds
      }
  
      function stopProgressTracking() {
        if (progressInterval) {
          clearInterval(progressInterval);
          progressInterval = null;
        }
      }
  

  // ---- HELPER FUNCTIONS ----

      function getFieldValue(fields, fieldNames) {
        if (!fields) return null;
        for (const name of fieldNames) {
          if (fields[name]) return fields[name];
        }
        return null;
      }
  
      function getArtworkUrl(fields) {
        const artworkFields = ['Artwork_S3_URL', 'Tape Files::Artwork_S3_URL', 'Artwork::Picture', 'Artwork Picture', 'Picture'];
        const artwork = getFieldValue(fields, artworkFields);
        if (!artwork) return null;
  
        // Handle FileMaker container URLs
        if (typeof artwork === 'string') {
          if (artwork.startsWith('http')) {
            // Check if it's an S3 URL - return directly without proxying
            if (/^https?:\/\/.*\.s3[.-]/.test(artwork) || /^https?:\/\/s3[.-]/.test(artwork)) {
              return artwork;
            }
            return `/api/container?u=${encodeURIComponent(artwork)}`;
          }
          return artwork;
        }
        return null;
      }
  
      function getAudioUrl(fields, recordId) {
        const audioFields = ['S3_URL', 'mp3', 'MP3', 'Audio File', 'Audio::mp3'];
        const audio = getFieldValue(fields, audioFields);
        if (!audio) return null;
  
        if (typeof audio === 'string' && audio.startsWith('http')) {
          // Check if it's an S3 URL - return directly without proxying
          if (/^https?:\/\/.*\.s3[.-]/.test(audio) || /^https?:\/\/s3[.-]/.test(audio)) {
            return audio;
          }
          return `/api/container?u=${encodeURIComponent(audio)}`;
        }
        return `/api/track/${recordId}/container`;
      }
  
      // Check if an item has valid audio
      function hasValidAudio(item) {
        if (!item || !item.fields) return false;
        const audioFields = ['S3_URL', 'mp3', 'MP3', 'Audio File', 'Audio::mp3'];
        const audio = getFieldValue(item.fields, audioFields);
  
        // Check if audio field exists and is not empty
        if (!audio) return false;
        if (typeof audio === 'string' && audio.trim() === '') return false;
  
        return true;
      }
  
      // Escape HTML to prevent XSS attacks
      function escapeHtml(unsafe) {
        if (typeof unsafe !== 'string') {
          unsafe = String(unsafe ?? '');
        }
        return unsafe
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      }
  
      function getTitleField(fields) {
        const titleFields = ['Track Name', 'Song Name', 'Track Title', 'Song Title', 'Title'];
        return getFieldValue(fields, titleFields) || 'Unknown Track';
      }
  
      function getArtistField(fields) {
        const artistFields = ['Album Artist', 'Artist', 'Artist Name'];
        return getFieldValue(fields, artistFields) || 'Unknown Artist';
      }
  
      function getAlbumField(fields) {
        const albumFields = ['Album Title', 'Album', 'Album Name'];
        return getFieldValue(fields, albumFields) || 'Unknown Album';
      }
  
      function getGenreField(fields) {
        const genreFields = ['Local Genre', 'Tape Files::Local Genre', 'Genre'];
        return getFieldValue(fields, genreFields) || '';
      }
  
      function formatRelativeTime(value) {
        if (!value) return '';
        const date = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        const diffMs = Date.now() - date.getTime();
        const minutes = Math.max(0, Math.round(diffMs / 60000));
        if (minutes < 1) return 'Just now';
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.round(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.round(hours / 24);
        return `${days}d ago`;
      }
  
      function formatTrendingMeta(metrics = {}) {
        const plays = Number(metrics.playCount) || 0;
        const playLabel = plays ? `${plays} play${plays === 1 ? '' : 's'}` : '';
        const relative = metrics.lastEventUTC ? formatRelativeTime(metrics.lastEventUTC) : '';
        return [playLabel, relative].filter(Boolean).join(' · ');
      }

  // ---- UI UPDATES ----

      function updateMiniPlayer(title, artist, artworkUrl) {
        const miniPlayer = document.getElementById('miniPlayer');
        const playerTitle = document.getElementById('nowPlayingTitle');
        const playerArtist = document.getElementById('nowPlayingSubtitle');
        const playerArtwork = document.getElementById('nowPlayingThumbImg');
        const playIcon = document.getElementById('playIcon');
        const toggleBtn = document.getElementById('nowPlayingToggle');
  
        miniPlayer.classList.add('active');
        if (playerTitle) playerTitle.textContent = title;
        if (playerArtist) {
          playerArtist.textContent = artist;
          playerArtist.onclick = artist
            ? () => { window.location.href = `/albums?artist=${encodeURIComponent(artist)}`; }
            : null;
        }
        if (playerArtwork) playerArtwork.src = artworkUrl || '';
  
        if (toggleBtn) toggleBtn.title = isPlaying ? 'Pause' : 'Play';
        if (playIcon) {
          playIcon.querySelector('path').setAttribute('d',
            isPlaying
              ? 'M6 19h4V5H6v14zm8-14v14h4V5h-4z'  // pause icon
              : 'M8 5v14l11-7z'                       // play icon
          );
        }
      }
  
      // Hide mini player
      function hideMiniPlayer() {
        const miniPlayer = document.getElementById('miniPlayer');
        miniPlayer.classList.remove('active');
      }
  

      function updateNowPlayingCard(recordId) {
        // Remove now-playing class from all cards and reset play icons
        document.querySelectorAll('.random-card.now-playing').forEach(card => {
          card.classList.remove('now-playing');
          const playIcon = card.querySelector('.play-icon');
          if (playIcon) {
            playIcon.textContent = '▶';
          }
        });
  
        // Reset play icons in other sections (featured, highlights, trending)
        document.querySelectorAll('.play-icon').forEach(icon => {
          icon.textContent = '▶';
        });
        document.querySelectorAll('.btn-play').forEach(btn => {
          btn.innerHTML = '▶ Play Now';
        });
        document.querySelectorAll('.trending-play-btn').forEach(btn => {
          btn.textContent = '▶';
        });
  
        // Add now-playing class to current card and update icon to stop
        const currentCard = document.querySelector(`.random-card[data-record-id="${recordId}"]`);
        if (currentCard) {
          currentCard.classList.add('now-playing');
          const playIcon = currentCard.querySelector('.play-icon');
          if (playIcon) {
            playIcon.textContent = '■';
          }
  
          // Scroll to the card with smooth animation
          setTimeout(() => {
            currentCard.scrollIntoView({
              behavior: 'smooth',
              block: 'center',
              inline: 'nearest'
            });
          }, 100);
        }
  
        // Update featured button if playing from featured
        const featuredBtn = document.querySelector('.featured-release .btn-play');
        if (featuredBtn) {
          const featuredRecordId = featuredBtn.getAttribute('onclick')?.match(/'([^']+)'/)?.[1];
          if (featuredRecordId === recordId) {
            featuredBtn.innerHTML = '■ Stop';
          }
        }
  
        // Update highlight play icons
        document.querySelectorAll('.highlight-card').forEach(card => {
          const artworkDiv = card.querySelector('.highlight-artwork');
          if (artworkDiv) {
            const onclickAttr = artworkDiv.getAttribute('onclick');
            const cardRecordId = onclickAttr?.match(/'([^']+)'/)?.[1];
            if (cardRecordId === recordId) {
              const playIcon = card.querySelector('.play-icon');
              if (playIcon) playIcon.textContent = '■';
            }
          }
        });
  
        // Update trending play icons
        document.querySelectorAll('.trending-card').forEach(card => {
          const artworkDiv = card.querySelector('.trending-artwork');
          if (artworkDiv) {
            const onclickAttr = artworkDiv.getAttribute('onclick');
            const cardRecordId = onclickAttr?.match(/'([^']+)'/)?.[1];
            if (cardRecordId === recordId) {
              const playIcon = card.querySelector('.play-icon');
              if (playIcon) playIcon.textContent = '■';
              const playBtn = card.querySelector('.trending-play-btn');
              if (playBtn) playBtn.textContent = '■';
            }
          }
        });
      }
  

      function isCardDisplayed(recordId) {
        // Check if the record exists in the itemsStore
        // Items from featured, highlights, trending, and random sections are all stored there
        return itemsStore.has(recordId);
      }
  

  // ---- PLAYBACK ----

      function playSong(recordId) {
        console.log('[PlaySong] Called with recordId:', recordId);
        console.log('[PlaySong] Items in store:', itemsStore.size);
  
        // If clicking on the currently playing card, stop playback instead
        if (currentTrackInfo && currentTrackInfo.recordId === recordId && currentAudio && !currentAudio.paused) {
          console.log('[PlaySong] Stopping currently playing track');
          stopPlayback();
          return;
        }
  
        // Check if this card is currently displayed
        if (!isCardDisplayed(recordId)) {
          console.warn('[PlaySong] Card not displayed, skipping:', recordId);
          // If shuffle is active, try playing the next track instead
          if (isShuffleActive) {
            playNextInQueue();
          }
          return;
        }
  
        const item = itemsStore.get(recordId);
        if (!item) {
          console.error('[PlaySong] Item not found in store. RecordId:', recordId);
          console.error('[PlaySong] Available IDs:', Array.from(itemsStore.keys()));
          return;
        }
  
        console.log('[PlaySong] Found item:', item);
        const audioUrl = getAudioUrl(item.fields, item.recordId);
        console.log('[PlaySong] Audio URL:', audioUrl);
  
        if (!audioUrl) {
          console.warn('[PlaySong] Audio not available for this track:', recordId);
          return;
        }
  
        const title = getTitleField(item.fields);
        const artist = getArtistField(item.fields);
        const album = getAlbumField(item.fields);
        const artworkUrl = getArtworkUrl(item.fields);
        const isrc = (item.fields?.['ISRC'] || '').trim();
  
        console.log(`[PlaySong] Playing: ${title} by ${artist}`);
  
        // Store current track info with recordId for stream tracking
        currentTrackInfo = { title, artist, album, artworkUrl, recordId: item.recordId, isrc };
  
        // Update visual state - highlight currently playing card
        updateNowPlayingCard(recordId);
  
        // Stop current audio if playing
        if (currentAudio) {
          console.log('[PlaySong] Stopping previous audio');
          isSwitchingTracks = true; // Prevent pause event from firing
          stopProgressTracking();
          sendStreamEvent('END');
          currentAudio.pause();
          currentAudio = null;
        }
  
        // Reset stream tracking state
        lastStreamReportTs = 0;
        lastStreamReportPos = 0;
        lastProgressSentAt = 0;
        hasReportedPlay = false;
  
        // Create and play new audio
        console.log('[PlaySong] Creating new Audio element');
        currentAudio = new Audio(audioUrl);
  
        const _thisAudio = currentAudio;
  
        // Add stream event listeners
        currentAudio.addEventListener('ended', () => {
          if (currentAudio !== _thisAudio) return;
          isPlaying = false;
          const duration = _thisAudio.duration || 0;
          const finalPosition = _thisAudio.currentTime || duration;
          const delta = Math.abs((finalPosition || 0) - lastStreamReportPos);
          sendStreamEvent('END', finalPosition, duration, delta);
          stopProgressTracking();
          updateMiniPlayer(title, artist, artworkUrl);
  
          // Auto-play next track in shuffle queue
          if (isShuffleActive) {
            setTimeout(() => playNextInQueue(), 500);
          }
        });
  
        currentAudio.addEventListener('error', (e) => {
          if (currentAudio !== _thisAudio) return;
          console.error('[PlaySong] Audio error:', e);
          sendStreamEvent('ERROR');
          stopProgressTracking();
          isPlaying = false;
          updateMiniPlayer(title, artist, artworkUrl);
        });
  
        currentAudio.addEventListener('pause', () => {
          if (currentAudio !== _thisAudio) return;
          // Don't send PAUSE if we're switching tracks or if the track has ended
          if (!_thisAudio.ended && isPlaying && !isSwitchingTracks) {
            sendStreamEvent('PAUSE');
            stopProgressTracking();
          }
        });
  
        // Update progress bar and time display
        currentAudio.addEventListener('timeupdate', () => {
          if (currentAudio !== _thisAudio) return;
          if (!_thisAudio || !_thisAudio.duration) return;
          const pct = (_thisAudio.currentTime / _thisAudio.duration) * 100;
          const fill = document.getElementById('nowPlayingProgressFill');
          const timeEl = document.getElementById('playerCurrentTime');
          if (fill) fill.style.width = pct + '%';
          if (timeEl) {
            const s = Math.floor(_thisAudio.currentTime);
            timeEl.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
          }
        });
  
        // Reset progress bar when a new track starts
        const fillEl = document.getElementById('nowPlayingProgressFill');
        const timeEl = document.getElementById('playerCurrentTime');
        if (fillEl) fillEl.style.width = '0%';
        if (timeEl) timeEl.textContent = '0:00';
  
        // Start playback and send PLAY event after metadata loads
        let metadataLoaded = false;
        currentAudio.addEventListener('loadedmetadata', () => {
          if (currentAudio !== _thisAudio) return;
          console.log(`[PlaySong] Duration loaded: ${_thisAudio.duration}s`);
          metadataLoaded = true;
        });
  
        currentAudio.play().then(() => {
          if (currentAudio !== _thisAudio) return;
          console.log(`[PlaySong] ✓ Now playing: ${title} by ${artist}`);
          isPlaying = true;
          isSwitchingTracks = false; // Reset flag after successful play
  
          // Wait a moment for metadata if not loaded yet, then send PLAY event
          const sendPlayEvent = () => {
            if (currentAudio !== _thisAudio) return;
            if (!hasReportedPlay) {
              const duration = _thisAudio.duration || 0;
              console.log(`[Stream Event] Sending PLAY with duration: ${duration}s`);
              sendStreamEvent('PLAY', 0, duration, 0);
              hasReportedPlay = true;
            }
          };
  
          if (metadataLoaded || _thisAudio.duration) {
            sendPlayEvent();
          } else {
            setTimeout(sendPlayEvent, 100);
          }
  
          startProgressTracking();
          updateMiniPlayer(title, artist, artworkUrl);
        }).catch(err => {
          isSwitchingTracks = false;
          console.error('[PlaySong] ✗ Playback failed:', err);
          sendStreamEvent('ERROR');
          stopProgressTracking();
          isPlaying = false;
        });
  
        // Emit event for potential integration with classic view
        window.dispatchEvent(new CustomEvent('play-track', {
          detail: {
            url: audioUrl,
            title,
            artist,
            album,
            recordId: item.recordId
          }
        }));
      }
  

      function togglePause() {
        if (!currentAudio) return;
  
        if (isPlaying) {
          currentAudio.pause();
          isPlaying = false;
          // PAUSE event is sent by the pause listener
        } else {
          // Resume playback
          currentAudio.play().then(() => {
            isPlaying = true;
            startProgressTracking();
            updateMiniPlayer(currentTrackInfo.title, currentTrackInfo.artist, currentTrackInfo.artworkUrl);
          });
        }
  
        if (currentTrackInfo) {
          updateMiniPlayer(currentTrackInfo.title, currentTrackInfo.artist, currentTrackInfo.artworkUrl);
        }
      }
  

      function stopPlayback() {
        if (currentAudio) {
          isSwitchingTracks = true; // Suppress pause event
          sendStreamEvent('END');
          stopProgressTracking();
          currentAudio.pause();
          currentAudio.currentTime = 0;
          currentAudio = null;
          isSwitchingTracks = false;
        }
        isPlaying = false;
        hasReportedPlay = false;
        hideMiniPlayer();
  
        // Remove now-playing class from all cards and reset all play icons
        document.querySelectorAll('.random-card.now-playing').forEach(card => {
          card.classList.remove('now-playing');
        });
  
        // Reset all play icons back to play button
        document.querySelectorAll('.play-icon').forEach(icon => {
          icon.textContent = '▶';
        });
        document.querySelectorAll('.btn-play').forEach(btn => {
          btn.innerHTML = '▶ Play Now';
        });
        document.querySelectorAll('.trending-play-btn').forEach(btn => {
          btn.textContent = '▶';
        });
  
        currentTrackInfo = null;
      }
  

  // ---- SHUFFLE ----

      function shuffleArray(array) {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
      }
  

      function toggleShufflePl() {
        if (isShuffleActive) {
          // Stop shuffle
          stopShufflePlay();
        } else {
          // Start shuffle
          startShufflePlay();
        }
      }
  

      function startShufflePlay() {
        // Get all currently displayed cards from the DOM
        const container = document.getElementById('randomContainer');
        if (!container) {
          alert('No tracks available to shuffle');
          return;
        }
  
        // Get record IDs directly from displayed cards
        const displayedCards = container.querySelectorAll('.random-card[data-record-id]');
        const recordIds = Array.from(displayedCards)
          .map(card => card.getAttribute('data-record-id'))
          .filter(id => {
            const item = itemsStore.get(id);
            return item && hasValidAudio(item);
          });
  
        if (recordIds.length === 0) {
          alert('No tracks available to shuffle');
          return;
        }
  
        // Shuffle and create queue
        shuffleQueue = shuffleArray(recordIds);
        shuffleQueueIndex = 0;
        isShuffleActive = true;
  
        console.log('[Shuffle] Started with', shuffleQueue.length, 'tracks from displayed cards');
  
        // Update button state
        updateShuffleButton();
  
        // Play first track
        if (shuffleQueue.length > 0) {
          playSong(shuffleQueue[0]);
        }
      }
  

      function stopShufflePlay() {
        isShuffleActive = false;
        shuffleQueue = [];
        shuffleQueueIndex = 0;
  
        console.log('[Shuffle] Stopped');
  
        // Update button state
        updateShuffleButton();
      }
  

      function playNextInQueue() {
        if (!isShuffleActive || shuffleQueue.length === 0) {
          return;
        }
  
        shuffleQueueIndex++;
  
        if (shuffleQueueIndex >= shuffleQueue.length) {
          console.log('[Shuffle] Queue finished');
          stopShufflePlay();
          return;
        }
  
        const nextRecordId = shuffleQueue[shuffleQueueIndex];
        console.log('[Shuffle] Playing track', shuffleQueueIndex + 1, 'of', shuffleQueue.length);
        playSong(nextRecordId);
      }
  

      function updateShuffleButton() {
        const btn = document.getElementById('genreShufflePlayBtn');
        if (!btn) return;
  
        if (isShuffleActive) {
          btn.textContent = '⏹️ Stop Shuffle';
          btn.classList.add('active');
        } else {
          btn.textContent = '🔀 Shuffle Play';
          btn.classList.remove('active');
        }
      }
  

  // ---- PUBLIC API ----

  window.MADPlayer = {
    playSong,
    togglePause,
    stopPlayback,
    isPlaying: () => isPlaying,
    itemsStore,
    updateNowPlayingCard,
    updateMiniPlayer,
    hideMiniPlayer,
    getCurrentTrackMeta,
    sendStreamEvent,
    startProgressTracking,
    stopProgressTracking,
    toggleShufflePl,
    startShufflePlay,
    stopShufflePlay,
    playNextInQueue
  };

  // Keep direct window assignments for HTML onclick compatibility
  window.playSong = playSong;
  window.togglePause = togglePause;
  window.stopPlayback = stopPlayback;
  window.toggleShufflePl = toggleShufflePl;
  window.itemsStore = itemsStore;
})();