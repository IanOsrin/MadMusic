// Home rail: G100 albums + curated playlists (mobile).

import { elements, state } from './state.js?v=14';
import { escapeHtml, getAlbumArtist, getAlbumField, getArtworkUrl, hasValidAudio } from './fields.js?v=14';
import { showAlbumTracksModal, renderAlbumTileGrid } from './cards.js?v=14';
import { closeModal, playTrack } from './player.js?v=14';
import { pushOverlay } from './router.js?v=14';
import { loadArtistBioMobile } from './search.js?v=14';

// "MAD-About-Oliver-Mtukudzi" → "Oliver Mtukudzi"; '' for non-MAD-About names.
function artistFromMadAbout(name) {
  const m = String(name || '').match(/^\s*MAD[\s-]*About[\s-]+(.+)$/i);
  return m ? m[1].replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

export async function loadG100(forceRefresh = false) {
      const container = elements.g100Content;
      const btn = document.getElementById('g100-refresh-btn');
      if (btn) btn.classList.add('spinning');

      container.innerHTML = `
        <div class="nr-album-grid">
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
        </div>`;

      try {
        const res  = await fetch('/api/g100-albums');
        const data = await res.json();
        const items = data.items || [];

        if (!items.length) {
          container.innerHTML = `<div class="empty-state"><div class="empty-icon">🏆</div><p>No G100 albums found</p></div>`;
          state.g100Loaded = true;
          return;
        }

        // Deduplicate by album+artist, then group into album objects
        const seen = new Set();
        const albumMap = new Map();

        items.forEach(item => {
          const fields = item.fields || {};
          const albumTitle = getAlbumField(fields);
          const artist     = getAlbumArtist(fields);
          const artwork    = getArtworkUrl(fields);
          const key        = `${albumTitle}|||${artist}`.toLowerCase();

          if (!albumMap.has(key)) {
            albumMap.set(key, { title: albumTitle, artist, artwork, tracks: [] });
          }
          // Only add track if it has valid audio
          if (hasValidAudio(item)) {
            albumMap.get(key).tracks.push(item);
          }
        });

        // Album running order — the feed arrives sorted by relevance, not position.
        albumMap.forEach(a => window.MADHelpers.sortTracksBySeq(a.tracks));

        state.g100Albums = [...albumMap.values()].filter(a => a.tracks.length > 0 || a.artwork !== '/img/placeholder.png');
        state.g100Loaded = true;
        renderG100Albums('');
      } catch (err) {
        console.error('[G100] Failed to load albums', err);
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>Failed to load G100 albums</p></div>`;
      } finally {
        if (btn) btn.classList.remove('spinning');
      }
    }

export function filterG100Albums(query) {
      renderG100Albums(query);
    }

export function renderG100Albums(filter = '') {
      const container = elements.g100Content;
      const q = (filter || '').toLowerCase().trim();
      const albums = q
        ? state.g100Albums.filter(a => a.title.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q))
        : state.g100Albums;

      if (!albums.length) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><p>No albums match "${escapeHtml(filter)}"</p></div>`;
        return;
      }

      container.innerHTML = '';
      renderAlbumTileGrid(container, albums, () => ({
        badge: 'G100',
        badgeClass: 'g100-badge',
        playBtnStyle: 'background:var(--g100-gold);'
      }));
    }

// The rail a playlist appears on is decided by its FM Category, so the same
// loader serves every rail and a playlist can never land on two of them.
// Mirrors the desktop loader in app.html — keep the two in step.
export async function loadG100Playlists() {
      await loadPlaylistRail('Artist', elements.g100PlaylistsContent);
      state.g100PlaylistsLoaded = true;
    }

export async function loadScenes() {
      await loadPlaylistRail('Theme', elements.scenesContent);
      state.scenesLoaded = true;
    }

// Front-page shelves (client 2026-08-26): the same two playlist rails,
// loaded into the Home tab's containers. Browse's own copies still lazy-load
// on first visit; the endpoint is SWR-cached server-side, so the doubled
// fetch is cheap.
export async function loadHomeShelves() {
      await Promise.all([
        loadPlaylistRail('Artist', document.getElementById('home-madabout-content')),
        loadPlaylistRail('Theme', document.getElementById('home-themes-content')),
      ]);
    }

async function loadPlaylistRail(category, container) {
      if (!container) return;
      try {
        const res  = await fetch(`/api/public-playlists?category=${encodeURIComponent(category)}`);
        const data = await res.json();
        const playlists = data.playlists || [];

        if (!playlists.length) {
          container.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><p>No playlists available</p></div>`;
          return;
        }

        if (category === 'Artist') state.g100Playlists = playlists;
        renderG100Playlists(playlists, container);
      } catch (err) {
        console.error(`[G100 Playlists:${category}] Failed to load`, err);
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>Failed to load playlists</p></div>`;
      }
    }

export function renderG100Playlists(playlists, target) {
      const container = target || elements.g100PlaylistsContent;
      const grid = document.createElement('div');
      grid.className = 'g100-playlist-grid';

      playlists.forEach((pl, i) => {
        // Display name only — FM names carry a "MAD-About-" prefix and dashes
        // ("MAD-About-Ladysmith-Black-Mambazo"); the card reads better as
        // "Ladysmith Black Mambazo". Clicks still use the REAL pl.name.
        const displayName = pl.name.replace(/^MAD[- ]About[- ]/i, '').replace(/-/g, ' ');
        const hue  = (i * 47 + 210) % 360;
        const card = document.createElement('div');
        card.className = 'g100-playlist-card';
        card.style.setProperty('--pl-hue', hue);

        card.innerHTML = `
          <div class="g100-playlist-art">
            ${pl.imageUrl
              ? `<img src="${escapeHtml(pl.imageUrl)}" alt="${escapeHtml(pl.name)}" loading="lazy">`
              : `<svg viewBox="0 0 24 24" fill="currentColor" width="40" height="40" style="opacity:0.6;"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>`
            }
          </div>
          <div class="g100-playlist-info">
            <div class="g100-playlist-name">${escapeHtml(displayName)}</div>
            <div class="g100-playlist-count">${pl.trackCount} track${pl.trackCount !== 1 ? 's' : ''}</div>
          </div>
        `;

        card.addEventListener('click', () => showG100PlaylistTracks(pl.name));
        grid.appendChild(card);
      });

      container.innerHTML = '';
      container.appendChild(grid);
    }

export async function showG100PlaylistTracks(playlistName) {
      // Show loading state in bottom sheet immediately
      elements.bottomSheet.innerHTML = `
        <div class="bottom-sheet-header">${escapeHtml(playlistName)}</div>
        <div class="empty-state"><div class="empty-icon">⏳</div><p>Loading tracks…</p></div>
        <button class="btn btn-secondary" style="width:100%;margin-top:16px;" onclick="closeModal()">Close</button>
      `;
      elements.modalOverlay.classList.add('show');
      pushOverlay('g100-playlist', playlistName);

      try {
        const res  = await fetch(`/api/public-playlists?name=${encodeURIComponent(playlistName)}`);
        const data = await res.json();

        if (!data.ok || !data.tracks?.length) {
          elements.bottomSheet.innerHTML = `
            <div class="bottom-sheet-header">${escapeHtml(playlistName)}</div>
            <div class="empty-state"><div class="empty-icon">🎵</div><p>No tracks in this playlist</p></div>
            <button class="btn btn-secondary" style="width:100%;margin-top:16px;" onclick="closeModal()">Close</button>
          `;
          return;
        }

        // Normalise track shape to what playTrack expects
        const tracks = data.tracks.map(t => ({
          fields: {
            'Track Name':   t.name        || '',
            'Album Artist': t.trackArtist || t.albumArtist || '',
            'Album Title':  t.albumTitle  || '',
            'S3_URL':       t.resolvedSrc || t.mp3 || '',
            'Artwork::Picture': t.artwork || t.picture || '',
          }
        }));

        elements.bottomSheet.innerHTML = `
          <div class="bottom-sheet-header">${escapeHtml(playlistName)}</div>
          <div class="mobile-artist-bio" hidden></div>
          <p style="text-align:center;color:var(--text-secondary);margin-bottom:16px;">${tracks.length} track${tracks.length !== 1 ? 's' : ''}</p>
          ${tracks.map((t, idx) => {
            const fields = t.fields;
            return `<button class="bottom-sheet-option" data-idx="${idx}">${escapeHtml(fields['Track Name'] || 'Unknown Track')}<span style="display:block;font-size:11px;color:var(--text-muted);margin-top:2px;">${escapeHtml(fields['Album Artist'] || '')}</span></button>`;
          }).join('')}
          <button class="btn btn-secondary" style="width:100%;margin-top:16px;" onclick="closeModal()">Close</button>
        `;

        // Artist biography for MAD-About-<artist> playlists — only where a bio
        // matches (loadArtistBioMobile leaves the box hidden otherwise).
        const bioArtist = artistFromMadAbout(playlistName);
        const bioBox = elements.bottomSheet.querySelector('.mobile-artist-bio');
        if (bioArtist && bioBox && window.__ARTIST_BIO !== false) loadArtistBioMobile(bioArtist, bioBox);

        elements.bottomSheet.querySelectorAll('[data-idx]').forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx);
            state.playlistContext = { tracks, currentIndex: idx, name: playlistName, playFn: playTrack };
            playTrack(tracks[idx]);
            closeModal();
          });
        });
      } catch (err) {
        console.error('[G100 Playlist] Failed to load tracks', err);
        elements.bottomSheet.innerHTML = `
          <div class="bottom-sheet-header">${escapeHtml(playlistName)}</div>
          <div class="empty-state"><div class="empty-icon">⚠️</div><p>Failed to load tracks</p></div>
          <button class="btn btn-secondary" style="width:100%;margin-top:16px;" onclick="closeModal()">Close</button>
        `;
      }
    }
