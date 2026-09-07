// User playlists (load/render/play/create/add-to) for the mobile app.

import { elements, state } from './state.js?v=16';
import { showToast } from './util.js?v=16';
import { escapeHtml, getAlbumArtist, getAlbumField, getArtworkUrl, getAudioUrl, getTitleField } from './fields.js?v=16';
import { switchTab } from './nav.js?v=16';
import { closeModal, playTrack } from './player.js?v=16';
import { pushOverlay } from './router.js?v=16';
import { createAlbumTile } from './cards.js?v=16';

// ── Playlist icons ───────────────────────────────────────────────────────────
// Choices come from /data/playlist-icons.json (served no-cache) so adding one
// is a file upload plus a line of JSON. We STORE the master url and DISPLAY the
// _300 derivative — ~15 KB a tile instead of a multi-megabyte master.

let iconsPromise = null;

export function playlistIconThumb(masterUrl, size = 300) {
  if (!masterUrl || masterUrl.includes('/artwork/resized/')) return masterUrl;
  const s = size === 800 ? 800 : 300;
  return masterUrl
    .replace('/artwork/', '/artwork/resized/')
    .replace(/\.(?:jpe?g|png)(\?.*)?$/i, `_${s}.webp$1`);
}

function loadPlaylistIcons() {
  if (!iconsPromise) {
    iconsPromise = fetch('/data/playlist-icons.json')
      .then(r => (r.ok ? r.json() : null))
      .then((j) => {
        const base = j?.base || '';
        return (Array.isArray(j?.icons) ? j.icons : [])
          .filter(i => i && i.file)
          .map(i => ({ name: i.name || i.id || '', url: `${base}${i.file}` }));
      })
      .catch(() => []);
  }
  return iconsPromise;
}

/**
 * Bottom-sheet icon picker. Resolves to the chosen master url, '' to clear, or
 * null if the user backed out. Tiles whose image is missing remove themselves,
 * so a half-uploaded set still looks deliberate rather than broken.
 */
export async function pickPlaylistIcon(currentArtwork = '', heading = 'Choose artwork') {
  const icons = await loadPlaylistIcons();

  return new Promise((resolve) => {
    let selected = currentArtwork || '';
    let settled = false;
    let live = 0;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      elements.modalOverlay.removeEventListener('click', onBackdrop);
      closeModal();
      resolve(value);
    };
    const onBackdrop = (e) => { if (e.target === elements.modalOverlay) finish(null); };

    elements.bottomSheet.innerHTML = `
      <div class="bottom-sheet-header">${escapeHtml(heading)}</div>
      <p class="playlist-icon-hint">Tap an icon to choose it, or tap it again to remove it.</p>
      <div class="playlist-icon-grid"></div>
      <p class="playlist-icon-empty" hidden>No icons available yet.</p>
      <div class="playlist-icon-actions">
        <button class="btn btn-secondary" data-act="skip">Skip</button>
        <button class="btn btn-primary" data-act="save">Save</button>
      </div>
    `;

    const grid  = elements.bottomSheet.querySelector('.playlist-icon-grid');
    const empty = elements.bottomSheet.querySelector('.playlist-icon-empty');

    const paint = () => {
      grid.querySelectorAll('button').forEach((b) => {
        const on = b.dataset.url === selected && selected !== '';
        b.classList.toggle('selected', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    };

    icons.forEach(({ name, url }) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'playlist-icon-cell';
      cell.dataset.url = url;
      cell.setAttribute('aria-label', name);

      const img = document.createElement('img');
      img.src = playlistIconThumb(url, 300);
      img.alt = '';
      img.loading = 'lazy';
      // Derivative first, master second (the resizer may not have run yet); if
      // neither loads the icon simply isn't offered.
      img.onerror = () => {
        if (img.src !== url) { img.src = url; return; }
        cell.remove();
        if (--live === 0) empty.hidden = false;
        if (selected === url) selected = '';
      };
      img.onload = () => { live++; empty.hidden = true; };

      const lbl = document.createElement('span');
      lbl.textContent = name;

      cell.append(img, lbl);
      cell.addEventListener('click', () => {
        selected = selected === url ? '' : url;
        paint();
      });
      grid.appendChild(cell);
    });

    if (!icons.length) empty.hidden = false;
    paint();

    elements.bottomSheet.querySelector('[data-act="skip"]').addEventListener('click', () => finish(null));
    elements.bottomSheet.querySelector('[data-act="save"]').addEventListener('click', () => finish(selected));

    elements.modalOverlay.classList.add('show');
    elements.modalOverlay.addEventListener('click', onBackdrop);
    pushOverlay('playlist-icon', 'picker');
  });
}

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
        // A chosen icon wins over the first track's cover — it's the one piece
        // of art the owner actually picked.
        const chosen = playlist.artwork ? playlistIconThumb(playlist.artwork, 300) : '';
        const albumShape = {
          title: playlist.name,
          artist: 'My playlist',
          artwork: chosen || firstArt || '/img/default-album.svg',
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
        <button class="btn btn-secondary" style="width:100%;margin-top:16px;" data-act="artwork">Change artwork</button>
        <button class="btn btn-secondary" style="width:100%;margin-top:8px;" onclick="closeModal()">Close</button>
      `;
      elements.modalOverlay.classList.add('show');
      pushOverlay('playlist-tracks', playlist.id);
      elements.bottomSheet.querySelector('[data-act="artwork"]').addEventListener('click', () => {
        editPlaylistArtwork(playlist);
      });
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

export async function createPlaylist(name, artwork = '') {
      try {
        const response = await fetch('/api/playlists', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, artwork: artwork || undefined })
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

/** Name prompt, then the icon picker. Skipping the picker still creates it. */
export async function createPlaylistFlow() {
      const name = prompt('Playlist name:');
      if (!name) return;
      const chosen = await pickPlaylistIcon('', 'Choose artwork');
      await createPlaylist(name, chosen || '');
    }

/** Change an existing playlist's icon. */
export async function editPlaylistArtwork(playlist) {
      const chosen = await pickPlaylistIcon(playlist.artwork || '', 'Playlist artwork');
      if (chosen === null) return;                        // backed out
      if ((playlist.artwork || '') === chosen) return;    // unchanged
      try {
        const response = await fetch(`/api/playlists/${encodeURIComponent(playlist.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ artwork: chosen })
        });
        const json = await response.json().catch(() => ({}));
        if (!response.ok || !json?.ok) throw new Error(json?.error || 'Failed to update artwork');
        playlist.artwork = chosen;
        showToast('Artwork updated');
        loadPlaylists();
      } catch (err) {
        showToast(err?.message || 'Failed to update artwork', 'error');
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
