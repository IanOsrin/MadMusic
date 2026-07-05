// Mobile app entry (ES module). Thin controller: imports the feature modules,
// holds the DOM event wiring + drag/search state + init(), and exposes the
// inline on*-handlers on window. All app logic lives in the mobile/*.js modules.

import { elements, state } from './state.js';
import { showToast } from './util.js';
import { getArtworkUrl, getAudioUrl, getYearField, hasValidArtwork } from './fields.js';
// auth.js is version-stamped: a fresh main.js importing a stale cached auth.js
// (missing the startTrial export) would break the whole module graph.
import { buyAccess, enterGuestMode, logout, setAccessToken, startTrial, updateAuthUI } from './auth.js?v=3';
import { switchTab } from './nav.js';
import { renderSearchResults, search } from './search.js';
import { createPlaylist, loadPlaylists, showAddToPlaylistModal } from './playlists.js';
import { loadDiscover, refreshDiscover, renderDiscoverTracks } from './rails-discover.js';
import { filterG100Albums, loadG100 } from './rails-g100.js';
import { loadNewReleases } from './rails-newreleases.js';
import { closeModal, playTrack, sendStreamEvent, updatePlayerModal, updateProgress } from './player.js';
import { initRouter } from './router.js';

// ===== Tab Navigation =====
    document.querySelectorAll('.tab-button').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        switchTab(tab);
      });
    });

    // ===== Genres =====

    // Clear filter functions (make them global for onclick handlers)

    // ===== Access Token Authentication =====

    // Profile tab event listeners
    document.getElementById('trial-btn').addEventListener('click', () => startTrial());
    document.getElementById('change-token-btn').addEventListener('click', () => setAccessToken());
    document.getElementById('buy-access-btn').addEventListener('click', () => buyAccess());
    document.getElementById('logout-btn').addEventListener('click', logout);

    // ===== Initialize =====
    async function init() {
      // Check URL for payment result first (redirect back from Paystack)
      const urlParams = new URLSearchParams(window.location.search);
      const paymentStatus = urlParams.get('payment');
      const paymentToken = urlParams.get('token');

      if (paymentStatus === 'success' && paymentToken) {
        console.log('[Mobile] Payment success, saving token:', paymentToken);
        localStorage.setItem('mass_access_token', paymentToken.trim().toUpperCase());
        // Clean URL then reload so the app starts a fresh session with the new token
        window.history.replaceState({}, document.title, window.location.pathname);
        showToast('Payment successful! Access activated.', 'success');
        setTimeout(() => window.location.reload(), 1500);
        return;
      } else if (paymentStatus === 'failed' || paymentStatus === 'error') {
        window.history.replaceState({}, document.title, window.location.pathname);
        showToast('Payment was not completed. Please try again.', 'error');
      } else if (paymentToken && !paymentStatus) {
        // Token passed directly from main app — save it silently
        console.log('[Mobile] Token passed from main app, saving');
        localStorage.setItem('mass_access_token', paymentToken.trim().toUpperCase());
        window.history.replaceState({}, document.title, window.location.pathname);
      }

      // Check token exists locally — no server round-trip (avoids session conflict)
      const accessToken = localStorage.getItem('mass_access_token');
      if (!accessToken) {
        // Guest preview mode: browse freely with 30 s previews + a dismissible
        // paywall every 5 minutes instead of the blocking key screen.
        if (window.__GUEST_PREVIEW === true) {
          enterGuestMode();
          loadNewReleases();
          loadPlaylists();
          return;
        }
        elements.newReleasesContent.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">🔑</div>
            <p style="margin-bottom: 8px;"><strong>Access Token Required</strong></p>
            <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 16px;">You need an access token to use MASS Mobile</p>
            <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 8px;">New to MAD Music? Try free for 7 days — no payment required.</p>
            <button class="btn btn-primary" onclick="startTrial()" style="margin-bottom: 8px;">Start 7-Day Free Trial</button>
            <button class="btn btn-secondary" onclick="setAccessToken()" style="margin-bottom: 8px;">Enter Access Token</button>
            <button class="btn btn-secondary" onclick="buyAccess()">Buy Access</button>
          </div>
        `;
        updateAuthUI();
        return;
      }

      // Token present — load app; server validates on each protected API call
      state.currentUser = { email: localStorage.getItem('mass_token_email') || '' };
      updateAuthUI();
      loadNewReleases();
      loadPlaylists();
    }

    // Function to set access token

    // Function to buy access via Paystack

    // ===== Discovery =====

    // ── Background album prefetch — fills badge counts after discover renders ─

    // Field/format helpers delegate to the single canonical source in helpers.js
    // (window.MADHelpers). Kept as thin wrappers so mobile's many call sites are
    // unchanged. getArtworkUrl/getAudioUrl/getYearField/hasValidArtwork stay local
    // because they have mobile-specific behaviour (placeholder, raw-value for the
    // playTrack proxy, year/artwork rules).

    // ── Discover individual track card with album badge ───────────────────────
    // albumCtx is the album object built in renderDiscoverTracks:
    //   { title, artist, artwork, tracks[] }

    // ===== Search =====
    let searchTimeout;
    elements.searchInput.addEventListener('input', (e) => {
      const query = e.target.value.trim();
      if (!query) {
        elements.searchResults.innerHTML = '';
        return;
      }

      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => search(query), 500);
    });

    // ===== Playlists =====

    // Adapt a stored playlist track into the format playTrack() expects.
    // Saved playlist tracks store ABSOLUTE FileMaker streaming URLs that expire
    // (RCType=RCFileProcessor → 401), which left the now-playing artwork blank
    // and audio broken. Re-resolve fresh audio + artwork by recordId; the stored
    // URLs are only a fallback if the lookup fails.

    document.getElementById('create-playlist-btn').addEventListener('click', () => {
      if (!state.currentUser) {
        showToast('Please log in to create playlists', 'error');
        switchTab('profile');
        return;
      }

      const name = prompt('Playlist name:');
      if (name) {
        createPlaylist(name);
      }
    });

    elements.modalOverlay.addEventListener('click', (e) => {
      if (e.target === elements.modalOverlay) {
        closeModal();
      }
    });

    // ===== Audio Playback =====

    // Set an artwork <img> src with a placeholder fallback if it fails to load
    // (e.g. a track with no real cover — a malformed/empty S3 artwork URL).

    // Floating player drag functionality
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragStartTime = 0;

    elements.floatingPlayer.addEventListener('touchstart', (e) => {
      isDragging = false;
      const touch = e.touches[0];
      dragStartX = touch.clientX;
      dragStartY = touch.clientY;
      dragStartTime = Date.now();
      elements.floatingPlayer.style.transition = 'none';
    });

    elements.floatingPlayer.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      const deltaX = Math.abs(touch.clientX - dragStartX);
      const deltaY = Math.abs(touch.clientY - dragStartY);

      // If moved more than 10px, it's a drag
      if (deltaX > 10 || deltaY > 10) {
        isDragging = true;
      }

      if (isDragging) {
        const newX = touch.clientX - 30; // Center of bubble
        const newY = touch.clientY - 30;

        // Constrain to viewport
        const maxX = window.innerWidth - 60;
        const maxY = window.innerHeight - 60 - 64; // Minus tab bar

        const constrainedX = Math.max(0, Math.min(newX, maxX));
        const constrainedY = Math.max(0, Math.min(newY, maxY));

        elements.floatingPlayer.style.left = `${constrainedX}px`;
        elements.floatingPlayer.style.top = `${constrainedY}px`;
        elements.floatingPlayer.style.right = 'auto';
        elements.floatingPlayer.style.bottom = 'auto';
      }
    });

    elements.floatingPlayer.addEventListener('touchend', (e) => {
      const touch = e.changedTouches[0];
      const deltaTime = Date.now() - dragStartTime;

      elements.floatingPlayer.style.transition = 'all 0.3s ease';

      if (isDragging) {
        // Snap to nearest corner
        const centerX = window.innerWidth / 2;
        const centerY = (window.innerHeight - 64) / 2;

        const currentLeft = parseInt(elements.floatingPlayer.style.left || 0);
        const currentTop = parseInt(elements.floatingPlayer.style.top || 0);

        const snapLeft = currentLeft < centerX ? '20px' : 'auto';
        const snapRight = currentLeft >= centerX ? '20px' : 'auto';
        const snapTop = currentTop < centerY ? '20px' : 'auto';
        const snapBottom = currentTop >= centerY ? `calc(${64}px + 20px + env(safe-area-inset-bottom))` : 'auto';

        elements.floatingPlayer.style.left = snapLeft;
        elements.floatingPlayer.style.right = snapRight;
        elements.floatingPlayer.style.top = snapTop;
        elements.floatingPlayer.style.bottom = snapBottom;
      } else {
        // It's a tap — let the click handler open the modal to avoid double-fire
      }

      isDragging = false;
    });

    // Open player modal on click (covers desktop and browsers where touchend alone is unreliable)
    elements.floatingPlayer.addEventListener('click', () => {
      state.playerModal.visible = true;
      elements.playerModal.classList.add('show');
      updatePlayerModal();
    });

    // Close player modal
    document.getElementById('player-close').addEventListener('click', () => {
      state.playerModal.visible = false;
      elements.playerModal.classList.remove('show');
    });

    // Play/pause
    document.getElementById('play-pause-btn').addEventListener('click', () => {
      if (elements.audio.paused) {
        elements.audio.play();
      } else {
        elements.audio.pause();
      }
    });

    // Prev / Next — step through playlist context if active
    document.getElementById('prev-btn').addEventListener('click', () => {
      const ctx = state.playlistContext;
      if (!ctx || !ctx.tracks || ctx.tracks.length === 0) return;
      const newIdx = Math.max(0, ctx.currentIndex - 1);
      if (newIdx !== ctx.currentIndex) {
        ctx.currentIndex = newIdx;
        (ctx.playFn || playTrack)(ctx.tracks[newIdx]);
      }
    });

    document.getElementById('next-btn').addEventListener('click', () => {
      const ctx = state.playlistContext;
      if (!ctx || !ctx.tracks || ctx.tracks.length === 0) return;
      const newIdx = Math.min(ctx.tracks.length - 1, ctx.currentIndex + 1);
      if (newIdx !== ctx.currentIndex) {
        ctx.currentIndex = newIdx;
        (ctx.playFn || playTrack)(ctx.tracks[newIdx]);
      }
    });

    // Auto-advance to next track on end (works for both album and playlist contexts)
    elements.audio.addEventListener('ended', () => {
      sendStreamEvent('END');
      const ctx = state.playlistContext;
      if (ctx && ctx.tracks && ctx.currentIndex < ctx.tracks.length - 1) {
        ctx.currentIndex += 1;
        (ctx.playFn || playTrack)(ctx.tracks[ctx.currentIndex]);
      }
    });

    // Audio events
    elements.audio.addEventListener('play', () => {
      document.getElementById('play-pause-btn').textContent = '⏸';
      elements.floatingPlayer.classList.add('playing');
      sendStreamEvent('PLAY');
    });

    elements.audio.addEventListener('pause', () => {
      document.getElementById('play-pause-btn').textContent = '▶';
      elements.floatingPlayer.classList.remove('playing');
      sendStreamEvent('PAUSE');
    });

    elements.audio.addEventListener('timeupdate', () => {
      // Guest preview: hard client stop at 30 s (the server already caps the
      // stream bytes at ~30 s — this just makes the ending clean + nudges).
      if (window.__GUEST && elements.audio.currentTime >= 30 && !elements.audio.paused) {
        elements.audio.pause();
        showToast('Preview ended — subscribe to hear the full track', 'success');
      }
      updateProgress();

      const now = Date.now();
      if (now - state.lastProgressUpdate > 30000) {
        sendStreamEvent('PROGRESS');
        state.lastProgressUpdate = now;
      }
    });

    elements.audio.addEventListener('error', () => {
      sendStreamEvent('ERROR');
      showToast('Playback error', 'error');
    });

    // Progress bar seek
    document.getElementById('progress-bar').addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percent = x / rect.width;
      elements.audio.currentTime = elements.audio.duration * percent;
    });

    // Stream events

    // Add to playlist from player
    document.getElementById('add-to-playlist-btn').addEventListener('click', () => {
      if (state.currentTrack) {
        showAddToPlaylistModal(state.currentTrack);
      }
    });

    // Start app
    init();

    // Wire browser Back/Forward history (after init's synchronous payment-URL cleanup,
    // so the seed re-stamps the real starting tab).
    initRouter();

    // Decade filtering functionality
    (function() {
      const discoverDecadeDropdown = document.getElementById('mobile-discover-decade');
      const searchDecadeDropdown = document.getElementById('mobile-search-decade');

      async function loadDecadeInDiscover(startYear) {
        try {
          const discoverContent = document.getElementById('discover-content');
          discoverContent.innerHTML = '<div class="skeleton-card skeleton"></div><div class="skeleton-card skeleton"></div>';

          const params = new URLSearchParams({
            start: startYear,
            end: startYear + 9,
            limit: 300
          });

          console.log('[Decade Discover] Loading:', startYear + 's');
          const response = await fetch(`/api/explore?${params}`);
          const data = await response.json();
          console.log('[Decade Discover] Results:', data.total || 0, 'tracks found');

          state.randomTracks = data.items || [];
          renderDiscoverTracks();
        } catch (err) {
          console.error('[Decade Discover] Failed:', err);
          const discoverContent = document.getElementById('discover-content');
          discoverContent.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><p>Failed to load decade</p></div>';
        }
      }

      async function loadDecadeInSearch(startYear) {
        try {
          const searchResults = document.getElementById('search-results');
          searchResults.innerHTML = '<div class="skeleton-card skeleton"></div><div class="skeleton-card skeleton"></div>';

          const params = new URLSearchParams({
            start: startYear,
            end: startYear + 9,
            limit: 300
          });

          console.log('[Decade Search] Loading:', startYear + 's');
          const response = await fetch(`/api/explore?${params}`);
          const data = await response.json();
          console.log('[Decade Search] Results:', data.total || 0, 'tracks found');

          state.searchResults = data.items || [];
          renderSearchResults();
        } catch (err) {
          console.error('[Decade Search] Failed:', err);
          const searchResults = document.getElementById('search-results');
          searchResults.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><p>Failed to load decade</p></div>';
        }
      }

      if (discoverDecadeDropdown) {
        discoverDecadeDropdown.addEventListener('change', function() {
          const selectedValue = discoverDecadeDropdown.value;
          if (!selectedValue) {
            loadDiscover(); // Reload default discover content
            return;
          }

          const match = selectedValue.match(/^(\d{4})s$/);
          if (match) {
            const startYear = parseInt(match[1], 10);
            loadDecadeInDiscover(startYear);
          }
        });
      }

      if (searchDecadeDropdown) {
        searchDecadeDropdown.addEventListener('change', function() {
          const selectedValue = searchDecadeDropdown.value;
          if (!selectedValue) {
            return;
          }

          const match = selectedValue.match(/^(\d{4})s$/);
          if (match) {
            const startYear = parseInt(match[1], 10);
            loadDecadeInSearch(startYear);
          }
        });
      }
    })();

    // ===== Inline-handler exposure (module scope has no implicit globals) =====
    // mobile.html markup and dynamically-built template strings call these by name
    // via on*="…" attributes. As a module, top-level `function` declarations are NOT
    // attached to window, so without this the corresponding buttons silently no-op.
    // (clear*Filter / selectGenre already self-assign to window above.)
    Object.assign(window, {
      loadNewReleases, loadG100, filterG100Albums, refreshDiscover,
      buyAccess, setAccessToken, startTrial, closeModal,
    });
