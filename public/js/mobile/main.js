// Mobile app entry (ES module). Thin controller: imports the feature modules,
// holds the DOM event wiring + drag/search state + init(), and exposes the
// inline on*-handlers on window. All app logic lives in the mobile/*.js modules.

import { elements, state } from './state.js?v=5';
import { showToast } from './util.js?v=5';
import { getArtistField, getArtworkUrl, getAudioUrl, getTitleField, getYearField, hasValidArtwork } from './fields.js?v=5';
// auth.js is version-stamped: a fresh main.js importing a stale cached auth.js
// (missing the startTrial export) would break the whole module graph.
import { buyAccess, enterGuestMode, logout, setAccessToken, startTrial, updateAuthUI } from './auth.js?v=5';
import { switchTab } from './nav.js?v=5';
import { renderSearchResults, search } from './search.js?v=5';
import { createPlaylist, loadPlaylists, showAddToPlaylistModal } from './playlists.js?v=5';
import { loadDiscover, refreshDiscover, renderDiscoverTracks } from './rails-discover.js?v=5';
import { filterG100Albums, loadG100 } from './rails-g100.js?v=5';
import { loadNewReleases } from './rails-newreleases.js?v=5';
import { initMobHero } from './hero.js?v=5';
import { loadHomeShelves } from './rails-g100.js?v=5';
import { closeModal, playTrack, sendStreamEvent, stepQueue, updatePlayerModal, updateProgress } from './player.js?v=5';
import { showAlbumTracksModal } from './cards.js?v=5';
import { initRouter } from './router.js?v=5';
import { initMaddie } from './maddie.js?v=5';

// ===== Tab Navigation =====
    document.querySelectorAll('.tab-button').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        switchTab(tab);
      });
    });

    // Browse hub cards → the tab they name.
    document.querySelectorAll('.browse-card[data-goto]').forEach(card => {
      card.addEventListener('click', () => switchTab(card.dataset.goto));
    });

    // Back out of a Browse sub-tab.
    document.getElementById('browse-back')?.addEventListener('click', () => switchTab('browse'));

    // Account is no longer a bottom-bar item; the header badge opens it, which
    // is where people look for their account anyway.
    document.getElementById('user-badge')?.addEventListener('click', () => switchTab('profile'));

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
          initMobHero();
          loadHomeShelves();
          loadPlaylists();
          handleShareDeepLink();
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
          initMobHero();
          loadHomeShelves();
      loadPlaylists();
      handleShareDeepLink();
    }

    // A visitor arriving via a shared track link (/mobile?t=<recordId>) gets
    // that track's album opened in the bottom sheet. __SHARE_TRACK is injected
    // by the server (which already resolved the record for the OG tags), and
    // /api/album?cat= is public — works for guests and members alike.
    // GUESTS get the taster hero first — cover, title, one giant play button —
    // because the link that brought them promised "listen to this song".
    async function handleShareDeepLink() {
      const st = window.__SHARE_TRACK;
      if (!st || !st.catalogue) return;
      const campaign = ((new URLSearchParams(window.location.search)).get('utm_campaign') || 'share')
        .replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'share';
      // Clean the URL FIRST so the modal's history entry isn't clobbered.
      window.history.replaceState({}, document.title, window.location.pathname);

      if (window.__GUEST && st.recordId) {
        try { sessionStorage.setItem('mad_taster', JSON.stringify({ t: st.recordId, campaign })); } catch (e) {}
        try { window.umami && window.umami.track('taster-land', { t: st.recordId, campaign }); } catch (e) {}
        showTasterHero(st, campaign);
      }

      try {
        const r = await fetch(`/api/album?${new URLSearchParams({ cat: st.catalogue })}`);
        const d = await r.json();
        if (d.ok && d.items?.length) {
          showAlbumTracksModal({
            title: st.album || '',
            artist: st.albumArtist || st.artist || '',
            artwork: st.artworkUrl || '/img/placeholder.png',
            tracks: d.items
          });
        }
      } catch (err) {
        console.warn('[Share] deep link failed:', err);
      }
    }

    // Full-screen one-tap-play card for taster guests. Sits above the album
    // sheet (which loads behind it) and above the cookie banner.
    function showTasterHero(st, campaign) {
      const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const wrap = document.createElement('div');
      wrap.id = 'tasterHero';
      wrap.innerHTML =
        '<style>' +
        '#tasterHero{position:fixed;inset:0;z-index:12000;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(8,8,12,.95);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);}' +
        '#tasterHero .th-card{display:flex;flex-direction:column;align-items:center;gap:16px;padding:24px;max-width:360px;width:calc(100% - 40px);text-align:center;}' +
        '#tasterHero img{width:min(240px,64vw);aspect-ratio:1;object-fit:cover;border-radius:14px;box-shadow:0 16px 50px rgba(0,0,0,.6);}' +
        '#tasterHero .th-title{font-size:1.35rem;font-weight:800;color:#fff;line-height:1.2;}' +
        '#tasterHero .th-artist{font-size:1rem;color:#b9a7ff;font-weight:600;margin-top:-6px;}' +
        '#tasterHero .th-play{display:flex;align-items:center;gap:10px;border:0;cursor:pointer;border-radius:999px;' +
        'padding:15px 30px;font-size:1.1rem;font-weight:800;color:#fff;background:linear-gradient(135deg,#7c5cff,#a34bff);' +
        'box-shadow:0 10px 30px rgba(124,92,255,.45);}' +
        '#tasterHero .th-sub{font-size:.8rem;color:#9a96a8;}' +
        '#tasterHero .th-skip{background:none;border:0;color:#8f8a9e;font-size:.9rem;cursor:pointer;text-decoration:underline;padding:8px;}' +
        '</style>' +
        '<div class="th-card">' +
        (st.artworkUrl ? '<img alt="" src="' + esc(st.artworkUrl) + '">' : '') +
        '<div class="th-title">' + esc(st.title) + '</div>' +
        '<div class="th-artist">' + esc(st.artist || st.albumArtist || '') + '</div>' +
        '<button class="th-play" type="button"><svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg>Play the song</button>' +
        '<div class="th-sub">Free preview · full songs with a free 7-day trial</div>' +
        '<button class="th-skip" type="button">Just browsing? Explore the vault →</button>' +
        '</div>';
      document.body.appendChild(wrap);
      wrap.querySelector('.th-skip').addEventListener('click', () => wrap.remove());
      wrap.querySelector('.th-play').addEventListener('click', () => {
        playTrack({
          recordId: st.recordId,
          fields: {
            'Track Name': st.title || '',
            'Track Artist': st.artist || st.albumArtist || '',
            'Album Title': st.album || '',
            'Album Artist': st.albumArtist || '',
            'Artwork_S3_URL': st.artworkUrl || ''
          }
        });
        try { window.umami && window.umami.track('taster-play', { t: st.recordId, campaign }); } catch (e) {}
        try {
          fetch('/api/taster/event', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'play', t: st.recordId, campaign, mobile: true }),
            keepalive: true
          }).catch(() => {});
        } catch (e) {}
        wrap.remove();                       // album sheet is loaded behind
      });
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

    // Mini player bar: tap anywhere (except its two buttons) to open the full
    // player. The old draggable-bubble machinery is gone — the bar is fixed
    // above the tab bar so the playing area is always in the same place.
    elements.floatingPlayer.addEventListener('click', (e) => {
      if (e.target.closest('.mini-btn')) return;
      state.playerModal.visible = true;
      elements.playerModal.classList.add('show');
      updatePlayerModal();
    });

    document.getElementById('mini-play-pause').addEventListener('click', () => {
      if (elements.audio.paused) {
        elements.audio.play();
      } else {
        elements.audio.pause();
      }
    });

    document.getElementById('mini-next').addEventListener('click', () => stepQueue(1));

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
    document.getElementById('prev-btn').addEventListener('click', () => stepQueue(-1));
    document.getElementById('next-btn').addEventListener('click', () => stepQueue(1));

    // Auto-advance to next track on end (works for both album and playlist contexts)
    elements.audio.addEventListener('ended', () => {
      sendStreamEvent('END');
      stepQueue(1);
    });

    // Audio events
    elements.audio.addEventListener('play', () => {
      document.getElementById('play-pause-btn').textContent = '⏸';
      document.getElementById('mini-play-pause').textContent = '⏸';
      elements.floatingPlayer.classList.add('playing');
      sendStreamEvent('PLAY');
    });

    elements.audio.addEventListener('pause', () => {
      document.getElementById('play-pause-btn').textContent = '▶';
      document.getElementById('mini-play-pause').textContent = '▶';
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

    // Share the current track — native share sheet (Instagram/TikTok/WhatsApp
    // live there), copy-link fallback. The /?t= URL unfurls via server OG tags
    // and gives non-subscribers a 30 s guest preview.
    document.getElementById('share-track-btn')?.addEventListener('click', async () => {
      const track = state.currentTrack;
      if (!track?.recordId) { showToast('Nothing playing to share', 'error'); return; }
      const f = track.fields || {};
      const title = getTitleField(f) || 'A track';
      const artist = getArtistField(f) || '';
      const url = `${window.location.origin}/?t=${encodeURIComponent(track.recordId)}`;
      const text = `${title}${artist ? ` — ${artist}` : ''} on MAD Music`;
      if (navigator.share) {
        try { await navigator.share({ title, text, url }); return; }
        catch (err) { if (err?.name === 'AbortError') return; }
      }
      try {
        await navigator.clipboard.writeText(url);
        showToast('Link copied — paste it anywhere', 'success');
      } catch {
        prompt('Copy this link:', url);
      }
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

    // Maddie (shop assistant) — no-op unless window.__MADDIE
    initMaddie();

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
