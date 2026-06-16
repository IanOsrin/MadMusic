// Album/track card builders + their modals for the mobile app.

import { elements, state } from './state.js';
import { escapeHtml, getArtistField, getArtworkUrl, getGenreField, getTitleField } from './fields.js';
import { switchTab } from './nav.js';
import { search } from './search.js';
import { closeModal, playTrack } from './player.js';

export function createAlbumCard(album) {
      const card = document.createElement('div');
      card.className = 'track-card';

      const trackCount = album.tracks.length;
      const trackLabel = trackCount === 1 ? 'track' : 'tracks';

      card.innerHTML = `
        <img class="track-artwork" src="${escapeHtml(album.artwork)}" alt="${escapeHtml(album.title)}" loading="lazy" onerror="this.src='/img/placeholder.png'">
        <div class="track-info">
          <div class="track-title">${escapeHtml(album.title)}</div>
          <div class="track-artist">${escapeHtml(album.artist)} • ${trackCount} ${trackLabel}</div>
        </div>
        <div class="track-actions">
          <button class="btn-icon view-btn">📋</button>
          <button class="btn-icon play-btn">▶</button>
        </div>
      `;

      card.querySelector('.play-btn').addEventListener('click', () => {
        if (album.tracks.length > 0) {
          state.playlistContext = { tracks: album.tracks, currentIndex: 0, playFn: playTrack };
          playTrack(album.tracks[0]);
        }
      });

      card.querySelector('.view-btn').addEventListener('click', () => showAlbumTracksModal(album));

      return card;
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

    if (!data.ok || !data.items?.length) { rail.remove(); return; }

    const scroll = rail.querySelector('.mob-suggestions-scroll');
    scroll.innerHTML = data.items.map(item => `
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

export function createDiscoverTrackCard(track, albumCtx) {
      const card = document.createElement('div');
      card.className = 'track-card';

      const fields    = track.fields || {};
      const artwork   = getArtworkUrl(fields);
      const title     = getTitleField(fields);
      const artist    = getArtistField(fields);
      const genre     = getGenreField(fields);
      // Discover returns one track per album — show placeholder count until prefetch completes
      const initCount = albumCtx ? albumCtx.tracks.length : 1;
      const albumKey  = albumCtx
        ? `${albumCtx.title}|||${albumCtx.artist}`.toLowerCase()
        : null;

      // Disc SVG (concentric circles — matches desktop card-album-btn)
      const discSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>`;

      card.innerHTML = `
        <img class="track-artwork" src="${escapeHtml(artwork)}" alt="${escapeHtml(title)}" loading="lazy" onerror="this.src='/img/placeholder.png'">
        <div class="track-info">
          <div class="track-title">${escapeHtml(title)}</div>
          <div class="track-artist">${escapeHtml(artist)}</div>
          ${genre ? `<span class="track-genre-tag">${escapeHtml(genre)}</span>` : ''}
        </div>
        <div class="track-actions">
          <button class="album-count-btn" data-album-key="${escapeHtml(albumKey || '')}" title="View full album">${discSVG}<span class="album-badge-count">…</span></button>
          <button class="btn-icon play-btn" title="Play">▶</button>
        </div>
      `;

      // Album badge → fetch full album (or use cache) then open modal
      card.querySelector('.album-count-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!albumCtx) return;
        const btn = e.currentTarget;

        // Use already-fetched data if available
        const cached = state.discoverAlbumCache.get(albumKey);
        if (cached) { showAlbumTracksModal(cached); return; }

        // First tap: fetch now (prefetch may not have reached this one yet)
        btn.disabled = true;
        btn.querySelector('.album-badge-count').textContent = '…';
        try {
          const params = new URLSearchParams({ title: albumCtx.title, artist: albumCtx.artist });
          const res  = await fetch(`/api/album?${params}`);
          const data = await res.json();
          if (data.ok && data.items?.length) {
            const fullAlbum = { ...albumCtx, tracks: data.items };
            state.discoverAlbumCache.set(albumKey, fullAlbum);
            btn.querySelector('.album-badge-count').textContent = data.items.length;
            showAlbumTracksModal(fullAlbum);
          } else {
            showAlbumTracksModal(albumCtx); // fallback to what we have
          }
        } catch {
          showAlbumTracksModal(albumCtx);
        } finally {
          btn.disabled = false;
        }
      });

      // Play → set the whole Discover feed as the queue so now-playing prev/next
      // move through the feed (each card is one album's representative track).
      card.querySelector('.play-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const feed = state.discoverFeed || [];
        const idx = feed.findIndex(t => (t.recordId || t) === (track.recordId || track));
        state.playlistContext = {
          tracks: feed.length ? feed : [track],
          currentIndex: idx >= 0 ? idx : 0,
          playFn: playTrack
        };
        playTrack(track);
      });

      // Artwork tap → ask if user wants all albums by this artist
      card.querySelector('.track-artwork').addEventListener('click', (e) => {
        e.stopPropagation();
        if (!artist) return;
        showMobileArtistPrompt(artist);
      });

      return card;
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
