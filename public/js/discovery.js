(function() {
  'use strict';

  // ---- DISCOVERY FUNCTIONS ----
// Access Token and Payment Handling
    const STORAGE_KEY = 'mass_access_token';
    let accessToken = localStorage.getItem(STORAGE_KEY);
    let selectedPlan = '7-day'; // Default plan (matches server PAYSTACK_PLANS keys)

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
        <div class="plan-option ${plan.id === selectedPlan ? 'selected' : ''}" data-plan="${plan.id}">
          <div class="plan-info">
            <div class="plan-name">${plan.label}</div>
            <div class="plan-duration">${plan.days} ${plan.days === 1 ? 'day' : 'days'} of unlimited streaming</div>
          </div>
          <div class="plan-price">${plan.display}</div>
        </div>
      `).join('');

      // Add click handlers
      document.querySelectorAll('.plan-option').forEach(option => {
        option.addEventListener('click', () => {
          document.querySelectorAll('.plan-option').forEach(o => o.classList.remove('selected'));
          option.classList.add('selected');
          selectedPlan = option.dataset.plan;
        });
      });
    }

    // Show payment modal if no token
    function checkAccessToken() {
      if (!accessToken) {
        document.getElementById('paymentOverlay').classList.remove('hidden');
      }
    }

    // Check for token in URL (from payment callback)
    function checkUrlForToken() {
      const urlParams = new URLSearchParams(window.location.search);
      const tokenFromUrl = urlParams.get('token');
      const paymentStatus = urlParams.get('payment');

      if (tokenFromUrl && paymentStatus === 'success') {
        console.log('[Payment] Token received from callback:', tokenFromUrl);
        // Store the token
        localStorage.setItem(STORAGE_KEY, tokenFromUrl);
        accessToken = tokenFromUrl;
        currentAccessToken = tokenFromUrl;

        // Clean up URL (remove token for security)
        const newUrl = window.location.pathname;
        window.history.replaceState({}, document.title, newUrl);

        // Reload to apply the token
        window.location.reload();
        return true;
      }
      return false;
    }

    // Toggle between purchase and token input
    document.addEventListener('DOMContentLoaded', () => {
      // Check for token in URL first
      if (checkUrlForToken()) {
        return; // Will reload with token
      }

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

      // Handle payment submission
      const paymentSubmitBtn = document.getElementById('paymentSubmit');
      if (paymentSubmitBtn) {
        paymentSubmitBtn.addEventListener('click', async () => {
        const email = document.getElementById('paymentEmail').value.trim();
        const errorEl = document.getElementById('paymentError');
        const submitBtn = document.getElementById('paymentSubmit');

        errorEl.textContent = '';

        if (!email || !email.includes('@')) {
          errorEl.textContent = 'Please enter a valid email address';
          return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Processing...';

        try {
          const res = await fetch('/api/payments/initialize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, plan: selectedPlan })
          });

          const data = await res.json();

          if (data.ok && data.authorization_url) {
            // Redirect to Paystack
            window.location.href = data.authorization_url;
          } else {
            errorEl.textContent = data.error || 'Failed to initialize payment';
            submitBtn.disabled = false;
            submitBtn.textContent = 'Continue to Payment';
          }
        } catch (err) {
          console.error('Payment initialization error:', err);
          errorEl.textContent = 'Network error. Please try again.';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Continue to Payment';
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

    const MAX_GENRE_SELECTION = 5;
    // How many genre cards we want to show in the grid
    const GENRE_RESULT_LIMIT = 20;

    // Fetch just enough for quick display - reduced from 10x to 2.5x for speed
    const GENRE_FETCH_LIMIT = GENRE_RESULT_LIMIT * 2.5;
    const TRENDING_RESULT_LIMIT = 5;
    const TRENDING_FETCH_LIMIT = 25; // Fetch more to ensure 5 valid after filtering
    const GENRE_TITLE = 'Discover by Genre';
    const GENRE_PREF_STORAGE_KEY = 'madmusic.genrePreferences';
    let selectedGenres = loadStoredGenrePreferences();

    function loadStoredGenrePreferences() {
      try {
        const raw = localStorage.getItem(GENRE_PREF_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const cleaned = parsed
          .map((value) => (typeof value === 'string' ? value.trim() : ''))
          .filter(Boolean);
        if (cleaned.length > MAX_GENRE_SELECTION) {
          return cleaned.slice(0, MAX_GENRE_SELECTION);
        }
        return cleaned;
      } catch (err) {
        console.warn('[MADMusic] Failed to load genre preferences', err);
        return [];
      }
    }

    function persistGenrePreferences(genres) {
      try {
        const payload = Array.isArray(genres) ? genres : [];
        localStorage.setItem(GENRE_PREF_STORAGE_KEY, JSON.stringify(payload));
      } catch (err) {
        console.warn('[MADMusic] Failed to save genre preferences', err);
      }
    }
    let randomItems = [];
    let currentGenreRequestId = 0;
    let genreFetchController = null;
    let randomTitleDefault = 'Discover More';
    let randomSubtitleDefault = 'Find more fascinating picks from our archive';
    let genreResultOffset = 0;
    let genreResultTotal = 0;
    const genreRetryButton = document.getElementById('genreRetryButton');

    const GENRE_OPTIONS = [
      "50's",
      "50s",
      "60's",
      "60s",
      "70's",
      "80'",
      "80's",
      "90's",
      "Adult Contemporary",
      "Adult Contemporary (Singer/Songwriter",
      "Adult Contemporary (Singer/Songwriter)",
      "African",
      "African Jazz",
      "Amapiano",
      "Afro Beat",
      "Afro Dancehall",
      "Afro Folk",
      "Afro Fusion",
      "Afro House",
      "Afro Jazz",
      "Afro Pop",
      "Afro Pop ",
      "Afro Rock",
      "Afro Soul",
      "Afro-folk",
      "Afro-fusion",
      "Afro-Pop",
      "Big Band",
      "Blues",
      "Children",
      "Childrens Music",
      "Chillout",
      "Choral",
      "Christian",
      "Christmas",
      "Classic Lounge",
      "Classic Rock",
      "Classic Soul",
      "Classical",
      "Comedy",
      "Cool Jazz",
      "Country",
      "Country (Contemporary)",
      "Country (Traditional)",
      "Country Rock",
      "Dance",
      "Devotional",
      "Disco",
      "Easy Listening",
      "Electro Pop",
      "Electronic",
      "Film Scores",
      "Folk",
      "Folk (Singer/Songwriter)",
      "Funk",
      "Funky House",
      "Gospel",
      "Gqom",
      "Hip Hop",
      "Hip-Hop",
      "Inspirational",
      "Instrumental",
      "Isichathamiya",
      "Jazz",
      "Jazz (Contemporary)",
      "Jazz (Traditional)",
      "Jazz Fusion",
      "Jewish",
      "Jive 80s",
      "Kids",
      "Kwaito",
      "Latin",
      "Latin Music",
      "Live",
      "Live Recordings",
      "Maskandi",
      "Modern Classical",
      "Motswako",
      "Music Feature Films",
      "Musicals",
      "Oldies",
      "Other",
      "Pop",
      "Pop (Singer/Songwriter)",
      "Pop Rock",
      "Prog Rock",
      "R & B/Soul",
      "Reggae",
      "RnB",
      "Rock",
      "Smooth Jazz",
      "Soul",
      "Soul-Jazz",
      "Soundtrack",
      "Soundtracks",
      "Spoken Word",
      "Swing Music",
      "Traditional",
      "Vocal",
      "Volksmusik",
      "World",
      "World Music"
    ];
    window.MAD_GENRE_OPTIONS = GENRE_OPTIONS.slice();

    function cleanGenreLabel(value) {
      if (typeof value !== 'string') return '';
      return value.replace(/\s+/g, ' ').trim();
    }

    function normalizeGenreLabel(value) {
      if (!value && value !== 0) return '';
      return value
        .toString()
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, '')
        .trim();
    }

    function setGenreFeedback(message = '') {
      const feedbackEl = document.getElementById('genreFeedback');
      if (feedbackEl) {
        feedbackEl.textContent = message;
      }
    }

    function resetGenreSelect() {
      const selectEl = document.getElementById('genreSelect');
      if (!selectEl) return;
      selectEl.value = '';
      selectEl.classList.remove('has-value');
      if (selectEl.options.length) {
        selectEl.selectedIndex = 0;
      }
    }

    function updateGenreTags() {
      const container = document.getElementById('genreTags');
      const clearBtn = document.getElementById('clearGenres');
      if (!container) return;

      container.innerHTML = '';

      if (!selectedGenres.length) {
        if (clearBtn) clearBtn.classList.remove('visible');
        return;
      }

      const fragment = document.createDocumentFragment();

      selectedGenres.forEach((genre) => {
        const tag = document.createElement('span');
        tag.className = 'genre-tag';

        const label = document.createElement('span');
        label.textContent = genre;

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'genre-tag-remove';
        removeBtn.setAttribute('aria-label', `Remove ${genre}`);
        removeBtn.textContent = '✕';
        removeBtn.addEventListener('click', () => {
          removeGenre(genre);
        });

        tag.appendChild(label);
        tag.appendChild(removeBtn);
        fragment.appendChild(tag);
      });

      container.appendChild(fragment);
      if (clearBtn) {
        clearBtn.classList.toggle('visible', selectedGenres.length > 0);
      }
    }

    function scrollToDiscoverSection() {
      const titleEl = document.getElementById('randomTitle');
      if (!titleEl) return;

      // Scroll to the discover section with smooth animation
      titleEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function handleGenreSelection(rawValue) {
      const label = cleanGenreLabel(rawValue);
      if (!label) {
        resetGenreSelect();
        return;
      }

      const normalized = normalizeGenreLabel(label);
      if (!normalized) {
        resetGenreSelect();
        return;
      }

      const alreadySelected = selectedGenres.some(
        (existing) => normalizeGenreLabel(existing) === normalized
      );
      if (alreadySelected) {
        setGenreFeedback(`${label} is already selected`);
        resetGenreSelect();
        return;
      }

      if (selectedGenres.length >= MAX_GENRE_SELECTION) {
        setGenreFeedback(`You can select up to ${MAX_GENRE_SELECTION} genres`);
        resetGenreSelect();
        return;
      }

      selectedGenres = [...selectedGenres, label];
      persistGenrePreferences(selectedGenres);
      resetGenrePagination();
      setGenreFeedback('');
      updateGenreTags();
      resetGenreSelect();

      // Scroll to discover section when genre is selected
      scrollToDiscoverSection();

      if (isSearching) {
        clearSearch();
      } else {
        syncGenreFilters();
      }
    }

    function removeGenre(label) {
      const normalized = normalizeGenreLabel(label);
      const nextGenres = selectedGenres.filter(
        (item) => normalizeGenreLabel(item) !== normalized
      );
      if (nextGenres.length === selectedGenres.length) return;
      selectedGenres = nextGenres;
      persistGenrePreferences(selectedGenres);
      resetGenrePagination();
      setGenreFeedback('');
      updateGenreTags();
      syncGenreFilters();
    }

    function clearSelectedGenres() {
      if (!selectedGenres.length) return;
      selectedGenres = [];
      persistGenrePreferences(selectedGenres);
      setGenreFeedback('');
      updateGenreTags();
      resetGenreSelect();
      resetGenrePagination();
      syncGenreFilters({ forceReloadRandom: true });
    }

    function resetGenrePagination() {
      genreResultOffset = 0;
      genreResultTotal = 0;
    }

    function updateGenreRetryButton() {
      if (!genreRetryButton) return;
      const hasGenres = selectedGenres.length > 0;
      const genreShufflePlayBtn = document.getElementById('genreShufflePlayBtn');

      // Always show shuffle play button
      if (genreShufflePlayBtn) genreShufflePlayBtn.hidden = false;

      if (!hasGenres) {
        genreRetryButton.hidden = true;
        genreRetryButton.disabled = false;
        genreRetryButton.textContent = 'Get More Songs';
        return;
      }
      genreRetryButton.hidden = false;

      const loading = Boolean(genreFetchController);
      genreRetryButton.disabled = loading;
      genreRetryButton.textContent = loading ? 'Searching…' : 'Get More Songs';
    }

    function setDiscoverTitle(isGenreMode) {
      const titleEl = document.getElementById('randomTitle');
      if (!titleEl) return;
      titleEl.textContent = isGenreMode ? GENRE_TITLE : randomTitleDefault;
    }

    function setDiscoverSubtitleDefault() {
      const subtitleEl = document.getElementById('randomSubtitle');
      if (subtitleEl) {
        subtitleEl.textContent = randomSubtitleDefault;
      }
    }

    function setGenreSubtitle(state, count = 0) {
      const subtitleEl = document.getElementById('randomSubtitle');
      if (!subtitleEl) return;
      const readableGenres = selectedGenres.join(', ');
      if (!readableGenres) {
        subtitleEl.textContent = randomSubtitleDefault;
        return;
      }
      if (state === 'loading') {
        subtitleEl.textContent = `Searching ${readableGenres}...`;
      } else if (state === 'error') {
        subtitleEl.textContent = `Could not load ${readableGenres}. Try again.`;
      } else if (state === 'empty') {
        subtitleEl.textContent = `No tracks found for ${readableGenres}`;
      } else {
        subtitleEl.textContent = `Showing ${count} track${count === 1 ? '' : 's'} for ${readableGenres}`;
      }
    }

    function syncGenreFilters(options = {}) {
      const { forceReloadRandom = false } = options;
      if (isSearching) return;
      updateGenreRetryButton();
      if (!selectedGenres.length) {
        if (genreFetchController) {
          genreFetchController.abort();
          genreFetchController = null;
        }
        resetGenrePagination();
        setDiscoverTitle(false);
        if (randomItems.length && !forceReloadRandom) {
          setDiscoverSubtitleDefault();
          renderRandom(randomItems);
        } else {
          loadRandom(true);
        }
        return;
      }
      loadGenreResults();
    }

    async function loadGenreResults() {
      if (!selectedGenres.length || isSearching) {
        return;
      }

      if (genreFetchController) {
        genreFetchController.abort();
      }

      setDiscoverTitle(true);
      setGenreSubtitle('loading');

      const container = document.getElementById('randomContainer');
      if (container) {
        container.innerHTML = `
          <div class="loading">
            <div class="spinner"></div>
            <p>Loading songs...</p>
          </div>
        `;
      }

      const params = new URLSearchParams();

      // Use random offset for variety when offset is 0 (initial load or after clearing genres)
      let effectiveOffset = genreResultOffset;
      if (effectiveOffset === 0) {
        // Random offset between 0 and 100 to get different results each time
        effectiveOffset = Math.floor(Math.random() * 100);
      }

      // Over-fetch so we can ensure 12 distinct albums after dedupe
      params.set('limit', String(GENRE_FETCH_LIMIT));
      params.set('offset', String(Math.max(0, effectiveOffset)));
      selectedGenres.forEach((genre) => {
        params.append('genre', genre);
      });

      const controller = new AbortController();
      genreFetchController = controller;
      const requestId = ++currentGenreRequestId;
      updateGenreRetryButton();

      try {
        const response = await apiFetch(`${API.search}?${params.toString()}`, { signal: controller.signal });
        const data = await response.json();
        if (requestId !== currentGenreRequestId) return;

        const items = Array.isArray(data.items) ? data.items : [];

        // Group results by album and only keep the first track per album
        const albums = groupByAlbum(items);
        const representativeTracks = albums
          .map((album) => album.tracks[0])
          .filter(Boolean);

        // Shuffle for additional randomness
        const shuffledTracks = shuffleArray(representativeTracks);
        const displayedTracks = shuffledTracks.slice(0, GENRE_RESULT_LIMIT);

        // Render all at once - faster with reduced fetch size
        renderRandom(displayedTracks);

        if (displayedTracks.length) {
          setGenreSubtitle('success', displayedTracks.length);
        } else {
          setGenreSubtitle('empty');
        }

        const parsedTotal = Number(data.total);
        genreResultTotal = Number.isFinite(parsedTotal) ? parsedTotal : representativeTracks.length;
        const rawReturned = Number.isFinite(Number(data.rawReturnedCount))
          ? Number(data.rawReturnedCount)
          : items.length;
        const responseOffset = Number.isFinite(Number(data.offset)) ? Number(data.offset) : 0;
        genreResultOffset = responseOffset + (rawReturned || 0);
        if (genreResultTotal && genreResultOffset >= genreResultTotal) {
          genreResultOffset = 0;
        }
      } catch (error) {
        if (requestId !== currentGenreRequestId) return;
        if (error?.name === 'AbortError') {
          return;
        }
        console.error('[Genre Filter] Failed to load:', error);
        if (container) {
          container.innerHTML = `
            <div class="empty-state">
              <div class="empty-state-icon">⚠️</div>
              <p>Failed to load genre results</p>
            </div>
          `;
        }
        setGenreSubtitle('error');
      } finally {
        if (requestId === currentGenreRequestId) {
          genreFetchController = null;
        }
        updateGenreRetryButton();
      }
    }

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

    // Fetch wrapper with access token (now handled by global fetch interceptor)
    async function apiFetch(url, options = {}) {
      // The global fetch interceptor already handles adding the access token header
      // and showing the overlay on 403 errors, so we just pass through to fetch
      return fetch(url, options);
    }

    function populateGenreDropdown(targetEl) {
      const selectEl = targetEl || document.getElementById('genreSelect');
      if (!selectEl) return;
      const seen = new Set();
      const fragment = document.createDocumentFragment();
      for (const rawGenre of GENRE_OPTIONS) {
        const label = cleanGenreLabel(rawGenre);
        const normalized = normalizeGenreLabel(label);
        if (!label || !normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        const option = document.createElement('option');
        option.value = label;
        option.textContent = label;
        fragment.appendChild(option);
      }
      selectEl.appendChild(fragment);
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

    // Update mini player UI
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
              <button class="card-play-btn" onclick="event.stopPropagation(); playSong('${escapeHtml(item.recordId)}')" title="Play"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>
              <a href="${escapeHtml(jukeboxUrl)}" class="card-album-btn" title="View album" onclick="event.stopPropagation()"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>
            </div>
            <div class="trending-info">
              <div class="trending-title">${escapeHtml(title)}</div>
              <div class="trending-artist">${escapeHtml(artist)}</div>
              <div class="trending-meta">${escapeHtml(meta || 'Now playing across MAD')}</div>
            </div>
            <button class="trending-play-btn" onclick="playSong('${escapeHtml(item.recordId)}')">▶</button>
            <a href="${escapeHtml(jukeboxUrl)}" class="trending-album-btn" title="View album in Jukebox">💿</a>
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
          <div class="random-artwork" onclick="playSong('${escapeHtml(item.recordId)}')">
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
          </div>
          <div class="random-actions">
            <a href="${escapeHtml(jukeboxUrl)}" class="random-album-btn" title="View album in Jukebox">💿 View Album</a>
          </div>
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

    // Start or stop shuffle play
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
            <div class="random-artwork" onclick="playSong('${escapeHtml(firstTrackId)}')">
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
          if (!selectedGenres.length && !isSearching) {
            setDiscoverTitle(false);
            setDiscoverSubtitleDefault();
            renderRandom(deduped);
          }
        } else {
          randomItems = [];
          if (!selectedGenres.length && !isSearching) {
            renderRandom([]);
          }
        }
      } catch (error) {
        console.error('[Random] Failed to load:', error);
        randomItems = [];
        if (!selectedGenres.length && !isSearching) {
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
        // Clear search - restore random/genre view
        isSearching = false;
        if (searchClearEl) searchClearEl.style.display = 'none';
        if (searchIcon) { searchIcon.classList.remove('loading'); searchIcon.textContent = '🔍'; }
        syncGenreFilters({ forceReloadRandom: selectedGenres.length === 0 });
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
      console.log('[MADMusic] About to call syncGenreFilters()');
      syncGenreFilters({ forceReloadRandom: true });
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

      populateGenreDropdown();
      const titleEl = document.getElementById('randomTitle');
      if (titleEl) {
        randomTitleDefault = titleEl.textContent || randomTitleDefault;
      }
      const subtitleEl = document.getElementById('randomSubtitle');
      if (subtitleEl) {
        randomSubtitleDefault = subtitleEl.textContent || randomSubtitleDefault;
      }
      setDiscoverTitle(false);
      setDiscoverSubtitleDefault();
      updateGenreTags();
      setGenreFeedback('');

      const genreSelect = document.getElementById('genreSelect');
      if (genreSelect) {
        genreSelect.addEventListener('change', (event) => {
          const selected = event.target.value;
          genreSelect.classList.toggle('has-value', selected !== '');
          handleGenreSelection(selected);
        });
      }

      const clearBtn = document.getElementById('clearGenres');
      if (clearBtn) {
        clearBtn.addEventListener('click', clearSelectedGenres);
      }

      if (genreRetryButton) {
        genreRetryButton.addEventListener('click', () => {
          if (genreRetryButton.disabled) return;
          if (!selectedGenres.length) {
            loadRandom(true);
            return;
          }
          loadGenreResults();
        });
      }

      // Make "Discover More" title clickable to refresh content
      const randomTitle = document.getElementById('randomTitle');
      if (randomTitle) {
        randomTitle.addEventListener('click', () => {
          if (!selectedGenres.length) {
            loadRandom(true);
          }
        });
      }

      const genreShufflePlayBtn = document.getElementById('genreShufflePlayBtn');
      if (genreShufflePlayBtn) {
        genreShufflePlayBtn.addEventListener('click', () => {
          toggleShufflePl();
        });
      }

      updateGenreRetryButton();

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
            <div class="trending-card">
              <span class="nr-new-badge">New</span>
              <div class="trending-artwork" onclick="playSong('${escapeHtml(item.recordId)}')">
                ${artworkUrl
                  ? `<img src="${escapeHtml(artworkUrl)}" alt="${escapeHtml(title)}" onerror="this.closest('.trending-card').style.display='none'" />`
                  : '<div class="artwork-placeholder">♪</div>'
                }
                <div class="play-overlay"><div class="play-icon">▶</div></div>
                <button class="card-play-btn" onclick="event.stopPropagation(); playSong('${escapeHtml(item.recordId)}')" title="Play"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>
                <a href="${escapeHtml(jukeboxUrl)}" class="card-album-btn" title="View album" onclick="event.stopPropagation()"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>
              </div>
              <div class="trending-info">
                <div class="trending-title">${escapeHtml(title)}</div>
                <div class="trending-artist">${escapeHtml(artist)}</div>
                <div class="trending-meta">${escapeHtml(album)}</div>
              </div>
            </div>
          `;
        }).join('');

        section.hidden = false;
        console.log(`[NewReleases] Rendered ${items.length} items`);
      } catch (err) {
        console.warn('[NewReleases] Failed to load:', err);
        section.hidden = true;
      }
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

  // Initialize on access ready event
  document.addEventListener('mass:access-ready', loadInitialContent);
})();
