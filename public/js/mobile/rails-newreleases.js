// Home rail: New Releases (mobile).

import { elements, state } from './state.js?v=13';
import { escapeHtml, getAlbumArtist, getAlbumField, getArtworkUrl, getTitleField, hasValidArtwork, hasValidAudio } from './fields.js?v=13';
import { renderAlbumTileGrid } from './cards.js?v=13';

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

      // Album running order — the feed arrives sorted by relevance, not position.
      albumMap.forEach(a => window.MADHelpers.sortTracksBySeq(a.tracks));

      const albums = [...albumMap.values()];
      container.innerHTML = '';
      renderAlbumTileGrid(container, albums, () => ({ badge: 'NEW' }));
    }
