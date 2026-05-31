// Home rails (New Releases, G100, Discover) for the mobile app.

import { elements, state } from './state.js';
import { getAlbumArtist, getAlbumField, getArtworkUrl, getGenreField, getTitleField, hasValidArtwork, hasValidAudio } from './fields.js';
import { search } from './search.js';
import { createDiscoverTrackCard, showAlbumTracksModal } from './cards.js';
import { closeModal, playTrack } from './player.js';

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
          <img class="nr-album-artwork" src="${album.artwork}" alt="${album.title}" loading="lazy" onerror="this.src='/img/placeholder.png'">
          <span class="nr-new-badge">NEW</span>
          <div class="nr-card-overlay">
            <div class="nr-overlay-title">${album.title}</div>
            <div class="nr-overlay-artist">${album.artist}</div>
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

export async function refreshDiscover() {
      // Clear the album cache so fresh counts are fetched after reload
      state.discoverAlbumCache.clear();
      const btn = document.getElementById('discover-refresh-btn');
      if (btn) btn.classList.add('spinning');
      try {
        await loadDiscover();
      } finally {
        if (btn) btn.classList.remove('spinning');
      }
    }

export async function loadDiscover() {
      // Show loading indicator
      elements.discoverContent.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><p>Loading tracks...</p></div>';

      try {
        let response, data;

        if (state.selectedDecade) {
          // Fetch tracks by decade
          const params = new URLSearchParams({
            start: state.selectedDecade.start,
            end: state.selectedDecade.start + 9,
            limit: 300
          });
          console.log('[Load Discover] Fetching decade:', state.selectedDecade.label);
          response = await fetch(`/api/explore?${params}`);
          data = await response.json();
          console.log('[Load Discover] Decade results:', data.total || 0, 'tracks found');
          state.randomTracks = data.items || [];

          // Apply genre filter if selected
          if (state.selectedGenre !== 'All') {
            console.log('[Load Discover] Applying genre filter:', state.selectedGenre);
            state.randomTracks = state.randomTracks.filter(track => {
              const genre = getGenreField(track.fields);
              return genre.toLowerCase().includes(state.selectedGenre.toLowerCase());
            });
            console.log('[Load Discover] After genre filter:', state.randomTracks.length, 'tracks');
          }
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
          response = await fetch('/api/random-songs?count=50');
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
        if (state.selectedDecade) filters.push(`<strong style="color: var(--accent);">${state.selectedDecade.label}</strong>`);
        if (state.selectedGenre !== 'All') filters.push(`<strong style="color: var(--accent);">${state.selectedGenre}</strong>`);
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
          : `No ${state.selectedGenre} tracks with artwork found`;
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

      // Render one card per album (limit to 100). The rendered list is the
      // Discover "feed" — now-playing prev/next navigate it (see play handler).
      const displayLimit = 100;
      state.discoverFeed = deduped.slice(0, displayLimit);
      state.discoverFeed.forEach(track => {
        const fields = track.fields || {};
        const key = `${getAlbumField(fields)}|||${getAlbumArtist(fields)}`.toLowerCase();
        const albumCtx = albumMap.get(key);
        const card = createDiscoverTrackCard(track, albumCtx);
        elements.discoverContent.appendChild(card);
      });

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
      document.querySelectorAll(`.album-count-btn[data-album-key="${CSS.escape(albumKey)}"] .album-badge-count`)
        .forEach(el => { el.textContent = count; });
    }
