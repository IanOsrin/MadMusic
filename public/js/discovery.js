(function() {
  'use strict';

  // ---- DISCOVERY FUNCTIONS ----
// Access Token and Payment Handling
    const STORAGE_KEY = 'mass_access_token';
    let accessToken = localStorage.getItem(STORAGE_KEY);
    let selectedPlan     = '7-day'; // Default plan (matches server PAYSTACK_PLANS keys)
    let selectedPlanType = 'one-time'; // 'one-time' | 'subscription' (trial has its own button)

    // Legacy access token variable for compatibility
    let currentAccessToken = window.currentAccessToken || localStorage.getItem('mass_access_token');

    // Load payment plans and render them
    async function loadPaymentPlans() {
      try {
        console.log('[Payment] Loading payment plans...');
        const res = await fetch('/api/payments/plans');
        console.log('[Payment] Response status:', res.status);
        const data = await res.json();
        console.log('[Payment] Response data:', data);
        if (data.ok && data.plans) {
          console.log('[Payment] Rendering', data.plans.length, 'plans');
          renderPaymentPlans(data.plans);
        } else {
          console.error('[Payment] Invalid response format:', data);
        }
      } catch (err) {
        console.error('[Payment] Failed to load payment plans:', err);
      }
    }

    function renderPaymentPlans(plans) {
      const plansContainer = document.getElementById('paymentPlans');
      console.log('[Payment] Plans container:', plansContainer);
      console.log('[Payment] Plans to render:', plans);
      plansContainer.innerHTML = plans.map(plan => `
        <div class="plan-option ${plan.id === selectedPlan ? 'selected' : ''}" data-plan="${plan.id}" data-plan-type="one-time">
          <div class="plan-info">
            <div class="plan-name">${plan.label}</div>
            <div class="plan-duration">${plan.days} ${plan.days === 1 ? 'day' : 'days'} of unlimited streaming</div>
          </div>
          <div class="plan-price">${plan.display}</div>
        </div>
      `).join('');

      // Load subscription plan label/price from server
      fetch('/api/payments/subscription-plan')
        .then(r => r.json())
        .then(data => {
          if (data.ok && data.plan) {
            const priceEl = document.getElementById('subscriptionPlanPrice');
            if (priceEl) priceEl.textContent = data.plan.display || 'Monthly';
          }
        })
        .catch(() => {}); // non-fatal

      // Wire one-time plan card clicks
      document.querySelectorAll('.plan-option[data-plan-type="one-time"]').forEach(option => {
        option.addEventListener('click', () => {
          document.querySelectorAll('.plan-option').forEach(o => o.classList.remove('selected'));
          option.classList.add('selected');
          selectedPlan     = option.dataset.plan;
          selectedPlanType = 'one-time';
          const btn = document.getElementById('paymentSubmit');
          if (btn) btn.textContent = 'Continue to Payment';
        });
      });

      // Wire subscription card click
      const subCard = document.getElementById('subscriptionPlanCard');
      if (subCard) {
        subCard.addEventListener('click', () => {
          document.querySelectorAll('.plan-option').forEach(o => o.classList.remove('selected'));
          subCard.classList.add('selected');
          selectedPlanType = 'subscription';
          const btn = document.getElementById('paymentSubmit');
          if (btn) btn.textContent = 'Subscribe';
        });
      }

    }

    // Show payment modal if no token
    function checkAccessToken() {
      if (!accessToken) {
        document.getElementById('paymentOverlay').classList.remove('hidden');
      }
    }

    // Toggle between purchase and token input
    // Note: ?payment=success&token= URL handling is done atomically by auth.js
    // before DOMContentLoaded fires, so no duplicate handler is needed here.
    document.addEventListener('DOMContentLoaded', () => {
      // Only attach payment modal listeners if elements exist
      const showTokenInputBtn = document.getElementById('showTokenInput');
      const showPurchaseBtn = document.getElementById('showPurchase');
      const tokenSubmitBtn = document.getElementById('tokenSubmit');

      if (showTokenInputBtn) {
        showTokenInputBtn.addEventListener('click', () => {
          document.getElementById('purchaseSection').classList.add('hidden');
          document.getElementById('tokenSection').classList.add('active');
          document.getElementById('paymentError').textContent = '';
        });
      }

      if (showPurchaseBtn) {
        showPurchaseBtn.addEventListener('click', () => {
          document.getElementById('tokenSection').classList.remove('active');
          document.getElementById('purchaseSection').classList.remove('hidden');
          document.getElementById('paymentError').textContent = '';
        });
      }

      // Token submission is handled by the token overlay JS (uses /api/access/validate)
      // No duplicate handler needed here

      // Handle payment submission (one-time and subscription only)
      const paymentSubmitBtn = document.getElementById('paymentSubmit');
      if (paymentSubmitBtn) {
        paymentSubmitBtn.addEventListener('click', async () => {
          const email    = document.getElementById('paymentEmail').value.trim();
          const errorEl  = document.getElementById('paymentError');
          const submitBtn = document.getElementById('paymentSubmit');

          errorEl.textContent = '';

          if (!email || !email.includes('@')) {
            errorEl.textContent = 'Please enter a valid email address';
            return;
          }

          submitBtn.disabled = true;
          submitBtn.textContent = 'Processing...';

          const isSubscription = selectedPlanType === 'subscription';
          const endpoint = isSubscription ? '/api/payments/subscribe' : '/api/payments/initialize';
          const payload  = isSubscription  ? { email } : { email, plan: selectedPlan };
          const btnLabel = isSubscription  ? 'Subscribe' : 'Continue to Payment';

          try {
            const res  = await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            const data = await res.json();

            if (data.ok && data.authorization_url) {
              window.location.href = data.authorization_url;
            } else {
              errorEl.textContent = data.error || 'Failed to initialize payment';
              submitBtn.disabled  = false;
              submitBtn.textContent = btnLabel;
            }
          } catch (err) {
            console.error('Payment initialization error:', err);
            errorEl.textContent   = 'Network error. Please try again.';
            submitBtn.disabled    = false;
            submitBtn.textContent = btnLabel;
          }
        });
      }

      // Handle free trial submission — completely separate from payment flow
      const trialSubmitBtn = document.getElementById('trialSubmit');
      if (trialSubmitBtn) {
        trialSubmitBtn.addEventListener('click', async () => {
          const email    = document.getElementById('paymentEmail').value.trim();
          const errorEl  = document.getElementById('trialError');
          const submitBtn = document.getElementById('trialSubmit');

          errorEl.style.display  = 'none';
          errorEl.textContent    = '';

          if (!email || !email.includes('@')) {
            errorEl.textContent   = 'Please enter your email address above first';
            errorEl.style.display = 'block';
            document.getElementById('paymentEmail').focus();
            return;
          }

          submitBtn.disabled    = true;
          submitBtn.textContent = 'Starting trial...';

          try {
            const res  = await fetch('/api/payments/trial', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email })
            });
            const data = await res.json();

            if (data.ok && data.token) {
              localStorage.setItem(STORAGE_KEY, data.token);
              accessToken = data.token;
              window.location.reload();
            } else {
              errorEl.textContent   = data.error || 'Failed to start trial. Please try again.';
              errorEl.style.display = 'block';
              submitBtn.disabled    = false;
              submitBtn.textContent = 'Start 7-Day Free Trial';
            }
          } catch (err) {
            console.error('Trial error:', err);
            errorEl.textContent   = 'Network error. Please try again.';
            errorEl.style.display = 'block';
            submitBtn.disabled    = false;
            submitBtn.textContent = 'Start 7-Day Free Trial';
          }
        });
      }

      // Load payment plans first, then check access token
      loadPaymentPlans().then(() => {
        checkAccessToken();
      });
    });

    // API endpoints
    const API = {
      featured: '/api/featured-albums?limit=1',
      highlights: '/api/random-songs?count=2&_t=' + Date.now(),
      random: '/api/random-songs?count=20&_t=' + Date.now(), // Increased to 20, added timestamp for fresh results
      trending: '/api/trending',
      newReleases: '/api/new-releases',
      search: '/api/search',
      container: '/api/container'
    };

    const TRENDING_RESULT_LIMIT = 5;
    const TRENDING_FETCH_LIMIT = 25; // Fetch more to ensure 5 valid after filtering
    let randomItems = [];
    let randomTitleDefault = 'Discover More';
    let randomSubtitleDefault = 'Find more fascinating picks from our archive';

    // Global storage for items (so we can reference them by ID in onclick handlers)
    const itemsStore = new Map();

    // Helper: write to both local store and player.js's shared store
    function storeItem(recordId, item) {
      itemsStore.set(recordId, item);
      if (window.itemsStore && window.itemsStore !== itemsStore) {
        window.itemsStore.set(recordId, item);
      }
    }

    let currentAudio = null;
    let playGeneration = 0;   // incremented each time a new track starts; guards stale event listeners
    let currentTrackInfo = null;
    let isPlaying = false;

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

    // Fetch wrapper with access token (now handled by global fetch interceptor)
    async function apiFetch(url, options = {}) {
      // The global fetch interceptor already handles adding the access token header
      // and showing the overlay on 403 errors, so we just pass through to fetch
      return fetch(url, options);
    }

    // Stream Event Tracking Functions
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

    // Helper functions
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
      const audioFields = ['S3_URL', 'Tape Files::S3_URL', 'mp3', 'MP3', 'Tape Files::mp3', 'Tape Files::MP3', 'Audio File', 'Audio::mp3', 'Stream URL', 'Audio URL'];
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
      const audioFields = ['S3_URL', 'Tape Files::S3_URL', 'mp3', 'MP3', 'Tape Files::mp3', 'Tape Files::MP3', 'Audio File', 'Audio::mp3', 'Stream URL', 'Audio URL'];
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
      const artistFields = ['Track Artist', 'Artist', 'Artist Name', 'Album Artist'];
      return getFieldValue(fields, artistFields) || 'Unknown Artist';
    }

    function getAlbumField(fields) {
      const albumFields = ['Album Title', 'Album', 'Album Name'];
      return getFieldValue(fields, albumFields) || 'Unknown Album';
    }

    function getGenreField(fields) {
      return getFieldValue(fields, ['Local Genre', 'Song Files::Local Genre']) || '';
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

    // Group tracks by album
    function groupByAlbum(items) {
      const albumMap = new Map();

      items.forEach(item => {
        const fields = item.fields || {};
        const album = getAlbumField(fields);
        const artist = getArtistField(fields);
        const albumKey = `${album}|||${artist}`; // Use delimiter to avoid conflicts

        if (!albumMap.has(albumKey)) {
          albumMap.set(albumKey, {
            album,
            artist,
            artwork: getArtworkUrl(fields),
            tracks: []
          });
        }

        albumMap.get(albumKey).tracks.push(item);
      });

      return Array.from(albumMap.values());
    }

    // ---- Artist albums prompt ----
    function navigateToArtistAlbums(artist) {
      if (window.showView) window.showView('albums');
      const searchArtist = document.getElementById('searchArtist');
      const searchAlbum  = document.getElementById('searchAlbum');
      const searchFields = document.getElementById('searchFields');
      const goBtn        = document.getElementById('go');
      if (searchArtist) searchArtist.value = artist;
      if (searchAlbum)  searchAlbum.value  = '';
      if (searchFields) searchFields.hidden = false;
      if (goBtn)        goBtn.click();
    }

    function showArtistAlbumsPrompt(recordId) {
      const item = itemsStore.get(recordId);
      if (!item) { playSong(recordId); return; }
      const fields = item.fields || {};
      const artist = getArtistField(fields);
      if (!artist) { playSong(recordId); return; }

      document.getElementById('artistPromptOverlay')?.remove();

      const overlay = document.createElement('div');
      overlay.id = 'artistPromptOverlay';
      overlay.className = 'artist-prompt-overlay';
      overlay.innerHTML = `
        <div class="artist-prompt-box">
          <p class="artist-prompt-q">See all albums by</p>
          <p class="artist-prompt-name">${escapeHtml(artist)}</p>
          <div class="artist-prompt-actions">
            <button class="artist-prompt-btn artist-prompt-yes">Yes, explore</button>
            <button class="artist-prompt-btn artist-prompt-no">Dismiss</button>
          </div>
        </div>
      `;
      overlay.querySelector('.artist-prompt-yes').addEventListener('click', () => {
        overlay.remove();
        navigateToArtistAlbums(artist);
      });
      overlay.querySelector('.artist-prompt-no').addEventListener('click', () => overlay.remove());
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      document.body.appendChild(overlay);
    }
    // Update mini player UI
    function updateMiniPlayer(title, artist, artworkUrl) {
      const miniPlayer = document.getElementById('miniPlayer');
      if (!miniPlayer) return; // #miniPlayer doesn't exist in app.html; #unifiedPlayer handles display
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
      if (!miniPlayer) return; // #miniPlayer doesn't exist in app.html
      miniPlayer.classList.remove('active');
    }

    // Update visual state to highlight currently playing card
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

    // Check if a card is currently displayed in any section
    function isCardDisplayed(recordId) {
      // Check if the record exists in the itemsStore
      // Items from featured, highlights, trending, and random sections are all stored there
      return itemsStore.has(recordId);
    }

    // Play function with actual audio playback
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

      // Capture this play's generation so event listeners self-invalidate when a new track starts
      const myGeneration = ++playGeneration;

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

      // Route through the unified shared player so #unifiedPlayer ribbon shows
      console.log('[PlaySong] Routing through unified player');
      const sharedPlayer = document.getElementById('player');
      currentAudio = sharedPlayer;

      // Add generation-guarded stream event listeners on the shared player
      sharedPlayer.addEventListener('ended', () => {
        if (playGeneration !== myGeneration) return;
        isPlaying = false;
        const duration = sharedPlayer.duration || 0;
        const finalPosition = sharedPlayer.currentTime || duration;
        const delta = Math.abs((finalPosition || 0) - lastStreamReportPos);
        sendStreamEvent('END', finalPosition, duration, delta);
        stopProgressTracking();
      });

      sharedPlayer.addEventListener('error', (e) => {
        if (playGeneration !== myGeneration) return;
        console.error('[PlaySong] Audio error:', e);
        sendStreamEvent('ERROR');
        stopProgressTracking();
        isPlaying = false;
      });

      sharedPlayer.addEventListener('pause', () => {
        if (playGeneration !== myGeneration) return;
        // Don't send PAUSE if we're switching tracks or if the track has ended
        if (!sharedPlayer.ended && isPlaying && !isSwitchingTracks) {
          sendStreamEvent('PAUSE');
          stopProgressTracking();
          isPlaying = false;
        }
      });

      // Resume tracking if user resumes via the unified player's toggle
      sharedPlayer.addEventListener('play', () => {
        if (playGeneration !== myGeneration) return;
        if (!isPlaying) {
          isPlaying = true;
          startProgressTracking();
        }
      });

      // Update progress bar and time display
      sharedPlayer.addEventListener('timeupdate', () => {
        if (playGeneration !== myGeneration) return;
        if (!sharedPlayer.duration) return;
        const pct = (sharedPlayer.currentTime / sharedPlayer.duration) * 100;
        const fill = document.getElementById('nowPlayingProgressFill');
        const timeEl = document.getElementById('playerCurrentTime');
        if (fill) fill.style.width = pct + '%';
        if (timeEl) {
          const s = Math.floor(sharedPlayer.currentTime);
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
      sharedPlayer.addEventListener('loadedmetadata', () => {
        if (playGeneration !== myGeneration) return;
        console.log(`[PlaySong] Duration loaded: ${sharedPlayer.duration}s`);
        metadataLoaded = true;
      });

      // Play via _PLAYER.playTrack so the unified ribbon activates
      const _playPromise = (window._PLAYER && window._PLAYER.playTrack)
        ? window._PLAYER.playTrack(audioUrl, { title, artist, artUrl: artworkUrl, recordId })
        : (sharedPlayer
            ? (() => { sharedPlayer.src = audioUrl; return sharedPlayer.play(); })()
            : Promise.resolve());

      (_playPromise || Promise.resolve()).then(() => {
        if (playGeneration !== myGeneration) return;
        console.log(`[PlaySong] ✓ Now playing: ${title} by ${artist}`);
        isPlaying = true;
        isSwitchingTracks = false; // Reset flag after successful play

        // Wait a moment for metadata if not loaded yet, then send PLAY event
        const sendPlayEvent = () => {
          if (playGeneration !== myGeneration) return;
          if (!hasReportedPlay) {
            const duration = sharedPlayer.duration || 0;
            console.log(`[Stream Event] Sending PLAY with duration: ${duration}s`);
            sendStreamEvent('PLAY', 0, duration, 0);
            hasReportedPlay = true;
          }
        };

        if (metadataLoaded || sharedPlayer.duration) {
          sendPlayEvent();
        } else {
          setTimeout(sendPlayEvent, 100);
        }

        startProgressTracking();
      }).catch(err => {
        if (playGeneration !== myGeneration) return;
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

    // Pause/Resume function
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

    // Stop function
    function stopPlayback() {
      playGeneration++; // invalidate stale listeners before pausing
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

    // Render functions
    function renderFeatured(items) {
      const container = document.getElementById('featuredContainer');

      if (!items || items.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">🎵</div>
            <p>No featured releases available</p>
          </div>
        `;
        return;
      }

      // Filter items to only include those with valid audio
      const validItems = items.filter(item => hasValidAudio(item));
      console.log('[Featured] Filtered', validItems.length, 'items with valid audio out of', items.length, 'total');

      if (validItems.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">🎵</div>
            <p>No featured releases with audio available</p>
          </div>
        `;
        return;
      }

      const item = validItems[0];
      const fields = item.fields || {};
      const artworkUrl = getArtworkUrl(fields);
      const title = getTitleField(fields);
      const artist = getArtistField(fields);
      const album = getAlbumField(fields);

      console.log('[Featured] Item:', {recordId: item.recordId, title, artist, album, artworkUrl});

      // Store item for later reference
      storeItem(item.recordId, item);

      // Create URL for Jukebox view with album filter
      const jukeboxUrl = `/classic?album=${encodeURIComponent(album)}&artist=${encodeURIComponent(artist)}`;

      container.innerHTML = `
        <div class="featured-release">
          <div class="featured-artwork">
            ${artworkUrl
              ? `<img src="${escapeHtml(artworkUrl)}" alt="${escapeHtml(album)}" onerror="this.closest('.featured-release').style.display='none'" />`
              : '<div class="artwork-placeholder">♪</div>'
            }
          </div>
          <div class="featured-info">
            <div class="featured-label">Featured Release</div>
            <h1 class="featured-title">${escapeHtml(title)}</h1>
            <p class="featured-artist">${escapeHtml(artist)}</p>
            <p class="featured-album">${escapeHtml(album)}</p>
            <div class="featured-actions">
              <button class="btn-play" onclick="playSong('${escapeHtml(item.recordId)}')">
                ▶ Play Now
              </button>
              <a href="${escapeHtml(jukeboxUrl)}" class="btn-secondary" style="text-decoration: none;">
                💿 View Album
              </a>
            </div>
          </div>
        </div>
      `;
    }

    function renderHighlights(items) {
      const container = document.getElementById('highlightsContainer');

      if (!items || items.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">🎵</div>
            <p>No highlights available</p>
          </div>
        `;
        return;
      }

      // Filter items to only include those with valid audio
      const validItems = items.filter(item => hasValidAudio(item));
      console.log('[Highlights] Filtered', validItems.length, 'items with valid audio out of', items.length, 'total');

      if (validItems.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">🎵</div>
            <p>No highlights with audio available</p>
          </div>
        `;
        return;
      }

      container.innerHTML = validItems.slice(0, 2).map(item => {
        const fields = item.fields || {};
        const artworkUrl = getArtworkUrl(fields);
        const title = getTitleField(fields);
        const artist = getArtistField(fields);
        const album = getAlbumField(fields);

        // Store item for later reference
        storeItem(item.recordId, item);

        // Create URL for Jukebox view with album filter
        const jukeboxUrl = `/classic?album=${encodeURIComponent(album)}&artist=${encodeURIComponent(artist)}`;

        return `
          <div class="highlight-card">
            <div class="highlight-artwork" onclick="playSong('${escapeHtml(item.recordId)}')">
              ${artworkUrl
                ? `<img src="${escapeHtml(artworkUrl)}" alt="${escapeHtml(album)}" onerror="this.closest('.highlight-card').style.display='none'" />`
                : '<div class="artwork-placeholder">♪</div>'
              }
              <div class="play-overlay">
                <div class="play-icon">▶</div>
              </div>
            </div>
            <div class="highlight-info">
              <div class="highlight-title">${escapeHtml(title)}</div>
              <div class="highlight-artist">${escapeHtml(artist)}</div>
              <div class="highlight-album">${escapeHtml(album)}</div>
            </div>
            <div class="highlight-actions">
              <a href="${escapeHtml(jukeboxUrl)}" class="highlight-album-btn" title="View album in Jukebox">💿 View Album</a>
            </div>
          </div>
        `;
      }).join('');
    }

    function renderTrending(items) {
      const container = document.getElementById('trendingContainer');
      if (!container) return;

      if (!Array.isArray(items) || !items.length) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">📈</div>
            <p>No trending songs yet</p>
          </div>
        `;
        return;
      }

      const validItems = items.filter(item => hasValidAudio(item));
      if (!validItems.length) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">📈</div>
            <p>No trending songs with playback available</p>
          </div>
        `;
        return;
      }

      container.innerHTML = validItems.slice(0, TRENDING_RESULT_LIMIT).map((item, index) => {
        const fields = item.fields || {};
        const artworkUrl = getArtworkUrl(fields);
        const title = getTitleField(fields);
        const artist = getArtistField(fields);
        const album = getAlbumField(fields);
        const meta = formatTrendingMeta(item.metrics || {});

        storeItem(item.recordId, item);

        // Create URL for Jukebox view with album filter
        const jukeboxUrl = `/classic?album=${encodeURIComponent(album)}&artist=${encodeURIComponent(artist)}`;

        return `
          <div class="trending-card">
            <div class="trending-rank">#${index + 1}</div>
            <div class="trending-artwork" onclick="playSong('${escapeHtml(item.recordId)}')">
              ${artworkUrl
                ? `<img src="${escapeHtml(artworkUrl)}" alt="${escapeHtml(title)}" onerror="this.closest('.trending-card').style.display='none'" />`
                : '<div class="artwork-placeholder">♪</div>'
              }
              <div class="play-overlay">
                <div class="play-icon">▶</div>
              </div>
            </div>
            <div class="trending-info">
              <div class="trending-title">${escapeHtml(title)}</div>
              <div class="trending-artist">${escapeHtml(artist)}</div>
              <div class="trending-meta">${escapeHtml(meta || 'Now playing across MAD')}</div>
            </div>
            <button class="trending-play-btn" onclick="playSong('${escapeHtml(item.recordId)}')">▶</button>
            <a href="${escapeHtml(jukeboxUrl)}" class="trending-album-btn" title="View album in Jukebox">💿</a>
            <button class="card-album-btn" title="View album" onclick="if(window.showView) window.showView('albums'); var s=document.getElementById('search'); if(s){s.value='${escapeHtml(album)}';} if(window.run) window.run('${escapeHtml(album)}');"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg></button>
          </div>
        `;
      }).join('');
    }

    // Helper to create HTML for a single random card
    function createRandomCardHtml(item) {
      const fields = item.fields || {};
      const artworkUrl = getArtworkUrl(fields);
      const title = getTitleField(fields);
      const artist = getArtistField(fields);
      const album = getAlbumField(fields);
      const genre = getGenreField(fields);

      console.log('[Random] Item:', {recordId: item.recordId, title, artist, album, genre, artworkUrl});

      // Store item for later reference
      storeItem(item.recordId, item);

      // Create URL for Jukebox view with album filter
      const jukeboxUrl = `/classic?album=${encodeURIComponent(album)}&artist=${encodeURIComponent(artist)}`;

      return `
        <div class="random-card" data-record-id="${escapeHtml(item.recordId)}">
          <div class="random-artwork">
            ${artworkUrl
              ? `<img src="${escapeHtml(artworkUrl)}" alt="${escapeHtml(album)}" onerror="this.closest('.random-card').style.display='none'" />`
              : '<div class="artwork-placeholder">♪</div>'
            }
            <div class="play-overlay">
              <div class="play-icon">▶</div>
            </div>
          </div>
          <div class="random-info">
            <div class="random-title">${escapeHtml(title)}</div>
            <div class="random-artist">${escapeHtml(artist)}</div>
            <div class="random-album">${escapeHtml(album)}</div>
            ${genre ? `<div class="random-genre"><span class="genre-badge">${escapeHtml(genre)}</span></div>` : ''}
            <div class="card-quick-actions">
              <button class="track-action-btn card-playlist-btn" title="Add to playlist">+ Playlist</button>
              <button class="track-action-btn card-library-btn" title="Save to library">♡ Save</button>
            </div>
          </div>
          <button class="card-album-btn" title="View album" onclick="if(window.showView) window.showView('albums'); var s=document.getElementById('search'); if(s){s.value='${escapeHtml(album)}';} if(window.run) window.run('${escapeHtml(album)}');"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg></button>
        </div>
      `;
    }

    function renderRandom(items) {
      const container = document.getElementById('randomContainer');

      if (!items || items.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">🎵</div>
            <p>No songs available</p>
          </div>
        `;
        return;
      }

      // Filter items to only include those with valid audio
      const validItems = items.filter(item => hasValidAudio(item));
      console.log('[Random] Filtered', validItems.length, 'items with valid audio out of', items.length, 'total');

      if (validItems.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">🎵</div>
            <p>No songs with audio available</p>
          </div>
        `;
        return;
      }

      container.innerHTML = validItems.map(item => createRandomCardHtml(item)).join('');
      setupCardQuickActions(container);
    }

    // Shuffle array utility
    function shuffleArray(array) {
      const shuffled = [...array];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled;
    }

    // Progressive rendering - append items one at a time
    async function renderRandomProgressive(items) {
      const container = document.getElementById('randomContainer');

      if (!items || items.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">🎵</div>
            <p>No songs available</p>
          </div>
        `;
        return;
      }

      // Filter items to only include those with valid audio
      const validItems = items.filter(item => hasValidAudio(item));
      console.log('[Random Progressive] Filtered', validItems.length, 'items with valid audio out of', items.length, 'total');

      if (validItems.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">🎵</div>
            <p>No songs with audio available</p>
          </div>
        `;
        return;
      }

      // Clear container and start fresh
      container.innerHTML = '';

      // Render items progressively - append as fast as possible
      for (const item of validItems) {
        const cardHtml = createRandomCardHtml(item);
        container.insertAdjacentHTML('beforeend', cardHtml);
      }
      setupCardQuickActions(container);
    }

    // Render albums (grouped by album)
    function renderAlbums(albums) {
      const container = document.getElementById('randomContainer');

      if (!albums || albums.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">🎵</div>
            <p>No albums available</p>
          </div>
        `;
        return;
      }

      container.innerHTML = albums.map(albumData => {
        const { album, artist, artwork, tracks } = albumData;
        const trackCount = tracks.length;

        // Store all tracks for this album
        tracks.forEach(track => {
          storeItem(track.recordId, track);
        });

        // Get first track's recordId for playing
        const firstTrackId = tracks[0]?.recordId;

        // Create URL for Jukebox view with album filter
        const jukeboxUrl = `/classic?album=${encodeURIComponent(album)}&artist=${encodeURIComponent(artist)}`;

        return `
          <div class="random-card">
            <div class="random-artwork">
              ${artwork
                ? `<img src="${escapeHtml(artwork)}" alt="${escapeHtml(album)}" onerror="this.closest('.random-card').style.display='none'" />`
                : '<div class="artwork-placeholder">♪</div>'
              }
              <div class="play-overlay">
                <div class="play-icon">▶</div>
              </div>
            </div>
            <div class="random-info">
              <div class="random-title">${escapeHtml(album)}</div>
              <div class="random-artist">${escapeHtml(artist)}</div>
              <div class="random-album">${trackCount} track${trackCount !== 1 ? 's' : ''}</div>
            </div>
            <div class="random-actions">
              <a href="${escapeHtml(jukeboxUrl)}" class="random-album-btn" title="View album in Jukebox">💿 View Album</a>
            </div>
          </div>
        `;
      }).join('');
    }

    // Fetch and render data
    async function loadFeatured() {
      try {
        console.log('[Featured] Fetching...');
        const response = await apiFetch(API.featured);
        const data = await response.json();
        console.log('[Featured] Response:', data);
        if (data.ok && data.items) {
          console.log('[Featured] Rendering', data.items.length, 'items');
          renderFeatured(data.items);
        }
      } catch (error) {
        console.error('[Featured] Failed to load:', error);
        document.getElementById('featuredContainer').innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">⚠️</div>
            <p>Failed to load featured release</p>
          </div>
        `;
      }
    }

    async function loadHighlights() {
      try {
        console.log('[Highlights] Fetching...');
        const response = await apiFetch(API.highlights);
        const data = await response.json();
        console.log('[Highlights] Response:', data);
        if (data.ok && data.items) {
          console.log('[Highlights] Rendering', data.items.length, 'items');
          // For highlights, show individual tracks since it's only 2 items
          renderHighlights(data.items);
        }
      } catch (error) {
        console.error('[Highlights] Failed to load:', error);
        document.getElementById('highlightsContainer').innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">⚠️</div>
            <p>Failed to load highlights</p>
          </div>
        `;
      }
    }

    async function loadTrending() {
      const container = document.getElementById('trendingContainer');
      console.log('[Trending] Starting, container:', container);
      if (!container) {
        console.error('[Trending] Container not found!');
        return;
      }
      try {
        const url = `${API.trending}?limit=${TRENDING_FETCH_LIMIT}&_t=${Date.now()}`;
        console.log('[Trending] About to fetch:', url);
        const response = await apiFetch(url);
        console.log('[Trending] Response received:', response.status, response.ok);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        console.log('[Trending] Data received:', data);
        const items = Array.isArray(data?.items) ? data.items : [];
        console.log('[Trending] Items to render:', items.length);
        renderTrending(items);
        console.log('[Trending] Render complete');
      } catch (error) {
        console.error('[Trending] Failed to load:', error);
        console.error('[Trending] Error stack:', error.stack);
        container.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">⚠️</div>
            <p>Failed to load trending songs</p>
            <p style="font-size: 12px; color: #999;">${error.message}</p>
          </div>
        `;
      }
    }

    async function loadRandom(showSpinner = false) {
      try {
        if (showSpinner) {
          const container = document.getElementById('randomContainer');
          if (container) {
            container.innerHTML = `
              <div class="loading">
                <div class="spinner"></div>
              </div>
            `;
          }
        }
        console.log('[Random] Fetching...');
        const response = await apiFetch(API.random);
        const data = await response.json();
        console.log('[Random] Response:', data);
        if (data.ok && data.items) {
          const items = Array.isArray(data.items) ? data.items : [];
          // Deduplicate: one track per album, then one album per artist
          const albums = groupByAlbum(items);
          const seenArtists = new Set();
          const deduped = albums
            .map(album => album.tracks[0])
            .filter(Boolean)
            .filter(track => {
              const artist = getArtistField(track.fields || {});
              const key = artist.toLowerCase().trim();
              if (seenArtists.has(key)) return false;
              seenArtists.add(key);
              return true;
            });
          randomItems = deduped;
          console.log('[Random] Loaded', items.length, 'items, deduped to', deduped.length, 'unique artists');
          if (!isSearching) {
            renderRandom(deduped);
          }
        } else {
          randomItems = [];
          if (!isSearching) {
            renderRandom([]);
          }
        }
      } catch (error) {
        console.error('[Random] Failed to load:', error);
        randomItems = [];
        if (!isSearching) {
          document.getElementById('randomContainer').innerHTML = `
            <div class="empty-state">
              <div class="empty-state-icon">⚠️</div>
              <p>Failed to load songs</p>
            </div>
          `;
        }
      }
    }

    // Search functionality
    let isSearching = false;

    async function performSearch(query) {
      const searchIcon = document.getElementById('searchIcon');
      const searchClearEl = document.getElementById('searchClear');
      if (!query) {
        // Clear search - restore random view
        isSearching = false;
        if (searchClearEl) searchClearEl.style.display = 'none';
        if (searchIcon) { searchIcon.classList.remove('loading'); searchIcon.textContent = '🔍'; }
        loadRandom(true);
        return;
      }

      try {
        isSearching = true;
        if (searchIcon) { searchIcon.classList.add('loading'); searchIcon.textContent = '⏳'; }
        if (searchClearEl) searchClearEl.style.display = 'block';

        console.log('[Search] Searching for:', query);

        // Use the general 'q' parameter for broad search across all fields
        // This searches artist, album, and track name
        // Higher limit to ensure we get all albums for an artist
        const searchParams = new URLSearchParams();
        searchParams.set('q', query);
        searchParams.set('limit', '300');

        const response = await apiFetch(`${API.search}?${searchParams.toString()}`);
        const data = await response.json();

        console.log('[Search] Results:', data);

        if (searchIcon) { searchIcon.classList.remove('loading'); searchIcon.textContent = '🔍'; }

        // Search API returns { items: [...] } directly, no 'ok' field
        if (data.items && data.items.length > 0) {
          // Group tracks by album
          const albums = groupByAlbum(data.items);
          console.log('[Search] Grouped into', albums.length, 'albums from', data.items.length, 'tracks');

          document.getElementById('randomTitle').textContent = `Search Results`;
          document.getElementById('randomSubtitle').textContent = `${albums.length} album${albums.length !== 1 ? 's' : ''} (${data.items.length} track${data.items.length !== 1 ? 's' : ''}) for "${query}"`;
          renderAlbums(albums);
        } else {
          document.getElementById('randomTitle').textContent = 'No Results';
          document.getElementById('randomSubtitle').textContent = `No matches found for "${query}"`;
          document.getElementById('randomContainer').innerHTML = `
            <div class="empty-state">
              <div class="empty-state-icon">🔍</div>
              <p>No results found for "${query}"</p>
              <p style="font-size: 0.875rem; margin-top: 0.5rem;">Try searching for an artist, album, or song name</p>
            </div>
          `;
        }
      } catch (error) {
        console.error('[Search] Failed:', error);
        isSearching = false;
        if (searchIcon) { searchIcon.classList.remove('loading'); searchIcon.textContent = '🔍'; }
        document.getElementById('randomContainer').innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">⚠️</div>
            <p>Search failed</p>
          </div>
        `;
      }
    }

    function clearSearch() {
      const si = document.getElementById('searchInput');
      if (si) si.value = '';
      performSearch('');
    }

    // Search on Enter key only (search elements may not exist in all views)
    const _searchInput = document.getElementById('searchInput');
    const _searchClear = document.getElementById('searchClear');

    if (_searchInput) {
      _searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const query = e.target.value.trim();
          if (!query) { clearSearch(); return; }
          performSearch(query);
        }
      });

      _searchInput.addEventListener('input', (e) => {
        const hasValue = e.target.value.trim().length > 0;
        if (_searchClear) _searchClear.style.display = hasValue ? 'block' : 'none';
      });
    }

    if (_searchClear) {
      _searchClear.addEventListener('click', clearSearch);
    }

    // Send END event when page is unloaded
    window.addEventListener('beforeunload', () => {
      if (currentAudio && !currentAudio.paused) {
        sendStreamEvent('END');
        stopProgressTracking();
      }
    });

    // Function to load all initial content
    function loadInitialContent() {
      if (loadInitialContent._called) return;
      loadInitialContent._called = true;
      console.log('[MADMusic] Loading initial content...');
      console.log('[MADMusic] window.massAccessToken:', window.massAccessToken);
      console.log('[MADMusic] window.currentAccessToken:', window.currentAccessToken);
      console.log('[MADMusic] localStorage token:', localStorage.getItem('mass_access_token'));

      // Update local currentAccessToken variable
      currentAccessToken = window.massAccessToken || window.currentAccessToken || localStorage.getItem('mass_access_token');
      console.log('[MADMusic] Updated currentAccessToken:', currentAccessToken ? `YES (${currentAccessToken})` : 'NO');

      // loadFeatured(); // Removed - Featured section disabled
      // loadHighlights(); // Removed - Highlights section disabled
      console.log('[MADMusic] About to call loadNewReleases()');
      loadNewReleases();
      console.log('[MADMusic] About to call loadTrending()');
      loadTrending();
      console.log('[MADMusic] About to call loadRandom()');
      loadRandom(true);
      console.log('[MADMusic] Initial content load calls completed');
    }

    // Dark Mode Management
    const DARK_MODE_KEY = 'madmusic.darkMode';

    function applyDarkMode(isDark) {
      document.documentElement.classList.toggle('dark-mode', isDark);
      document.body.classList.toggle('dark-mode', isDark);
      const darkModeToggle = document.getElementById('darkModeToggle');
      if (darkModeToggle) {
        darkModeToggle.textContent = isDark ? '☀️' : '🌙';
        darkModeToggle.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
        darkModeToggle.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
      }
      console.log('[Modern Dark Mode] Applied:', isDark);
    }

    function initDarkMode() {
      try {
        const saved = localStorage.getItem(DARK_MODE_KEY);
        const isDark = saved === 'true';
        console.log('[Modern Dark Mode] Initializing with saved preference:', isDark);
        applyDarkMode(isDark);
      } catch (e) {
        console.warn('[Modern Dark Mode] Could not load preference:', e);
      }
    }

    // Initialize dark mode before DOM loads
    initDarkMode();

    // Initialize
    document.addEventListener('DOMContentLoaded', () => {
      // Don't load content yet - wait for access token to be ready

      // Setup dark mode toggle
      const darkModeToggle = document.getElementById('darkModeToggle');
      if (darkModeToggle) {
        console.log('[Modern Dark Mode] Toggle button found, attaching listener');
        // Sync button icon with current dark mode state after DOM loads
        const currentDarkMode = document.body.classList.contains('dark-mode');
        applyDarkMode(currentDarkMode);

        // Auto-hide after 10 seconds
        setTimeout(() => {
          darkModeToggle.classList.add('auto-hidden');
        }, 10000);

        // Show on hover in bottom-right corner
        document.addEventListener('mousemove', (e) => {
          const showDistance = 100; // pixels from bottom-right corner
          const fromRight = window.innerWidth - e.clientX;
          const fromBottom = window.innerHeight - e.clientY;

          if (fromRight < showDistance && fromBottom < showDistance) {
            darkModeToggle.classList.remove('auto-hidden');
          } else {
            darkModeToggle.classList.add('auto-hidden');
          }
        });

        darkModeToggle.addEventListener('click', () => {
          console.log('[Modern Dark Mode] Button clicked');
          const isDark = !document.body.classList.contains('dark-mode');
          applyDarkMode(isDark);
          try {
            localStorage.setItem(DARK_MODE_KEY, isDark.toString());
          } catch (e) {
            console.warn('[Modern Dark Mode] Could not save preference:', e);
          }
        });
      } else {
        console.error('[Modern Dark Mode] Toggle button not found!');
      }

      // African Theme Toggle
      (function() {
        const AFRICAN_KEY = 'mad_african_theme';
        function applyAfricanTheme(on) {
          document.documentElement.classList.toggle('african-theme', on);
          document.body.classList.toggle('african-theme', on);
          const btn = document.getElementById('africanThemeToggle');
          if (btn) btn.title = on ? 'Switch to default theme' : 'African theme';
          try { localStorage.setItem(AFRICAN_KEY, on ? '1' : ''); } catch(e) {}
        }
        // Restore saved state
        try { if (localStorage.getItem(AFRICAN_KEY) === '1') applyAfricanTheme(true); } catch(e) {}
        const btn = document.getElementById('africanThemeToggle');
        if (btn) btn.addEventListener('click', () => applyAfricanTheme(!document.body.classList.contains('african-theme')));
      })();

      // Setup mini player controls
      const _nowPlayingToggle = document.getElementById('nowPlayingToggle');
      if (_nowPlayingToggle) _nowPlayingToggle.addEventListener('click', togglePause);

      const _playerClose = document.getElementById('playerClose');
      if (_playerClose) _playerClose.addEventListener('click', () => {
        if (currentAudio) {
          isSwitchingTracks = true;
          sendStreamEvent('END');
          stopProgressTracking();
          currentAudio.pause();
          currentAudio = null;
          isPlaying = false;
        }
        hideMiniPlayer();
        const fill = document.getElementById('nowPlayingProgressFill');
        const timeEl = document.getElementById('playerCurrentTime');
        if (fill) fill.style.width = '0%';
        if (timeEl) timeEl.textContent = '0:00';
      });

      const titleEl = document.getElementById('randomTitle');
      if (titleEl) {
        randomTitleDefault = titleEl.textContent || randomTitleDefault;
      }
      const subtitleEl = document.getElementById('randomSubtitle');
      if (subtitleEl) {
        randomSubtitleDefault = subtitleEl.textContent || randomSubtitleDefault;
      }
      // Make "Discover More" title clickable to refresh content
      const randomTitle = document.getElementById('randomTitle');
      if (randomTitle) {
        randomTitle.addEventListener('click', () => {
          loadRandom(true);
        });
      }

      // Delegated listener for artwork clicks in Discover More
      const randomContainer = document.getElementById('randomContainer');
      if (randomContainer) {
        randomContainer.addEventListener('click', (e) => {
          const artwork = e.target.closest('.random-artwork');
          if (!artwork) return;
          const card = artwork.closest('.random-card');
          if (!card) return;
          const recordId = card.dataset.recordId;
          if (!recordId) return;
          // Clicking the ▶ play-icon circle keeps the original play behaviour
          if (e.target.closest('.play-icon')) {
            playSong(recordId);
            return;
          }
          // Clicking anywhere else on the cover shows the artist prompt
          showArtistAlbumsPrompt(recordId);
        });
      }

      // Shuffle play button
      const genreShufflePlayBtn = document.getElementById('genreShufflePlayBtn');
      if (genreShufflePlayBtn) {
        genreShufflePlayBtn.addEventListener('click', () => {
          if (window.MADPlayer && typeof window.MADPlayer.toggleShufflePl === 'function') {
            window.MADPlayer.toggleShufflePl();
          }
        });
      }

      // Check if access token was already validated before DOMContentLoaded
      // This prevents a race condition where the token validation completes
      // before the event listener is set up
      console.log('[MADMusic] DOMContentLoaded - checking window.massAccessReady:', window.massAccessReady);
      if (window.massAccessReady) {
        console.log('[MADMusic] Access already ready (race condition avoided), loading content now...');
        loadInitialContent();
      } else {
        console.log('[MADMusic] Access not ready yet, waiting for mass:access-ready event...');
      }
    });

    // Load content when access token is ready
    console.log('[MADMusic] Registering mass:access-ready event listener');
    window.addEventListener('mass:access-ready', (e) => {
      console.log('[MADMusic] Access token ready event received, detail:', e.detail);
      loadInitialContent();
    });

    // ── New Releases ──────────────────────────────────────────────────────────
    async function loadNewReleases() {
      const section   = document.getElementById('newReleasesSection');
      const container = document.getElementById('newReleasesContainer');
      if (!section || !container) return;

      try {
        const url = `${API.newReleases}?limit=20&_t=${Date.now()}`;
        const response = await apiFetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        const allItems = data.items || [];

        // One card per album — first track encountered per album wins
        const seenAlbums = new Set();
        const items = allItems.filter(item => {
          const fields = item.fields || {};
          const album  = getAlbumField(fields);
          const artist = getArtistField(fields);
          // Use artist+album as key; fall back to recordId if both are generic
          const key = (album && album !== 'Unknown Album')
            ? `${artist}|${album}`
            : item.recordId;
          if (seenAlbums.has(key)) return false;
          seenAlbums.add(key);
          return true;
        });

        if (!items.length) {
          section.hidden = true;
          return;
        }

        container.innerHTML = items.map(item => {
          const fields     = item.fields || {};
          const artworkUrl = getArtworkUrl(fields);
          const title      = getTitleField(fields);
          const artist     = getArtistField(fields);
          const album      = getAlbumField(fields);
          const jukeboxUrl = `/classic?album=${encodeURIComponent(album)}&artist=${encodeURIComponent(artist)}`;

          storeItem(item.recordId, item);

          return `
            <div class="trending-card" data-record-id="${escapeHtml(item.recordId)}">
              <span class="nr-new-badge">New</span>
              <div class="trending-artwork" style="cursor:pointer" onclick="if(window.showView) window.showView('albums'); var s=document.getElementById('search'); if(s){s.value='${escapeHtml(album)}';} if(window.run) window.run('${escapeHtml(album)}');">
                ${artworkUrl
                  ? `<img src="${escapeHtml(artworkUrl)}" alt="${escapeHtml(title)}" onerror="this.closest('.trending-card').style.display='none'" />`
                  : '<div class="artwork-placeholder">♪</div>'
                }
                <div class="play-overlay"><div class="play-icon" style="font-size:20px">⊞</div></div>
              </div>
              <div class="trending-info">
                <div class="trending-title">${escapeHtml(title)}</div>
                <div class="trending-artist">${escapeHtml(artist)}</div>
                <div class="trending-meta">${escapeHtml(album)}</div>
                <div class="card-quick-actions">
                  <button class="track-action-btn card-playlist-btn" title="Add to playlist">+ Playlist</button>
                  <button class="track-action-btn card-library-btn" title="Save to library">♡ Save</button>
                </div>
              </div>
            </div>
          `;
        }).join('');

        setupCardQuickActions(container);
        section.hidden = false;
        console.log(`[NewReleases] Rendered ${items.length} items`);
      } catch (err) {
        console.warn('[NewReleases] Failed to load:', err);
        section.hidden = true;
      }
    }

  // ── Card quick-action buttons (+ Playlist / ♡ Save) ─────────────────────────
  // Builds the album + track objects needed by handleAddToPlaylist / library API
  function buildAlbumTrackFromItem(item) {
    const fields   = item.fields || {};
    const title    = getTitleField(fields);
    const artist   = getArtistField(fields);
    const album    = getAlbumField(fields);
    const artwork  = getArtworkUrl(fields) || '';
    const rawAudio = getFieldValue(fields, ['S3_URL', 'Tape Files::S3_URL', 'mp3', 'MP3',
                       'Tape Files::mp3', 'Tape Files::MP3']) || '';
    const audioUrl = getAudioUrl(fields, item.recordId) || '';

    return {
      album: { title: album, artist, artwork, picture: artwork },
      track: { recordId: item.recordId, name: title, artist, S3_URL: rawAudio, mp3: rawAudio, resolvedSrc: audioUrl },
      audioUrl
    };
  }

  // Single delegated handler — wired up once on each container after first render
  function setupCardQuickActions(container) {
    if (!container || container._cardActionsReady) return;
    container._cardActionsReady = true;

    container.addEventListener('click', async (e) => {
      const btn = e.target.closest('.card-playlist-btn, .card-library-btn');
      if (!btn) return;
      e.stopPropagation();

      const card     = btn.closest('[data-record-id]');
      const recordId = card && card.dataset.recordId;
      if (!recordId) return;

      const item = itemsStore.get(recordId);
      if (!item) return;

      const { album, track, audioUrl } = buildAlbumTrackFromItem(item);

      if (btn.classList.contains('card-playlist-btn')) {
        if (typeof window.handleAddToPlaylist === 'function') {
          window.handleAddToPlaylist(album, track, audioUrl);
        }
      } else {
        // ♡ Save / ♥ Saved toggle
        if (btn.dataset.libraryId) {
          const res = await fetch(`/api/library/songs/${btn.dataset.libraryId}`, { method: 'DELETE' });
          if ((await res.json()).ok) {
            btn.classList.remove('saved');
            delete btn.dataset.libraryId;
            btn.textContent = '♡ Save';
          }
        } else {
          const res = await fetch('/api/library/songs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              trackRecordId: track.recordId || '',
              name:          track.name     || 'Unknown Track',
              albumTitle:    album.title    || '',
              albumArtist:   album.artist   || '',
              trackArtist:   track.artist   || '',
              artwork:       album.artwork  || '',
              S3_URL:        track.S3_URL   || '',
              mp3:           track.mp3      || ''
            })
          });
          const data = await res.json();
          if (data.ok) {
            btn.classList.add('saved');
            btn.dataset.libraryId = data.song.id;
            btn.textContent = '♥ Saved';
          }
        }
      }
    });
  }

  // ---- PUBLIC API ----
  window.loadFeatured = loadFeatured;
  window.loadHighlights = loadHighlights;
  window.loadTrending = loadTrending;
  window.loadNewReleases = loadNewReleases;
  window.loadRandom = loadRandom;
  window.loadInitialContent = loadInitialContent;
  window.performSearch = performSearch;
  window.clearSearch = clearSearch;
  window.apiFetch = apiFetch;
  window.initDarkMode = initDarkMode;
  window.applyAfricanTheme = applyAfricanTheme;
  window.MADDiscovery = {
    loadFeatured,
    loadHighlights,
    loadTrending,
    loadNewReleases,
    loadRandom,
    loadInitialContent,
    performSearch,
    clearSearch
  };

  // Expose a stop hook so showView / player.js can stop discovery audio
  window._discoveryStopPlayback = function () {
    playGeneration++; // invalidate any stale event listeners from the last playSong call
    if (currentAudio) {
      isSwitchingTracks = true;
      currentAudio.pause();
      currentAudio = null;
      isPlaying = false;
    }
  };

  // Initialize on access ready event
  document.addEventListener('mass:access-ready', loadInitialContent);
})();
