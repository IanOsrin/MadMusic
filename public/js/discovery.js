(function() {
  'use strict';

  // Shared utilities — single source of truth in helpers.js (window.MADHelpers).
  // Aliased so existing call sites keep working; do NOT redefine these below.
  const { getFieldValue, getArtworkUrl, getTitleField, getAlbumField, escapeHtml, formatRelativeTime, formatTrendingMeta, toSeconds, groupByAlbum, shuffleArray, getGenreField, hasValidAudio, getArtistField, getAlbumArtist, getAudioUrl } = window.MADHelpers;


  // ---- DISCOVERY FUNCTIONS ----

  // In-memory trending cache — persists for the lifetime of the page session.
  // Prevents re-fetching the same 24h-server-cached data on every view switch.
  let _trendingItems   = null;
  let _trendingFetched = false;
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
          <div class="plan-price" data-zar-cents="${plan.amount}" data-zar-display="${plan.display}">${plan.display}</div>
        </div>
      `).join('');

      // Inject local-currency hints once geolocation + exchange rate are ready
      if (window.MADCurrency) {
        window.MADCurrency.ready.then(() => window.MADCurrency.updatePlanPrices());
      }

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

    // Show payment modal if no token. In guest preview mode the overlay is
    // owned by auth.js (dismissible popup on a 5-minute timer) — this boot-time
    // wall must NOT fire, or guests get gated the moment plans finish loading.
    function checkAccessToken() {
      if (window.__GUEST) return;
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
      globalFavorites: '/api/global-favorites',
      search: '/api/search',
      container: '/api/container'
    };

    const TRENDING_RESULT_LIMIT = 10;
    const TRENDING_FETCH_LIMIT = 40; // Fetch more to ensure 10 valid after filtering
    let randomItems = [];
    let randomTitleDefault = 'Listen to Songs';
    let randomSubtitleDefault = "Spin the wheel. Every spin's a different trip through the archive.";

    // Global storage for items (so we can reference them by ID in onclick handlers)
    const itemsStore = new Map();

    // Helper: write to both local store and player.js's shared store
    function storeItem(recordId, item) {
      itemsStore.set(recordId, item);
      if (window.itemsStore && window.itemsStore !== itemsStore) {
        window.itemsStore.set(recordId, item);
      }
    }

    // NOTE: Discovery no longer runs its own playback engine. All playback is
    // owned by player.js (window.playSong / window.stopPlayback), which writes to
    // the shared <audio id="player"> via _PLAYER. Discovery only renders rails and
    // delegates play actions. The former engine + stream-event state lived here.

    // Fetch wrapper with access token (now handled by global fetch interceptor)
    async function apiFetch(url, options = {}) {
      // The global fetch interceptor already handles adding the access token header
      // and showing the overlay on 403 errors, so we just pass through to fetch
      return fetch(url, options);
    }

    // Stream Event Tracking Functions
    // Helper functions
    // Check if an item has valid audio
    // Escape HTML to prevent XSS attacks
    // Group tracks by album
    // ---- Artist albums prompt ----
    function navigateToArtistAlbums(artist) {
      if (window.showView) window.showView('albums');
      const searchEl     = document.getElementById('search');
      const searchArtist = document.getElementById('searchArtist');
      const searchAlbum  = document.getElementById('searchAlbum');
      const searchTrack  = document.getElementById('searchTrack');
      const searchFields = document.getElementById('searchFields');
      const goBtn        = document.getElementById('go');
      if (searchEl)     searchEl.value     = '';   // unified box blank => clean artist search
      if (searchArtist) searchArtist.value = artist;
      if (searchAlbum)  searchAlbum.value  = '';
      if (searchTrack)  searchTrack.value  = '';
      if (searchFields) searchFields.hidden = false;
      if (goBtn)        goBtn.click();
    }

    function showArtistAlbumsPrompt(recordId) {
      const item = itemsStore.get(recordId);
      if (!item) { window.playSong(recordId); return; }
      const fields = item.fields || {};
      const artist = getArtistField(fields);
      if (!artist) { window.playSong(recordId); return; }

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
    // Hide mini player
    // Update visual state to highlight currently playing card
    // Check if a card is currently displayed in any section
    // Play function with actual audio playback
    // Pause/Resume function
    // Stop function
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
              : ''
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
                : ''
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
            <div class="trending-artwork" style="cursor:pointer" data-album-view data-album="${escapeHtml(album)}" data-artist="${escapeHtml(artist)}">
              ${artworkUrl
                ? `<img src="${escapeHtml(artworkUrl)}" alt="${escapeHtml(title)}" onerror="this.closest('.trending-card').style.display='none'" />`
                : ''
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
            <button class="card-album-btn" title="View album" data-album-view data-album="${escapeHtml(album)}" data-artist="${escapeHtml(artist)}"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg></button>
          </div>
        `;
      }).join('');

      setupAlbumViewDelegation(container);
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
              : ''
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
          <button class="card-album-btn" title="View album" data-album-search data-album="${escapeHtml(album)}"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg></button>
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
      setupAlbumViewDelegation(container);
    }

    // Shuffle array utility
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
      setupAlbumViewDelegation(container);
    }

    // Render albums (grouped by album)
    /* The two-pane "search environment" (renderSearchEnv/cueTrack/playCued)
       was removed: it belonged to the orphaned discovery search engine whose
       UI (#searchInput in #view-highlights) was unreachable. Live search is
       the doSearch override in app.html. */

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
            <div class="random-artwork" style="cursor:pointer" data-album-view data-album="${escapeHtml(album)}" data-artist="${escapeHtml(artist)}">
              ${artwork
                ? `<img src="${escapeHtml(artwork)}" alt="${escapeHtml(album)}" onerror="this.closest('.random-card').style.display='none'" />`
                : ''
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

      setupAlbumViewDelegation(container);
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
      if (!container) return;

      // Serve from in-memory cache on repeat calls (e.g. switching views)
      if (_trendingFetched && _trendingItems) {
        renderTrending(_trendingItems);
        return;
      }

      try {
        // No _t= cache-buster — the server caches trending for 24 h already
        const url = `${API.trending}?limit=${TRENDING_FETCH_LIMIT}`;
        const response = await apiFetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const items = Array.isArray(data?.items) ? data.items : [];
        _trendingItems   = items;
        _trendingFetched = true;
        renderTrending(items);
      } catch (error) {
        console.error('[Trending] Failed to load:', error);
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
          renderRandom(deduped);
        } else {
          randomItems = [];
          renderRandom([]);
        }
      } catch (error) {
        console.error('[Random] Failed to load:', error);
        randomItems = [];
        document.getElementById('randomContainer').innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">⚠️</div>
            <p>Failed to load songs</p>
          </div>
        `;
      }
    }

    /* The discovery search engine (performSearch/clearSearch/detectArtistMatch
       + #searchInput listeners) was removed as orphaned dead code. The
       artist-match -> artist-view behaviour lives in the doSearch override
       in app.html. */

    // (beforeunload END handling now lives in player.js, the single playback engine.)

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
      loadGlobalFavorites();
      console.log('[MADMusic] About to call loadTrending()');
      loadTrending();
      console.log('[MADMusic] About to call loadRandom()');
      loadRandom(true);
      console.log('[MADMusic] Initial content load calls completed');
    }

    // Dark mode is owned by the app.html IIFE ('mass.darkMode' key, the
    // #darkModeToggle pill + Settings checkbox). The "Modern Dark Mode"
    // system that lived here (key 'madmusic.darkMode', emoji icons,
    // auto-hide-on-mousemove) was removed 2026-06-12: it double-bound the
    // toggle button and re-applied its own preference AFTER app.html's init,
    // stomping the user's choice on every load. Don't reintroduce theme
    // logic in this file.

    // Initialize
    document.addEventListener('DOMContentLoaded', () => {
      // Don't load content yet - wait for access token to be ready

      // (Dark mode toggle setup removed — owned by app.html; see note above.)

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

      // (Mini-player controls removed — those elements don't exist in app.html;
      //  the unified player owns playback UI. Playback is player.js's.)

      const titleEl = document.getElementById('randomTitle');
      if (titleEl) {
        randomTitleDefault = titleEl.textContent || randomTitleDefault;
      }
      const subtitleEl = document.getElementById('randomSubtitle');
      if (subtitleEl) {
        randomSubtitleDefault = subtitleEl.textContent || randomSubtitleDefault;
      }
      // Make "Listen to Songs" title clickable to refresh content
      const randomTitle = document.getElementById('randomTitle');
      if (randomTitle) {
        randomTitle.addEventListener('click', () => {
          const wheel = document.getElementById('wheelIcon');
          if (wheel) {
            wheel.classList.remove('spinning');
            void wheel.offsetWidth;
            wheel.classList.add('spinning');
            wheel.addEventListener('animationend', () => wheel.classList.remove('spinning'), { once: true });
          }
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
            window.playSong(recordId);
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
    // Shared album-rail loader — New Releases and Global Favorites render the
    // same card markup from the same response shape; only the section ids,
    // endpoint and optional badge differ.
    async function loadAlbumRail({ sectionId, containerId, url, badgeHtml = '', logLabel }) {
      const section   = document.getElementById(sectionId);
      const container = document.getElementById(containerId);
      if (!section || !container) return;

      try {
        const response = await apiFetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        const allItems = data.items || [];

        // One card per album — first track encountered per album wins
        const seenAlbums = new Set();
        const items = allItems.filter(item => {
          const fields = item.fields || {};
          const album  = getAlbumField(fields);
          // Album-first artist (NOT getArtistField, which is track-first): a
          // compilation has one album artist but many track artists, so a
          // track-first key would let the same album through once per track.
          const artist = getAlbumArtist(fields);
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
              ${badgeHtml}
              <div class="trending-artwork" style="cursor:pointer" data-album-view data-album="${escapeHtml(album)}" data-artist="${escapeHtml(artist)}">
                ${artworkUrl
                  ? `<img src="${escapeHtml(artworkUrl)}" alt="${escapeHtml(title)}" onerror="this.closest('.trending-card').style.display='none'" />`
                  : ''
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
        setupAlbumViewDelegation(container);
        section.hidden = false;
        console.log(`[${logLabel}] Rendered ${items.length} items`);
      } catch (err) {
        console.warn(`[${logLabel}] Failed to load:`, err);
        section.hidden = true;
      }
    }

    function loadNewReleases() {
      return loadAlbumRail({
        sectionId:   'newReleasesSection',
        containerId: 'newReleasesContainer',
        url:         `${API.newReleases}?limit=20&_t=${Date.now()}`,
        badgeHtml:   '<span class="nr-new-badge">New</span>',
        logLabel:    'NewReleases'
      });
    }

    function loadGlobalFavorites() {
      return loadAlbumRail({
        sectionId:   'globalFavoritesSection',
        containerId: 'globalFavoritesContainer',
        url:         `${API.globalFavorites}?limit=20&_t=${Date.now()}`,
        logLabel:    'GlobalFavorites'
      });
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
  // Delegated handler for "view album" / "search album" affordances on cards.
  // Replaces inline onclick="...('${album}','${artist}')" handlers: escapeHtml is
  // the wrong escaping for a JS-string-inside-an-attribute (the browser decodes
  // entities back to raw quotes before the JS parser runs, so an album titled
  // ');alert(1)// breaks out). We carry the values in escaped data-* attributes
  // and read them back as plain strings here, so no JS-string parsing happens.
  function setupAlbumViewDelegation(container) {
    if (!container || container._albumViewReady) return;
    container._albumViewReady = true;

    container.addEventListener('click', (e) => {
      // "Run a search for this album" affordance (random cards)
      const searchEl = e.target.closest('[data-album-search]');
      if (searchEl && container.contains(searchEl)) {
        const album = searchEl.dataset.album || '';
        if (window.showView) window.showView('albums');
        const s = document.getElementById('search');
        if (s) s.value = album;
        if (window.run) window.run(album);
        return;
      }

      // "Open this album directly" affordance (trending / album / new-release cards)
      const viewEl = e.target.closest('[data-album-view]');
      if (viewEl && container.contains(viewEl)) {
        const album  = viewEl.dataset.album  || '';
        const artist = viewEl.dataset.artist || '';
        if (window.openAlbumDirect) window.openAlbumDirect(album, artist);
      }
    });
  }

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
  window.apiFetch = apiFetch;
  // NOTE: initDarkMode/applyDarkMode exports removed with the duplicate
  // "Modern Dark Mode" system (2026-06-12) — dark mode is owned by app.html.
  // applyAfricanTheme is intentionally not exported either — it lives inside
  // the African-theme IIFE (DOMContentLoaded) and is fully self-contained.
  // A previous module-scope export of a non-existent binding threw a
  // ReferenceError that aborted everything below this line — don't repeat it.
  window.MADDiscovery = {
    loadFeatured,
    loadHighlights,
    loadTrending,
    loadNewReleases,
    loadRandom,
    loadInitialContent
  };

  // Stop hook kept for callers (showView etc.); playback is owned by player.js,
  // so delegate to its single engine. (Discovery no longer runs its own.)
  window._discoveryStopPlayback = function () {
    if (typeof window.stopPlayback === 'function') window.stopPlayback();
  };

  // NOTE: no listener here — 'mass:access-ready' is dispatched on window
  // (auth.js) and discovery already listens on window above (with a
  // massAccessReady race-guard). A document-level listener would never fire.
})();
