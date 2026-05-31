// Home rail: G100 albums + curated playlists (mobile).

import { elements, state } from './state.js';
import { getAlbumArtist, getAlbumField, getArtworkUrl, hasValidAudio } from './fields.js';
import { showAlbumTracksModal } from './cards.js';
import { closeModal, playTrack } from './player.js';

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
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><p>No albums match "${filter}"</p></div>`;
        return;
      }

      const grid = document.createElement('div');
      grid.className = 'nr-album-grid';

      albums.forEach(album => {
        const card = document.createElement('div');
        card.className = 'nr-album-card';

        const trackCount = album.tracks.length;
        const trackLabel = trackCount === 1 ? 'track' : 'tracks';
        const playSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;

        card.innerHTML = `
          <img class="nr-album-artwork" src="${album.artwork}" alt="${album.title}" loading="lazy" onerror="this.src='/img/placeholder.png'">
          <span class="g100-badge">G100</span>
          <div class="nr-card-overlay">
            <div class="nr-overlay-title">${album.title}</div>
            <div class="nr-overlay-artist">${album.artist}</div>
            <div class="nr-overlay-actions">
              <span class="nr-track-count">${trackCount} ${trackLabel}</span>
              ${trackCount > 0 ? `<button class="nr-play-btn" style="background:var(--g100-gold);" title="Play">${playSVG}</button>` : ''}
            </div>
          </div>
        `;

        card.addEventListener('click', (e) => {
          if (e.target.closest('.nr-play-btn')) return;
          if (!card.classList.contains('overlay-active')) {
            document.querySelectorAll('.nr-album-card.overlay-active').forEach(c => c.classList.remove('overlay-active'));
            card.classList.add('overlay-active');
            e.stopPropagation();
          } else if (album.tracks.length > 0) {
            showAlbumTracksModal(album);
          }
        });

        const playBtn = card.querySelector('.nr-play-btn');
        if (playBtn) {
          playBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            state.playlistContext = { tracks: album.tracks, currentIndex: 0, playFn: playTrack };
            playTrack(album.tracks[0]);
            card.classList.remove('overlay-active');
          });
        }

        grid.appendChild(card);
      });

      container.innerHTML = '';
      container.appendChild(grid);
    }

export async function loadG100Playlists() {
      const container = elements.g100PlaylistsContent;
      try {
        const res  = await fetch('/api/public-playlists');
        const data = await res.json();
        const playlists = data.playlists || [];

        if (!playlists.length) {
          container.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><p>No playlists available</p></div>`;
          state.g100PlaylistsLoaded = true;
          return;
        }

        state.g100Playlists = playlists;
        state.g100PlaylistsLoaded = true;
        renderG100Playlists(playlists);
      } catch (err) {
        console.error('[G100 Playlists] Failed to load', err);
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>Failed to load playlists</p></div>`;
      }
    }

export function renderG100Playlists(playlists) {
      const container = elements.g100PlaylistsContent;
      const grid = document.createElement('div');
      grid.className = 'g100-playlist-grid';

      playlists.forEach((pl, i) => {
        const hue  = (i * 47 + 210) % 360;
        const card = document.createElement('div');
        card.className = 'g100-playlist-card';
        card.style.setProperty('--pl-hue', hue);

        card.innerHTML = `
          <div class="g100-playlist-art">
            ${pl.imageUrl
              ? `<img src="${pl.imageUrl}" alt="${pl.name}" loading="lazy">`
              : `<svg viewBox="0 0 24 24" fill="currentColor" width="40" height="40" style="opacity:0.6;"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>`
            }
          </div>
          <div class="g100-playlist-info">
            <div class="g100-playlist-name">${pl.name}</div>
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
        <div class="bottom-sheet-header">${playlistName}</div>
        <div class="empty-state"><div class="empty-icon">⏳</div><p>Loading tracks…</p></div>
        <button class="btn btn-secondary" style="width:100%;margin-top:16px;" onclick="closeModal()">Close</button>
      `;
      elements.modalOverlay.classList.add('show');

      try {
        const res  = await fetch(`/api/public-playlists?name=${encodeURIComponent(playlistName)}`);
        const data = await res.json();

        if (!data.ok || !data.tracks?.length) {
          elements.bottomSheet.innerHTML = `
            <div class="bottom-sheet-header">${playlistName}</div>
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
          <div class="bottom-sheet-header">${playlistName}</div>
          <p style="text-align:center;color:var(--text-secondary);margin-bottom:16px;">${tracks.length} track${tracks.length !== 1 ? 's' : ''}</p>
          ${tracks.map((t, idx) => {
            const fields = t.fields;
            return `<button class="bottom-sheet-option" data-idx="${idx}">${fields['Track Name'] || 'Unknown Track'}<span style="display:block;font-size:11px;color:var(--text-muted);margin-top:2px;">${fields['Album Artist'] || ''}</span></button>`;
          }).join('')}
          <button class="btn btn-secondary" style="width:100%;margin-top:16px;" onclick="closeModal()">Close</button>
        `;

        elements.bottomSheet.querySelectorAll('[data-idx]').forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx);
            state.playlistContext = { tracks, currentIndex: idx, playFn: playTrack };
            playTrack(tracks[idx]);
            closeModal();
          });
        });
      } catch (err) {
        console.error('[G100 Playlist] Failed to load tracks', err);
        elements.bottomSheet.innerHTML = `
          <div class="bottom-sheet-header">${playlistName}</div>
          <div class="empty-state"><div class="empty-icon">⚠️</div><p>Failed to load tracks</p></div>
          <button class="btn btn-secondary" style="width:100%;margin-top:16px;" onclick="closeModal()">Close</button>
        `;
      }
    }
