// Home rail: New Releases (mobile).

import { elements, state } from './state.js';
import { escapeHtml, getAlbumArtist, getAlbumField, getArtworkUrl, getTitleField, hasValidArtwork, hasValidAudio } from './fields.js';
import { showAlbumTracksModal } from './cards.js';
import { playTrack } from './player.js';

export async function loadNewReleases(forceRefresh = false) {
      const container = elements.newReleasesContent;
      const btn = document.getElementById('nr-refresh-btn');
      if (btn) btn.classList.add('spinning');

      container.innerHTML = `
        <div class="nr-album-grid">
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
          <div class="skeleton-card skeleton" style="aspect-ratio:1;height:auto;border-radius:14px;margin:0;"></div>
        </div>`;

      try {
        const url = '/api/new-releases?limit=60' + (forceRefresh ? '&refresh=1' : '');
        const response = await fetch(url);
        const data = await response.json();

        if (!data.ok || !data.items?.length) {
          container.innerHTML = `<div class="empty-state"><div class="empty-icon">🎵</div><p>No new releases right now — check back soon!</p></div>`;
          state.newReleasesLoaded = true;
          return;
        }

        // Group tracks into albums (same logic as discover)
        const validTracks = data.items.filter(item => hasValidAudio(item) && hasValidArtwork(item));
        state.newReleaseTracks = validTracks;
        state.newReleasesLoaded = true;
        renderNewReleases();
      } catch (err) {
        console.error('[New Releases] Failed to load', err);
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>Failed to load new releases</p></div>`;
      } finally {
        if (btn) btn.classList.remove('spinning');
      }
    }

export function renderNewReleases() {
      const container = elements.newReleasesContent;
      const tracks = state.newReleaseTracks;

      if (!tracks.length) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">🎵</div><p>No new releases available</p></div>`;
        return;
      }

      // Group by album
      const albumMap = new Map();
      tracks.forEach(track => {
        const fields = track.fields || track.fieldData || {};
        const albumTitle = getAlbumField(fields) || getTitleField(fields) || 'Unknown Album';
        const artist    = getAlbumArtist(fields);
        const artwork   = getArtworkUrl(fields);
        const key       = `${albumTitle}|||${artist}`.toLowerCase();

        if (!albumMap.has(key)) {
          albumMap.set(key, { title: albumTitle, artist, artwork, tracks: [] });
        }
        albumMap.get(key).tracks.push(track);
      });

      const albums = [...albumMap.values()];
      const grid = document.createElement('div');
      grid.className = 'nr-album-grid';

      // Dismiss any open overlay when tapping outside
      document.addEventListener('click', () => {
        document.querySelectorAll('.nr-album-card.overlay-active').forEach(c => c.classList.remove('overlay-active'));
      }, { capture: true, once: false });

      albums.forEach(album => {
        const card = document.createElement('div');
        card.className = 'nr-album-card';

        const trackCount = album.tracks.length;
        const trackLabel = trackCount === 1 ? 'track' : 'tracks';
        const playSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;

        card.innerHTML = `
          <img class="nr-album-artwork" src="${escapeHtml(album.artwork)}" alt="${escapeHtml(album.title)}" loading="lazy" onerror="this.src='/img/placeholder.png'">
          <span class="nr-new-badge">NEW</span>
          <div class="nr-card-overlay">
            <div class="nr-overlay-title">${escapeHtml(album.title)}</div>
            <div class="nr-overlay-artist">${escapeHtml(album.artist)}</div>
            <div class="nr-overlay-actions">
              <span class="nr-track-count">${trackCount} ${trackLabel}</span>
              <button class="nr-play-btn" title="Play album">${playSVG}</button>
            </div>
          </div>
        `;

        // First tap → reveal overlay; second tap on overlay → open track modal
        card.addEventListener('click', (e) => {
          if (e.target.closest('.nr-play-btn')) return; // handled below

          if (!card.classList.contains('overlay-active')) {
            // Close any other open overlays first
            document.querySelectorAll('.nr-album-card.overlay-active').forEach(c => c.classList.remove('overlay-active'));
            card.classList.add('overlay-active');
            e.stopPropagation();
          } else {
            // Already open — tapping overlay area opens track list
            showAlbumTracksModal(album);
          }
        });

        // Play button → play immediately
        card.querySelector('.nr-play-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          if (album.tracks.length > 0) {
            state.playlistContext = { tracks: album.tracks, currentIndex: 0, playFn: playTrack };
            playTrack(album.tracks[0]);
          }
          card.classList.remove('overlay-active');
        });

        grid.appendChild(card);
      });

      container.innerHTML = '';
      container.appendChild(grid);
    }
