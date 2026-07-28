// Album/track card builders + their modals for the mobile app.

import { elements, state } from './state.js';
import { escapeHtml, getArtistField, getArtworkUrl, getGenreField, getTitleField } from './fields.js';
import { switchTab } from './nav.js';
import { search } from './search.js';
import { closeModal, playTrack } from './player.js';
import { pushOverlay } from './router.js';

// ── Shared album tile (the New Releases / G100 look) ─────────────────────────
// One square-cover tile: first tap reveals the title/artist overlay, second tap
// opens the tracks modal (or a custom onOpen), the ▶ plays with the album as
// the queue (or a custom onPlay). Every album surface uses THIS so the app has
// one visual language — don't hand-roll new card markups.
let _tileDismissArmed = false;
function armTileOverlayDismiss() {
      if (_tileDismissArmed) return;
      _tileDismissArmed = true;
      // Dismiss open overlays when tapping OUTSIDE any tile. Must ignore taps
      // on tiles themselves: this runs in the capture phase (before the tile's
      // own handler), and the old version stripped overlay-active from the very
      // card being tapped — which silently broke second-tap-opens-tracks on
      // New Releases/G100 (every tap registered as a first tap).
      document.addEventListener('click', (e) => {
        if (e.target.closest && e.target.closest('.nr-album-card')) return;
        document.querySelectorAll('.nr-album-card.overlay-active').forEach(c => c.classList.remove('overlay-active'));
      }, { capture: true });
    }

export function createAlbumTile(album, opts = {}) {
      const { badge = '', badgeClass = 'nr-new-badge', playBtnStyle = '', countBadgeKey = null, onOpen = null, onPlay = null } = opts;
      armTileOverlayDismiss();

      const card = document.createElement('div');
      card.className = 'nr-album-card';

      const trackCount = album.tracks.length;
      const trackLabel = trackCount === 1 ? 'track' : 'tracks';
      const playSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;

      card.innerHTML = `
        <img class="nr-album-artwork" src="${escapeHtml(album.artwork)}" alt="${escapeHtml(album.title)}" loading="lazy" onerror="this.onerror=null;this.src='/img/placeholder.png'">
        ${badge ? `<span class="${badgeClass}">${escapeHtml(badge)}</span>` : ''}
        <div class="nr-card-overlay">
          <div class="nr-overlay-title">${escapeHtml(album.title)}</div>
          <div class="nr-overlay-artist">${escapeHtml(album.artist)}</div>
          <div class="nr-overlay-actions">
            <span class="nr-track-count"${countBadgeKey ? ` data-album-key="${escapeHtml(countBadgeKey)}"` : ''}><span class="nr-count-num">${trackCount}</span> ${trackLabel}</span>
            ${trackCount > 0 || onPlay ? `<button class="nr-play-btn"${playBtnStyle ? ` style="${playBtnStyle}"` : ''} title="Play">${playSVG}</button>` : ''}
          </div>
        </div>
      `;

      card.addEventListener('click', (e) => {
        if (e.target.closest('.nr-play-btn')) return;
        if (!card.classList.contains('overlay-active')) {
          document.querySelectorAll('.nr-album-card.overlay-active').forEach(c => c.classList.remove('overlay-active'));
          card.classList.add('overlay-active');
          e.stopPropagation();
        } else {
          (onOpen || showAlbumTracksModal)(album);
        }
      });

      const playBtn = card.querySelector('.nr-play-btn');
      if (playBtn) {
        playBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (onPlay) onPlay(album);
          else if (album.tracks.length > 0) {
            state.playlistContext = { tracks: album.tracks, currentIndex: 0, playFn: playTrack };
            playTrack(album.tracks[0]);
          }
          card.classList.remove('overlay-active');
        });
      }

      // Artist name in the open overlay → offer "all albums by this artist"
      // (carried over from the old Discover cards, now on every surface)
      card.querySelector('.nr-overlay-artist').addEventListener('click', (e) => {
        if (!album.artist || album.artist === 'My playlist') return;
        e.stopPropagation();
        showMobileArtistPrompt(album.artist);
      });

      return card;
    }

export function renderAlbumTileGrid(container, albums, optsFor = () => ({})) {
      const grid = document.createElement('div');
      grid.className = 'nr-album-grid';
      albums.forEach(album => grid.appendChild(createAlbumTile(album, optsFor(album))));
      container.appendChild(grid);
      return grid;
    }

export function showAlbumTracksModal(album) {
      elements.bottomSheet.innerHTML = `
        <div class="bottom-sheet-header">${escapeHtml(album.title)}</div>
        <p style="text-align: center; color: var(--text-secondary); margin-bottom: 16px;">${escapeHtml(album.artist)}</p>
        ${album.tracks.map((track, index) => {
          const fields = track.fields || {};
          const trackTitle = getTitleField(fields);
          return `
            <button class="bottom-sheet-option" data-track-index="${index}">
              ${escapeHtml(trackTitle)}
            </button>
          `;
        }).join('')}
        <button class="btn btn-secondary bs-close-btn" onclick="closeModal()">Close</button>
      `;

      elements.modalOverlay.classList.add('show');
      pushOverlay('album-tracks', album.recordId || album.title);

      elements.bottomSheet.querySelectorAll('[data-track-index]').forEach(btn => {
        btn.addEventListener('click', () => {
          const trackIndex = parseInt(btn.dataset.trackIndex);
          state.playlistContext = { tracks: album.tracks, currentIndex: trackIndex, playFn: playTrack };
          playTrack(album.tracks[trackIndex]);
          closeModal();
        });
      });

      // Append suggestions rail asynchronously — doesn't block the modal opening.
      if (window.__SUGGESTIONS !== false) {
        appendMobileSuggestions(elements.bottomSheet, album);
      }
    }

async function appendMobileSuggestions(sheet, album) {
  const closeBtn = sheet.querySelector('.bs-close-btn');
  if (!closeBtn) return;

  // Placeholder shown immediately; replaced with cards or removed on completion.
  const rail = document.createElement('div');
  rail.className = 'mob-suggestions';
  rail.innerHTML = `<div class="mob-suggestions-title">You might also like</div>
    <div class="mob-suggestions-scroll"><div class="mob-suggestions-loading">Loading…</div></div>`;
  sheet.insertBefore(rail, closeBtn);

  try {
    const params = new URLSearchParams({ title: album.title, artist: album.artist, limit: 6 });
    const res = await fetch(`/api/suggestions?${params}`);
    const data = await res.json();

    // Rail may have been removed by a new modal tap — bail if stale.
    if (!rail.isConnected) return;

    // Defensive: drop sleeveless suggestions (placeholder art reads as broken).
    // The backend already excludes cover-less albums; this guards a stale index.
    const sugItems = (data.items || []).filter(item => item.artworkSrc);
    if (!data.ok || !sugItems.length) { rail.remove(); return; }

    const scroll = rail.querySelector('.mob-suggestions-scroll');
    scroll.innerHTML = sugItems.map(item => `
      <button class="mob-sug-card" data-title="${escapeHtml(item.album)}" data-artist="${escapeHtml(item.artist)}">
        <img class="mob-sug-art" src="${escapeHtml(item.artworkSrc || '/img/placeholder.png')}"
             alt="${escapeHtml(item.album)}" loading="lazy" onerror="this.src='/img/placeholder.png'">
        <div class="mob-sug-name">${escapeHtml(item.album)}</div>
        <div class="mob-sug-artist">${escapeHtml(item.artist)}</div>
      </button>
    `).join('');

    scroll.querySelectorAll('.mob-sug-card').forEach(btn => {
      btn.addEventListener('click', async () => {
        const title = btn.dataset.title;
        const artist = btn.dataset.artist;
        const cacheKey = `${title}|||${artist}`.toLowerCase();
        const cached = state.discoverAlbumCache.get(cacheKey);
        if (cached) { showAlbumTracksModal(cached); return; }

        btn.disabled = true;
        try {
          const r = await fetch(`/api/album?${new URLSearchParams({ title, artist })}`);
          const d = await r.json();
          if (d.ok && d.items?.length) {
            const sugAlbum = { title, artist, artwork: btn.querySelector('img').src, tracks: d.items };
            state.discoverAlbumCache.set(cacheKey, sugAlbum);
            showAlbumTracksModal(sugAlbum);
          }
        } finally {
          btn.disabled = false;
        }
      });
    });
  } catch {
    if (rail.isConnected) rail.remove();
  }
}

export function showMobileArtistPrompt(artistName) {
      document.getElementById('mobileArtistPrompt')?.remove();

      const overlay = document.createElement('div');
      overlay.id = 'mobileArtistPrompt';
      overlay.className = 'mobile-artist-prompt-overlay';
      overlay.innerHTML = `
        <div class="mobile-artist-prompt-box">
          <p class="mobile-artist-prompt-q">See all albums by</p>
          <p class="mobile-artist-prompt-name">${escapeHtml(artistName)}</p>
          <div class="mobile-artist-prompt-actions">
            <button class="mobile-artist-prompt-btn mobile-artist-yes">Yes, search</button>
            <button class="mobile-artist-prompt-btn mobile-artist-no">Dismiss</button>
          </div>
        </div>
      `;
      overlay.querySelector('.mobile-artist-yes').addEventListener('click', () => {
        overlay.remove();
        // Switch to search tab and pre-fill with artist name
        const searchInput = document.getElementById('search-input');
        if (searchInput) searchInput.value = artistName;
        switchTab('search');
        if (typeof search === 'function') search(artistName);
      });
      overlay.querySelector('.mobile-artist-no').addEventListener('click', () => overlay.remove());
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      document.body.appendChild(overlay);
    }
