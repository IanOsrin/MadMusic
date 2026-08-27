// Home rail: Discover feed (mobile).

import { elements, state } from './state.js?v=10';
import { escapeHtml, getAlbumArtist, getAlbumField, getArtworkUrl, getGenreField, hasValidArtwork, hasValidAudio } from './fields.js?v=10';
import { search } from './search.js?v=10';
import { createAlbumTile, showAlbumTracksModal } from './cards.js?v=10';
import { playTrack, renderPlayerQueue } from './player.js?v=10';

export async function refreshDiscover() {
      // Clear the album cache so fresh counts are fetched after reload
      state.discoverAlbumCache.clear();
      const btn = document.getElementById('discover-refresh-btn');
      if (btn) btn.classList.add('spinning');
      try {
        // fresh=true → the server rotates its random pool instead of
        // reshuffling the same cached 600-track window
        await loadDiscover(true);
      } finally {
        if (btn) btn.classList.remove('spinning');
      }
    }

export async function loadDiscover(fresh = false) {
      // Show loading indicator
      elements.discoverContent.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><p>Loading tracks...</p></div>';

      try {
        let response, data;

        if (state.selectedDecade) {
          // Fetch tracks by decade — WITH the genre when one is selected.
          // /api/explore queries FM server-side for the combination; the old
          // client-side includes() filter over a 300-track decade sample
          // missed label variants and niche genres entirely ("decades and
          // genres do not work well together", 2026-07-28).
          const params = new URLSearchParams({
            start: state.selectedDecade.start,
            end: state.selectedDecade.start + 9,
            limit: 300
          });
          if (state.selectedGenre !== 'All') params.set('genre', state.selectedGenre);
          console.log('[Load Discover] Fetching decade:', state.selectedDecade.label,
            state.selectedGenre !== 'All' ? `+ genre: ${state.selectedGenre}` : '');
          response = await fetch(`/api/explore?${params}`);
          data = await response.json();
          console.log('[Load Discover] Results:', (data.items || []).length, 'tracks');
          state.randomTracks = data.items || [];
        } else if (state.selectedGenre !== 'All') {
          // Fetch tracks by genre only (no decade filter)
          console.log('[Load Discover] Fetching genre:', state.selectedGenre);
          response = await fetch(`/api/search?genre=${encodeURIComponent(state.selectedGenre)}&limit=200`);
          data = await response.json();
          console.log('[Load Discover] Genre results:', data.total, 'total tracks');

          // Shuffle results to show different tracks on refresh
          const items = data.items || [];
          for (let i = items.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [items[i], items[j]] = [items[j], items[i]];
          }
          state.randomTracks = items;
        } else {
          // Fetch random tracks (no filters)
          response = await fetch(`/api/random-songs?count=50${fresh ? '&fresh=1' : ''}`);
          data = await response.json();
          state.randomTracks = data.items || [];
        }

        renderDiscoverTracks();
      } catch (err) {
        console.error('Failed to load discover', err);
        elements.discoverContent.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><p>Failed to load tracks</p></div>';
      }
    }

export function renderDiscoverTracks() {
      elements.discoverContent.innerHTML = '';

      // Show filter indicators
      if (state.selectedDecade || state.selectedGenre !== 'All') {
        const indicator = document.createElement('div');
        indicator.style.cssText = 'padding: 8px 16px; background: var(--bg-card); border-radius: 8px; margin-bottom: 16px;';

        let filterText = 'Filtered by: ';
        const filters = [];
        if (state.selectedDecade) filters.push(`<strong style="color: var(--accent);">${escapeHtml(state.selectedDecade.label)}</strong>`);
        if (state.selectedGenre !== 'All') filters.push(`<strong style="color: var(--accent);">${escapeHtml(state.selectedGenre)}</strong>`);
        filterText += filters.join(' + ');

        indicator.innerHTML = `
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
            <span style="font-size: 14px; color: var(--text-secondary);">${filterText}</span>
          </div>
          <div style="display: flex; gap: 8px;">
            ${state.selectedDecade ? '<button onclick="clearDecadeFilter()" style="padding: 4px 12px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary); font-size: 12px; cursor: pointer;">Clear Decade</button>' : ''}
            ${state.selectedGenre !== 'All' ? '<button onclick="clearGenreFilter()" style="padding: 4px 12px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary); font-size: 12px; cursor: pointer;">Clear Genre</button>' : ''}
            ${(state.selectedDecade || state.selectedGenre !== 'All') ? '<button onclick="clearAllFilters()" style="padding: 4px 12px; background: var(--accent); border: none; border-radius: 4px; color: white; font-size: 12px; cursor: pointer;">Clear All</button>' : ''}
          </div>
        `;
        elements.discoverContent.appendChild(indicator);
      }

      // Filter by valid audio AND valid artwork (genre filtering already done by API)
      const filteredTracks = state.randomTracks.filter(track => hasValidAudio(track) && hasValidArtwork(track));

      console.log('[Render Discover] Tracks with valid audio and artwork:', filteredTracks.length, 'out of', state.randomTracks.length);

      if (filteredTracks.length === 0) {
        const message = state.selectedGenre === 'All'
          ? 'No tracks with audio and artwork available'
          : `No ${escapeHtml(state.selectedGenre)} tracks with artwork found`;
        elements.discoverContent.innerHTML += `<div class="empty-state"><div class="empty-icon">🎵</div><p>${message}</p></div>`;
        return;
      }

      // Build album map so every track knows its siblings and total count
      const albumMap = new Map();
      filteredTracks.forEach(track => {
        const fields = track.fields || {};
        const albumTitle  = getAlbumField(fields);
        const albumArtist = getAlbumArtist(fields);
        const key = `${albumTitle}|||${albumArtist}`.toLowerCase();
        if (!albumMap.has(key)) {
          albumMap.set(key, {
            title:   albumTitle,
            artist:  albumArtist,
            artwork: getArtworkUrl(fields),
            tracks:  []
          });
        }
        albumMap.get(key).tracks.push(track);
      });

      // Album running order — the feed arrives sorted by relevance, not position.
      // Also makes the "first track seen" below the album's ACTUAL first track.
      albumMap.forEach(a => window.MADHelpers.sortTracksBySeq(a.tracks));

      // Deduplicate to one representative track per album (first track seen).
      // Decade and genre searches return every track, so without this the list
      // floods with duplicates from the same album.
      const seenAlbums = new Set();
      const deduped = [];
      filteredTracks.forEach(track => {
        const fields = track.fields || {};
        const key = `${getAlbumField(fields)}|||${getAlbumArtist(fields)}`.toLowerCase();
        if (!seenAlbums.has(key)) {
          seenAlbums.add(key);
          deduped.push(track);
        }
      });

      // Render one TILE per album (limit to 100) — same grid as New Releases /
      // G100. The rendered list is still the Discover "feed": now-playing
      // prev/next navigate it via the tile's play handler.
      const displayLimit = 100;
      state.discoverFeed = deduped.slice(0, displayLimit);
      const grid = document.createElement('div');
      grid.className = 'nr-album-grid';
      state.discoverFeed.forEach(track => {
        const fields = track.fields || {};
        const key = `${getAlbumField(fields)}|||${getAlbumArtist(fields)}`.toLowerCase();
        const albumCtx = albumMap.get(key);
        grid.appendChild(createAlbumTile(albumCtx, {
          countBadgeKey: key,
          // open → full album from cache (prefetch) or a fetch-on-demand,
          // exactly like the old album-count button
          onOpen: async () => {
            const cached = state.discoverAlbumCache.get(key);
            if (cached) { showAlbumTracksModal(cached); return; }
            try {
              const res = await fetch(`/api/album?${new URLSearchParams({ title: albumCtx.title, artist: albumCtx.artist })}`);
              const data = await res.json();
              if (data.ok && data.items?.length) {
                const fullAlbum = { ...albumCtx, tracks: data.items };
                state.discoverAlbumCache.set(key, fullAlbum);
                updateDiscoverBadgeCounts(key, data.items.length);
                showAlbumTracksModal(fullAlbum);
              } else showAlbumTracksModal(albumCtx);
            } catch { showAlbumTracksModal(albumCtx); }
          },
          // play → the ALBUM is the queue (was the whole Discover feed, which
          // made next/prev wander across albums — Ian, 2026-07-29). Play the
          // tapped track immediately, then swap in the full album context once
          // it's resolved (cache or fetch) so skips stay inside the record.
          onPlay: async () => {
            state.playlistContext = { tracks: [track], currentIndex: 0, name: albumCtx.title, playFn: playTrack };
            playTrack(track);
            let album = state.discoverAlbumCache.get(key);
            if (!album) {
              try {
                const res = await fetch(`/api/album?${new URLSearchParams({ title: albumCtx.title, artist: albumCtx.artist })}`);
                const data = await res.json();
                if (data.ok && data.items?.length) {
                  album = { ...albumCtx, tracks: data.items };
                  state.discoverAlbumCache.set(key, album);
                  updateDiscoverBadgeCounts(key, data.items.length);
                }
              } catch { /* keep the single-track context */ }
            }
            const tracks = album?.tracks;
            if (!tracks || !tracks.length) return;
            const idx = tracks.findIndex(t => t.recordId === track.recordId);
            state.playlistContext = { tracks, currentIndex: idx >= 0 ? idx : 0, name: albumCtx.title, playFn: playTrack };
            renderPlayerQueue();
          }
        }));
      });
      elements.discoverContent.appendChild(grid);

      console.log('[Render Discover] Rendered', Math.min(displayLimit, deduped.length), 'cards from', filteredTracks.length, 'tracks');

      // Prefetch real album track counts in the background so badges update automatically
      prefetchDiscoverAlbums(albumMap);
    }

export async function prefetchDiscoverAlbums(albumMap) {
      const entries = Array.from(albumMap.entries()); // [key, albumCtx]
      const CONCURRENCY = 4; // gentle on the server

      async function fetchOne([key, albumCtx]) {
        if (state.discoverAlbumCache.has(key)) return; // already done
        try {
          const params = new URLSearchParams({ title: albumCtx.title, artist: albumCtx.artist });
          const res  = await fetch(`/api/album?${params}`);
          if (!res.ok) return;
          const data = await res.json();
          if (!data.ok || !data.items?.length) return;
          const fullAlbum = { ...albumCtx, tracks: data.items };
          state.discoverAlbumCache.set(key, fullAlbum);
          // Push the real count to any visible badge for this album
          updateDiscoverBadgeCounts(key, data.items.length);
        } catch { /* silent — badge stays at placeholder */ }
      }

      // Process in small parallel batches
      for (let i = 0; i < entries.length; i += CONCURRENCY) {
        await Promise.all(entries.slice(i, i + CONCURRENCY).map(fetchOne));
      }
    }

export function updateDiscoverBadgeCounts(albumKey, count) {
      document.querySelectorAll(
        `.album-count-btn[data-album-key="${CSS.escape(albumKey)}"] .album-badge-count, ` +
        `.nr-track-count[data-album-key="${CSS.escape(albumKey)}"] .nr-count-num`
      ).forEach(el => { el.textContent = count; });
    }
