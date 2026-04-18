// public/js/playlists.js
// Sidebar playlists module - manages user playlist display

(function() {
  'use strict';

  function toggleNavSection(sectionId) {
    const section = document.getElementById(sectionId);
    section.classList.toggle('collapsed');
  }

  // ---- Simple toast helper ----
  function showToast(message, type) {
    let container = document.getElementById('massToastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'massToastContainer';
      container.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    const bg = type === 'error' ? '#ff4f4f' : type === 'warn' ? '#f5a623' : '#62f5a9';
    const color = type === 'error' || type === 'warn' ? '#fff' : '#0a0a0a';
    toast.style.cssText = `background:${bg};color:${color};padding:10px 18px;border-radius:20px;font-size:13px;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,0.35);opacity:1;transition:opacity 0.4s;white-space:nowrap;pointer-events:none;`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 400); }, 2600);
  }

  // Playlist management

  const myPlaylistsList = document.getElementById('sidebarMyPlaylistsList');
  const myPlaylistsEmpty = document.getElementById('sidebarMyPlaylistsEmpty');

  async function loadMyPlaylists() {
    try {
      const res = await fetch('/api/playlists');
      const data = await res.json();
      if (data.ok && Array.isArray(data.playlists)) {
        if (data.playlists.length > 0) {
          renderMyPlaylists(data.playlists);
          myPlaylistsEmpty.hidden = true;
        } else {
          myPlaylistsEmpty.hidden = false;
        }
      }
    } catch (err) {
      console.error('[Sidebar] Failed to load playlists:', err);
    }
  }

  function renderMyPlaylists(playlists) {
    myPlaylistsList.innerHTML = '';
    playlists.forEach(playlist => {
      const li = document.createElement('li');
      li.className = 'sidebar-playlist-item';

      const btn = document.createElement('button');
      btn.className = 'sidebar-playlist-btn';
      btn.dataset.playlistId = playlist.id;

      const thumb = document.createElement('div');
      thumb.className = 'sidebar-playlist-thumb';
      thumb.textContent = '🎵';

      const name = document.createElement('span');
      name.className = 'sidebar-playlist-name';
      name.textContent = playlist.name;

      const count = document.createElement('span');
      count.className = 'sidebar-playlist-count';
      count.textContent = playlist.tracks?.length || 0;

      btn.appendChild(thumb);
      btn.appendChild(name);
      btn.appendChild(count);

      btn.addEventListener('click', () => {
        // Map stored track fields
        const mappedTracks = (playlist.tracks || []).map(t => ({
          name:          t.name          || 'Unknown Track',
          artist:        t.trackArtist   || t.albumArtist || '',
          album:         t.albumTitle    || '',
          audioUrl:      t.resolvedSrc   || t.mp3         || '',
          artwork:       t.artwork       || '',
          artworkUrl:    t.artwork       || '',
          duration:      t.duration      || '',
          trackRecordId: t.trackRecordId || '',
          addedAt:       t.addedAt       || '',
          playlistId:    playlist.id     || ''
        }));

        // Show the dedicated user playlist view
        if (typeof window.showUserPlaylistPage === 'function') {
          window.showUserPlaylistPage(playlist.name, mappedTracks, playlist.id);
        }
      });

      // --- Share button ---
      const shareBtn = document.createElement('button');
      shareBtn.className = 'sidebar-playlist-action sidebar-playlist-share';
      shareBtn.title = 'Share playlist';
      shareBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>';
      shareBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof window.MADOpenShareEmailModal === 'function') {
          window.MADOpenShareEmailModal(playlist.id, playlist.name);
        }
      });

      // --- Delete button ---
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'sidebar-playlist-action sidebar-playlist-delete';
      deleteBtn.title = 'Delete playlist';
      deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete playlist "${playlist.name}"? This cannot be undone.`)) return;
        try {
          const res = await fetch(`/api/playlists/${encodeURIComponent(playlist.id)}`, { method: 'DELETE' });
          const data = await res.json();
          if (data.ok) {
            // If this playlist is currently open, close the view
            const pv = document.getElementById('playlistView');
            if (pv && pv.dataset.playlistId === playlist.id) {
              if (typeof window.hidePlaylistView === 'function') window.hidePlaylistView();
            }
            showToast(`"${playlist.name}" deleted`);
            loadMyPlaylists();
          } else {
            showToast('Delete failed', 'error');
          }
        } catch (err) {
          console.error('[Sidebar] Delete playlist error:', err);
          showToast('Delete failed', 'error');
        }
      });

      li.appendChild(btn);
      li.appendChild(shareBtn);
      li.appendChild(deleteBtn);
      myPlaylistsList.appendChild(li);
    });
  }

  // Wait for access token before loading playlists
  window.addEventListener('mass:access-ready', loadMyPlaylists);
  if (window.massAccessReady) loadMyPlaylists();

  // ---- PUBLIC API ----

  window.MADPlaylists = {
    loadMyPlaylists,
    renderMyPlaylists,
    showToast
  };

  // Direct window assignments
  window.loadMyPlaylists = loadMyPlaylists;
  window.toggleNavSection = toggleNavSection;
  window.MADShowToast = showToast;
})();