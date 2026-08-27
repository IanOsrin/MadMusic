// User playlists (load/render/play/create/add-to) for the mobile app.

import { elements, state } from './state.js?v=11';
import { showToast } from './util.js?v=11';
import { escapeHtml, getAlbumArtist, getAlbumField, getArtworkUrl, getAudioUrl, getTitleField } from './fields.js?v=11';
import { switchTab } from './nav.js?v=11';
import { closeModal, playTrack } from './player.js?v=11';
import { pushOverlay } from './router.js?v=11';
import { createAlbumTile } from './cards.js?v=11';

export async function loadPlaylists() {
      try {
        const response = await fetch('/api/playlists');
        if (!response.ok) {
          console.error('Failed to load playlists:', response.status);
          if (response.status === 401) {
            elements.playlistsContent.innerHTML = '<div class="empty-state"><div class="empty-icon">🔒</div><p>Token not recognised by server. Try re-entering your access token.</p></div>';
          }
          return;
        }
        const data = await response.json();
        state.playlists = data.playlists || [];
        renderPlaylists();
      } catch (err) {
        console.error('Failed to load playlists', err);
      }
    }

export function renderPlaylists() {
      if (state.playlists.length === 0) {
        elements.playlistsContent.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><p>No playlists yet. Create one!</p></div>';
        return;
      }

      // Tile grid — same visual family as New Releases / G100. A playlist's
      // "cover" is its first track's artwork; empty playlists get the default
      // album tile.
      elements.playlistsContent.innerHTML = '';
      const grid = document.createElement('div');
      grid.className = 'nr-album-grid';
      state.playlists.forEach(playlist => {
        const tracks = playlist.tracks || [];
        const firstArt = tracks.map(t => t.artworkUrl || t.artwork || getArtworkUrl(t.fields || {})).find(u => u && /^https?:/.test(u));
        const albumShape = {
          title: playlist.name,
          artist: 'My playlist',
          artwork: firstArt || '/img/default-album.svg',
          tracks
        };
        grid.appendChild(createAlbumTile(albumShape, {
          onOpen: () => showPlaylistTracks(playlist),
          onPlay: () => {
            if (tracks.length === 0) { showToast('Playlist is empty', 'error'); return; }
            state.playlistContext = { tracks, currentIndex: 0, name: playlist.name, playFn: playPlaylistTrack };
            playPlaylistTrack(tracks[0]);
          }
        }));
      });
      elements.playlistsContent.appendChild(grid);
    }

export function showPlaylistTracks(playlist) {
      const tracks = playlist.tracks || [];
      elements.bottomSheet.innerHTML = `
        <div class="bottom-sheet-header">${escapeHtml(playlist.name)}</div>
        ${tracks.length === 0 ? '<p style="text-align:center;color:var(--text-muted);padding:16px;">No tracks yet</p>' :
          tracks.map((t, i) => `
            <button class="bottom-sheet-option" data-index="${i}" style="display:flex;align-items:center;gap:10px;text-align:left;">
              <span style="flex:1;">${escapeHtml(t.name || 'Unknown')}<br><small style="color:var(--text-muted)">${escapeHtml(t.albumArtist || t.albumTitle || '')}</small></span>
              <span>▶</span>
            </button>
          `).join('')}
        <button class="btn btn-secondary" style="width:100%;margin-top:16px;" onclick="closeModal()">Close</button>
      `;
      elements.modalOverlay.classList.add('show');
      pushOverlay('playlist-tracks', playlist.id);
      elements.bottomSheet.querySelectorAll('[data-index]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.index);
          state.playlistContext = { tracks, currentIndex: idx, name: playlist.name, playFn: playPlaylistTrack };
          playPlaylistTrack(tracks[idx]);
          closeModal();
        });
      });
    }

export async function playPlaylistTrack(playlistTrack) {
      const recordId = playlistTrack.trackRecordId || playlistTrack.recordId || '';

      let freshAudio = '', freshArtwork = '';
      if (recordId) {
        try {
          const r = await fetch(`/api/track/${encodeURIComponent(recordId)}/container`);
          const d = await r.json();
          if (d && d.ok) { freshAudio = d.url || ''; freshArtwork = d.artworkUrl || ''; }
        } catch (e) { /* fall back to stored URLs */ }
      }

      const adapted = {
        recordId,
        fields: {
          'Track Name': playlistTrack.name || '',
          'Album Title': playlistTrack.albumTitle || '',
          'Album Artist': playlistTrack.albumArtist || playlistTrack.trackArtist || '',
          // Fresh S3 first; stored (possibly stale) only as fallback.
          'Artwork_S3_URL': freshArtwork || playlistTrack.artwork || '',
          'S3_URL': freshAudio || '',
          'mp3': playlistTrack.mp3 || ''
        }
      };
      playTrack(adapted);
    }

export async function createPlaylist(name) {
      try {
        const response = await fetch('/api/playlists', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });

        if (response.ok) {
          showToast('Playlist created!');
          loadPlaylists();
        } else {
          showToast('Failed to create playlist', 'error');
        }
      } catch (err) {
        showToast('Failed to create playlist', 'error');
      }
    }

export function showAddToPlaylistModal(track) {
      if (!state.currentUser) {
        showToast('Please log in to add to playlists', 'error');
        switchTab('profile');
        return;
      }

      if (state.playlists.length === 0) {
        showToast('Create a playlist first', 'error');
        switchTab('playlists');
        return;
      }

      elements.bottomSheet.innerHTML = `
        <div class="bottom-sheet-header">Add to Playlist</div>
        ${state.playlists.map(playlist => `
          <button class="bottom-sheet-option" data-playlist-id="${escapeHtml(playlist.id)}">
            ${escapeHtml(playlist.name)}
          </button>
        `).join('')}
        <button class="btn btn-secondary" style="width: 100%; margin-top: 16px;" onclick="closeModal()">Cancel</button>
      `;

      elements.modalOverlay.classList.add('show');

      elements.bottomSheet.querySelectorAll('[data-playlist-id]').forEach(btn => {
        btn.addEventListener('click', () => {
          addTrackToPlaylist(btn.dataset.playlistId, track);
          closeModal();
        });
      });
    }

export async function addTrackToPlaylist(playlistId, track) {
      try {
        const fields = track.fields || {};

        // Transform FileMaker track to playlist format
        const playlistTrack = {
          recordId: track.recordId || '',
          name: getTitleField(fields),
          albumTitle: getAlbumField(fields),
          albumArtist: getAlbumArtist(fields),
          artwork: getArtworkUrl(fields),
          mp3: getAudioUrl(fields) || ''
        };

        const response = await fetch(`/api/playlists/${playlistId}/tracks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ track: playlistTrack })
        });

        if (response.ok) {
          showToast('Added to playlist!');
          loadPlaylists();
        } else {
          const error = await response.json();
          showToast(error.error || 'Failed to add track', 'error');
        }
      } catch (err) {
        console.error('Add to playlist error:', err);
        showToast('Failed to add track', 'error');
      }
    }
