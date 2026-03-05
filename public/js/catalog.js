(function() {
  'use strict';

  // ---- EXPORTED FUNCTIONS ----
// Initialize Home Page Content (Major Releases & Highlights)
    async function initializeHomePage() {
      try {
        // Fetch featured albums for Major Releases
        const response = await fetch('/api/featured-albums?limit=18');
        if (response.ok) {
          const data = await response.json();
          const items = data.items || [];

          // Transform the data to a cleaner format
          const albums = items.map(item => {
            const fields = item.fields || {};
            return {
              title: fields['Tape Files::Album Title'] || fields['Album Title'] || 'Unknown Album',
              artist: fields['Tape Files::Album Artist'] || fields['Album Artist'] || 'Unknown Artist',
              artworkUrl: fields['Tape Files::Artwork_S3_URL'] || fields['Artwork::Picture'] || '/img/placeholder.jpg',
              year: fields['Year of Release'] || '',
              genre: fields['Genre'] || ''
            };
          });

          // Remove duplicates based on title+artist
          const uniqueAlbums = albums.filter((album, index, self) =>
            index === self.findIndex(a => a.title === album.title && a.artist === album.artist)
          );

          populateMajorReleases(uniqueAlbums);

          // Use first album for highlight if available
          if (uniqueAlbums.length > 0) {
            populateHighlight(uniqueAlbums[0]);
          }
        }
      } catch (err) {
        console.log('[Home] Could not load home content:', err);
      }
    }

    function populateMajorReleases(albums) {
      const carousel = document.getElementById('releasesCarousel');
      if (!carousel) return;

      carousel.innerHTML = albums.map(album => {
        const artUrl = album.artworkUrl || '/img/placeholder.jpg';
        const title = album.title || 'Unknown Album';
        const artist = album.artist || 'Unknown Artist';

        return `
          <div class="release-card" data-album="${encodeURIComponent(title)}" data-artist="${encodeURIComponent(artist)}">
            <div class="release-card-bg" style="background-image: url('${artUrl}')"></div>
            <div class="release-card-overlay"></div>
            <div class="release-card-content">
              <h3 class="release-card-title">${title}</h3>
              <p class="release-card-artist">${artist}</p>
            </div>
          </div>
        `;
      }).join('');

      // Add click handlers to cards
      carousel.querySelectorAll('.release-card').forEach(card => {
        card.addEventListener('click', () => {
          const albumTitle = decodeURIComponent(card.dataset.album);
          const artistName = decodeURIComponent(card.dataset.artist);
          // Trigger search for this album
          const searchAlbum = document.getElementById('searchAlbum');
          const searchArtist = document.getElementById('searchArtist');
          const goBtn = document.getElementById('go');
          if (searchAlbum && goBtn) {
            searchAlbum.value = albumTitle;
            if (searchArtist) searchArtist.value = artistName;
            document.getElementById('searchFields').hidden = false;
            goBtn.click();
          }
        });
      });

      // Carousel navigation
      const prevBtn = document.getElementById('releasesPrev');
      const nextBtn = document.getElementById('releasesNext');

      if (prevBtn && nextBtn) {
        prevBtn.addEventListener('click', () => {
          carousel.scrollBy({ left: -240, behavior: 'smooth' });
        });
        nextBtn.addEventListener('click', () => {
          carousel.scrollBy({ left: 240, behavior: 'smooth' });
        });
      }
    }

    function populateHighlight(album) {
      const banner = document.getElementById('highlightBanner');
      const bannerBg = document.getElementById('highlightBannerBg');
      const titleEl = document.getElementById('highlightTitle');
      const subtitleEl = document.getElementById('highlightSubtitle');

      if (banner && album) {
        const artUrl = album.artworkUrl || '/img/placeholder.jpg';
        const albumTitle = album.title || 'Featured Album';
        const artist = album.artist || 'Discover new music';

        if (bannerBg) bannerBg.style.backgroundImage = `url('${artUrl}')`;
        if (titleEl) titleEl.textContent = albumTitle;
        if (subtitleEl) subtitleEl.textContent = artist;

        banner.addEventListener('click', () => {
          const searchAlbum = document.getElementById('searchAlbum');
          const goBtn = document.getElementById('go');
          if (searchAlbum && goBtn) {
            searchAlbum.value = albumTitle;
            document.getElementById('searchFields').hidden = false;
            goBtn.click();
          }
        });
      }
    }

    // Initialize home page on load
    document.addEventListener('DOMContentLoaded', initializeHomePage);

    // Playlist View Functionality — flat track list, no album thumbnails
    function showPlaylistView(playlistName, tracks, playlistId) {
      const playlistView = document.getElementById('playlistView');
      const layoutGrid = document.querySelector('.layout-grid');
      const playlistTitle = document.getElementById('playlistViewTitle');
      const albumsList = document.getElementById('playlistAlbumsList');
      const albumDetail = document.getElementById('playlistAlbumDetail');
      const detailHeader = albumDetail && albumDetail.querySelector('.playlist-detail-header');
      const trackList = document.getElementById('playlistTrackList');

      if (!playlistView || !layoutGrid || !trackList) return;

      // Resolve playlistId from parameter or from first track
      const resolvedId = playlistId || tracks[0]?.playlistId || '';

      // Update title and switch view
      if (playlistTitle) playlistTitle.textContent = playlistName;
      layoutGrid.style.display = 'none';
      playlistView.classList.add('active');
      playlistView.dataset.playlistMode = 'user';
      playlistView.dataset.playlistId = resolvedId;
      playlistView.dataset.playlistName = playlistName;

      // Show/wire header action buttons
      const actionsBar = document.getElementById('playlistViewActions');
      const shareBtn   = document.getElementById('playlistViewShareBtn');
      const deleteBtn  = document.getElementById('playlistViewDeleteBtn');
      if (actionsBar) actionsBar.hidden = !resolvedId;

      if (shareBtn && resolvedId) {
        shareBtn.onclick = () => {
          if (typeof window.MADOpenShareEmailModal === 'function') {
            window.MADOpenShareEmailModal(resolvedId, playlistName);
          }
        };
      }

      if (deleteBtn && resolvedId) {
        deleteBtn.onclick = async () => {
          if (!confirm(`Delete playlist "${playlistName}"? This cannot be undone.`)) return;
          try {
            const res  = await fetch(`/api/playlists/${encodeURIComponent(resolvedId)}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.ok) {
              if (typeof window.MADShowToast === 'function') window.MADShowToast(`"${playlistName}" deleted`);
              hidePlaylistView();
              if (typeof window.loadMyPlaylists === 'function') window.loadMyPlaylists();
            } else {
              if (typeof window.MADShowToast === 'function') window.MADShowToast('Delete failed', 'error');
            }
          } catch (err) {
            console.error('[Playlist] delete error', err);
            if (typeof window.MADShowToast === 'function') window.MADShowToast('Delete failed', 'error');
          }
        };
      }

      // Hide album thumbnails panel and album detail header — flat list only
      if (albumsList) albumsList.hidden = true;
      if (detailHeader) detailHeader.hidden = true;
      if (albumDetail) albumDetail.style.width = '100%';

      const esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

      // Render all tracks as a flat numbered list
      trackList.innerHTML = tracks.map((track, index) => {
        const name    = esc(track.name || track.trackName || 'Unknown Track');
        const artist  = esc(track.artist || track.albumArtist || '');
        const album   = esc(track.album || track.albumTitle || '');
        const dur     = esc(track.duration || '');
        const hasDelete = track.addedAt && track.playlistId;
        return `
        <div class="playlist-track-item" data-track-index="${index}"
             data-added-at="${esc(track.addedAt || '')}"
             data-playlist-id="${esc(track.playlistId || '')}">
          <span class="playlist-track-number">${index + 1}</span>
          <div class="playlist-track-meta">
            <span class="playlist-track-name">${name}</span>
            ${artist ? `<span class="playlist-track-artist">${artist}${album ? ' · ' + album : ''}</span>` : ''}
          </div>
          <span class="playlist-track-duration">${dur}</span>
          ${hasDelete ? `<button class="playlist-track-delete" title="Remove">✕</button>` : ''}
        </div>`;
      }).join('');

      // Wire up click handlers
      trackList.querySelectorAll('.playlist-track-item').forEach(item => {
        // Delete button
        const deleteBtn = item.querySelector('.playlist-track-delete');
        if (deleteBtn) {
          deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const playlistId = item.dataset.playlistId;
            const addedAt = item.dataset.addedAt;
            if (!playlistId || !addedAt) return;
            try {
              const res = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(addedAt)}`, { method: 'DELETE' });
              if ((await res.json()).ok) {
                if (item.classList.contains('playing')) {
                  const player = document.getElementById('player');
                  if (player) { player.pause(); player.src = ''; }
                }
                item.remove();
              }
            } catch (err) {
              console.error('[Playlist] delete track error', err);
            }
          });
        }

        // Click row → play
        item.addEventListener('click', () => {
          const trackIndex = parseInt(item.dataset.trackIndex);
          const track = tracks[trackIndex];
          if (track && track.audioUrl) {
            let src = track.audioUrl;
            if (src && /^https?:\/\//i.test(src) && !/\.s3[.-]/.test(src) && !src.includes('/api/container?')) {
              src = `/api/container?u=${encodeURIComponent(src)}`;
            }
            const player = document.getElementById('player');
            if (player && src) {
              player.src = src;
              if (typeof window.massSetCurrentTrack === 'function') {
                window.massSetCurrentTrack({
                  trackRecordId: track.trackRecordId || '',
                  trackName:     track.name    || 'Unknown Track',
                  trackArtist:   track.artist  || '',
                  albumTitle:    track.album   || '',
                  picture:       track.artworkUrl || track.artwork || ''
                });
              }
              player.play().catch(err => console.warn('[Playlist] play error', err));
            }
          }
          trackList.querySelectorAll('.playlist-track-item').forEach(t => t.classList.remove('playing'));
          item.classList.add('playing');
        });
      });
    }

    // showAlbumDetail kept for other callers (album browser, etc.)
    function showAlbumDetail(album) {
      const artwork = document.getElementById('playlistDetailArtwork');
      const title = document.getElementById('playlistDetailTitle');
      const artist = document.getElementById('playlistDetailArtist');
      const genre = document.getElementById('playlistDetailGenre');
      const year = document.getElementById('playlistDetailYear');
      const trackList = document.getElementById('playlistTrackList');
      const detailHeader = document.querySelector('#playlistAlbumDetail .playlist-detail-header');

      if (artwork) artwork.src = album.artwork || '/img/placeholder.jpg';
      if (title) title.textContent = album.title;
      if (artist) artist.textContent = album.artist || 'Unknown Artist';
      if (genre) genre.textContent = album.genre || 'MUSIC';
      if (year) year.textContent = album.year || '';
      if (detailHeader) detailHeader.hidden = false;

      if (trackList && album.tracks) {
        const esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        trackList.innerHTML = album.tracks.map((track, index) => {
          const hasDelete = track.addedAt && track.playlistId;
          return `
          <div class="playlist-track-item" data-track-index="${index}"
               data-added-at="${track.addedAt || ''}"
               data-playlist-id="${track.playlistId || ''}">
            <div class="track-play-overlay">▶</div>
            <span class="playlist-track-number">${index + 1}.</span>
            <span class="playlist-track-name">${esc(track.name || track.trackName || 'Unknown Track')}</span>
            <span class="playlist-track-duration">${esc(track.duration || '')}</span>
            ${hasDelete ? `<button class="playlist-track-delete" title="Remove from playlist">✕</button>` : ''}
            <button class="track-kebab-btn" data-track-index="${index}" title="Track info">⋮</button>
          </div>`;
        }).join('');

        trackList.querySelectorAll('.playlist-track-item').forEach(item => {
          const deleteBtn = item.querySelector('.playlist-track-delete');
          if (deleteBtn) {
            deleteBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              const playlistId = item.dataset.playlistId;
              const addedAt = item.dataset.addedAt;
              if (!playlistId || !addedAt) return;
              try {
                const res = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(addedAt)}`, { method: 'DELETE' });
                if ((await res.json()).ok) {
                  if (item.classList.contains('playing')) {
                    const player = document.getElementById('player');
                    if (player) { player.pause(); player.src = ''; }
                  }
                  item.remove();
                }
              } catch (err) { console.error('[Playlist] delete track error', err); }
            });
          }
          item.addEventListener('click', () => {
            const trackIndex = parseInt(item.dataset.trackIndex);
            const track = album.tracks[trackIndex];
            if (track && track.audioUrl) {
              let src = track.audioUrl;
              if (src && /^https?:\/\//i.test(src) && !/\.s3[.-]/.test(src) && !src.includes('/api/container?')) {
                src = `/api/container?u=${encodeURIComponent(src)}`;
              }
              const player = document.getElementById('player');
              if (player && src) {
                player.src = src;
                if (typeof window.massSetCurrentTrack === 'function') {
                  window.massSetCurrentTrack({
                    trackRecordId: track.trackRecordId || '',
                    trackName:     track.name    || 'Unknown Track',
                    trackArtist:   track.artist  || '',
                    albumTitle:    album.title   || '',
                    picture:       album.artwork || ''
                  });
                }
                player.play().catch(err => console.warn('[Playlist] play error', err));
              }
            }
            trackList.querySelectorAll('.playlist-track-item').forEach(t => t.classList.remove('playing'));
            item.classList.add('playing');
          });
        });
      }
    }

    function hidePlaylistView() {
      const playlistView = document.getElementById('playlistView');
      const layoutGrid = document.querySelector('.layout-grid');
      const albumsList = document.getElementById('playlistAlbumsList');
      const albumDetail = document.getElementById('playlistAlbumDetail');
      const detailHeader = albumDetail && albumDetail.querySelector('.playlist-detail-header');
      const actionsBar  = document.getElementById('playlistViewActions');

      if (playlistView) {
        playlistView.classList.remove('active');
        delete playlistView.dataset.playlistId;
        delete playlistView.dataset.playlistName;
      }
      if (actionsBar) actionsBar.hidden = true;
      if (layoutGrid) layoutGrid.style.display = 'flex';
      // Restore panels for next time (album browser reuses this view)
      if (albumsList) albumsList.hidden = false;
      if (detailHeader) detailHeader.hidden = false;
      if (albumDetail) albumDetail.style.width = '';
    }


    // Close featured playlist button handler
    document.addEventListener('DOMContentLoaded', () => {
      const closeBtn = document.getElementById('closePublicPlaylistBtn');
      const clearBtn = document.getElementById('clear');
      const publicPlaylistView = document.getElementById('publicPlaylistView');
      const searchEl = document.getElementById('search');
      const searchArtistEl = document.getElementById('searchArtist');
      const searchAlbumEl = document.getElementById('searchAlbum');
      const searchTrackEl = document.getElementById('searchTrack');
      const searchFieldsEl = document.getElementById('searchFields');
      let goBtn = document.getElementById('go');

      // Show search fields when Search button is clicked
      if (goBtn && searchFieldsEl) {
        console.log('[MASS] Attaching search button handler to:', goBtn);

        // CRITICAL: Remove all existing handlers from the button first
        // Clone the button to remove all listeners, then replace it
        const newGoBtn = goBtn.cloneNode(true);
        goBtn.parentNode.replaceChild(newGoBtn, goBtn);
        goBtn = newGoBtn; // Update reference for Enter key handler below

        // Now attach our handler to the fresh button
        goBtn.addEventListener('click', (e) => {
          console.log('[MASS] Search button clicked, searchFieldsEl.hidden:', searchFieldsEl.hidden);

          if (searchFieldsEl.hidden) {
            console.log('[MASS] Showing search fields and stopping propagation');
            searchFieldsEl.hidden = false;
            // Focus on first field
            if (searchArtistEl) searchArtistEl.focus();
            // Stop the event from reaching any other handlers
            e.stopImmediatePropagation();
            e.preventDefault();
            return; // Don't search yet, just show fields
          } else {
            console.log('[MASS] Search fields already visible, allowing search to proceed');
          }
        }, true); // Use capture phase to run before other handlers
      }

      if (closeBtn && clearBtn && publicPlaylistView) {
        closeBtn.addEventListener('click', () => {
          // Hide the featured playlist view immediately
          publicPlaylistView.hidden = true;
          // Clear search fields and trigger clear button to reload featured albums
          if (searchEl) searchEl.value = '';
          if (searchArtistEl) searchArtistEl.value = '';
          if (searchAlbumEl) searchAlbumEl.value = '';
          if (searchTrackEl) searchTrackEl.value = '';
          clearBtn.click();
        });
      }

      // Debounce utility for search
      function debounce(fn, delay) {
        let timer;
        return function(...args) {
          clearTimeout(timer);
          timer = setTimeout(() => fn.apply(this, args), delay);
        };
      }

      // Allow Enter key to trigger search from any search field
      const searchFields = [searchArtistEl, searchAlbumEl, searchTrackEl].filter(Boolean);

      // Debounced search on input (400ms delay to reduce API calls)
      const debouncedSearch = debounce(() => {
        if (!searchFieldsEl.hidden && goBtn) {
          goBtn.click();
        }
      }, 400);

      searchFields.forEach(field => {
        // Immediate search on Enter key
        field.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            goBtn.click();
          }
        });

        // Debounced search as user types
        field.addEventListener('input', debouncedSearch);
      });

      // Set Recommended Playlists to collapsed by default
      const publicPlaylistsPanel = document.getElementById('publicPlaylistsPanel');
      if (publicPlaylistsPanel) {
        publicPlaylistsPanel.classList.add('collapsed');
      }

      // Accordion functionality for playlist tracks section
      const playlistTracksSection = document.getElementById('playlistTracksSection');
      if (playlistTracksSection) {
        const header = playlistTracksSection.querySelector('.playlists-header');
        if (header) {
          header.addEventListener('click', (e) => {
            // Don't toggle if clicking on a button
            if (e.target.tagName === 'BUTTON' || e.target.closest('.playlist-actions')) return;
            playlistTracksSection.classList.toggle('collapsed');
            localStorage.setItem('playlistTracksCollapsed', playlistTracksSection.classList.contains('collapsed'));
          });
        }
        if (localStorage.getItem('playlistTracksCollapsed') === 'true') {
          playlistTracksSection.classList.add('collapsed');
        }
      }

      // Keep old search field handler for compatibility
      if (searchEl && goBtn) {
        searchEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            goBtn.click();
          }
        });
      }

      // AI Search toggle and close buttons
      const aiSearchClose = document.getElementById('aiSearchClose');
      const aiSearchPanel = document.getElementById('aiSearchPanel');
      const aiSearchToggle = document.getElementById('aiSearchToggle');
      const aiSearchInput = document.getElementById('aiSearchInput');
      const aiSearchButton = document.getElementById('aiSearchButton');
      const aiSearchStatus = document.getElementById('aiSearchStatus');
      const aiSearchStatusText = document.getElementById('aiSearchStatusText');
      const aiSearchInterpretation = document.getElementById('aiSearchInterpretation');

      if (aiSearchToggle && aiSearchPanel) {
        // Toggle button to open/close panel
        aiSearchToggle.addEventListener('click', () => {
          const isCollapsed = aiSearchPanel.getAttribute('data-collapsed') === 'true';
          aiSearchPanel.setAttribute('data-collapsed', isCollapsed ? 'false' : 'true');
          aiSearchToggle.setAttribute('aria-expanded', isCollapsed ? 'true' : 'false');
        });
      }
      if (aiSearchClose && aiSearchPanel && aiSearchToggle) {
        // Close button
        aiSearchClose.addEventListener('click', () => {
          aiSearchPanel.setAttribute('data-collapsed', 'true');
          aiSearchToggle.setAttribute('aria-expanded', 'false');
        });
      }

      // AI Search functionality
      const performAiSearch = async () => {
        const query = aiSearchInput.value.trim();
        if (!query) return;

        try {
          // Show loading state
          if (aiSearchStatus) {
            aiSearchStatus.hidden = false;
            aiSearchStatusText.textContent = 'Asking FileMaker for matches…';
          }
          if (aiSearchInterpretation) aiSearchInterpretation.hidden = true;
          if (aiSearchButton) aiSearchButton.disabled = true;

          // Make API request
          const response = await fetch(`/api/ai-search?q=${encodeURIComponent(query)}`);
          const data = await response.json();

          if (!response.ok) {
            throw new Error(data.error || 'AI search failed');
          }

          // Show interpretation if available
          if (data.interpretation && aiSearchInterpretation) {
            aiSearchInterpretation.textContent = data.interpretation;
            aiSearchInterpretation.hidden = false;
          }

          // Display results
          if (data.albums && data.albums.length > 0) {
            renderAlbums(data.albums);
            if (resultsTitle) resultsTitle.textContent = `AI Search Results (${data.albums.length})`;
          } else {
            albumsEl.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted);">No results found for your query</div>';
            if (resultsTitle) resultsTitle.textContent = 'No Results';
          }

          // Hide loading state
          if (aiSearchStatus) aiSearchStatus.hidden = true;

        } catch (err) {
          console.error('AI Search error:', err);
          if (aiSearchStatus) {
            aiSearchStatusText.textContent = 'Error: ' + err.message;
          }
          albumsEl.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:#ff4444;">Error: ${err.message}</div>`;
        } finally {
          if (aiSearchButton) aiSearchButton.disabled = false;
        }
      };

      if (aiSearchButton && aiSearchInput) {
        aiSearchButton.addEventListener('click', performAiSearch);
        aiSearchInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            performAiSearch();
          }
        });
      }

      // Image lightbox for album artwork (only in modal track view)
      const imageLightbox = document.getElementById('imageLightbox');
      const imageLightboxImg = document.getElementById('imageLightboxImg');
      const imageLightboxClose = document.getElementById('imageLightboxClose');
      const modalOverlay = document.getElementById('overlay');

      if (imageLightbox && imageLightboxImg && imageLightboxClose) {
        // Handle clicks on album artwork
        document.addEventListener('click', (e) => {
          const coverWrap = e.target.closest('.cover-wrap');
          if (coverWrap) {
            const img = coverWrap.querySelector('img');
            if (img && img.src) {
              e.preventDefault();
              e.stopPropagation();

              // Check if cover is in the modal (track view)
              const isInModal = modalOverlay && modalOverlay.classList.contains('open') &&
                                coverWrap.closest('.modal');

              if (isInModal) {
                // In modal: enlarge the image
                imageLightboxImg.src = img.src;
                imageLightbox.classList.add('open');
                imageLightbox.setAttribute('aria-hidden', 'false');
              } else {
                // In grid/random view: search for albums by this artist
                const card = coverWrap.closest('.card');
                if (card) {
                  const artistEl = card.querySelector('.card-artist');
                  if (artistEl) {
                    const artistName = artistEl.textContent.trim();
                    if (artistName) {
                      // Set artist in search field and trigger search
                      const searchArtistEl = document.getElementById('searchArtist');
                      const searchAlbumEl = document.getElementById('searchAlbum');
                      const searchTrackEl = document.getElementById('searchTrack');
                      const searchFieldsEl = document.getElementById('searchFields');
                      const goBtn = document.getElementById('go');

                      if (searchArtistEl && searchFieldsEl && goBtn) {
                        // Clear other fields and set artist
                        searchArtistEl.value = artistName;
                        if (searchAlbumEl) searchAlbumEl.value = '';
                        if (searchTrackEl) searchTrackEl.value = '';

                        // Show fields and trigger search
                        searchFieldsEl.hidden = false;
                        goBtn.click();
                      }
                    }
                  }
                }
              }
            }
          }
        });

        // Close lightbox on click
        const closeLightbox = () => {
          imageLightbox.classList.remove('open');
          imageLightbox.setAttribute('aria-hidden', 'true');
          imageLightboxImg.src = '';
        };

        imageLightboxClose.addEventListener('click', closeLightbox);
        imageLightbox.addEventListener('click', (e) => {
          if (e.target === imageLightbox) closeLightbox();
        });

        // Close on Escape key
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && imageLightbox.classList.contains('open')) {
            closeLightbox();
          }
        });
      }

      // Wake up the FileMaker connection to prevent idle timeout issues
      // This ensures the token is fresh and connection is warm before user tries to play audio
      function wakeUpConnection() {
        fetch('/api/wake', {
          headers: { 'Accept': 'application/json' },
          cache: 'no-cache',
          keepalive: true // Prevent connection from being terminated
        })
        .then(res => res.json())
        .then(data => {
          console.log('[MASS] Connection warmed up:', data.status);
        })
        .catch(err => {
          console.warn('[MASS] Wake call failed:', err);
        });
      }

      // Call on page load
      wakeUpConnection();

      // Also call when page becomes visible again (user returns to tab after being away)
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          console.log('[MASS] Page became visible, warming up connection...');
          wakeUpConnection();
        }
      });

      // Periodically wake the connection to prevent token expiration
      // FileMaker tokens expire after ~11.5 minutes, so wake every 8 minutes (safer than 5 with less overhead)
      setInterval(() => {
        if (!document.hidden) {
          console.log('[MASS] Periodic wake (keeping connection alive)...');
          wakeUpConnection();
        }
      }, 8 * 60 * 1000); // 8 minutes (changed from 5 for better balance)

      // Preload recommended playlists in the background - but only after access token is ready
      window.addEventListener('mass:access-ready', function() {
        // Hide loading indicator once access is ready
        const loadingIndicator = document.getElementById('loadingIndicator');
        if (loadingIndicator) {
          loadingIndicator.setAttribute('hidden', '');
        }

        setTimeout(() => {
          console.log('[Preload] Starting recommended playlists preload');
          fetch('/api/public-playlists', { headers: { 'Accept': 'application/json' } })
            .then(res => res.json())
            .then(data => {
              if (Array.isArray(data?.playlists)) {
                // Preload each recommended playlist's tracks in the background
                data.playlists.forEach((playlist, index) => {
                  if (playlist?.name) {
                    // Stagger the requests to avoid overwhelming the server
                    setTimeout(() => {
                      fetch(`/api/public-playlists?name=${encodeURIComponent(playlist.name)}`, {
                        headers: { 'Accept': 'application/json' }
                      }).catch(err => console.log('Preload failed for', playlist.name));
                    }, index * 500); // 500ms between each preload
                  }
                });
              }
            })
            .catch(err => console.log('Failed to preload recommended playlists'));
        }, 2000); // Wait 2 seconds after access ready before preloading
      });
    });

  // ---- PUBLIC API ----
  window.initializeHomePage = initializeHomePage;
  window.showPlaylistView = showPlaylistView;
  window.showAlbumDetail = showAlbumDetail;
  window.hidePlaylistView = hidePlaylistView;
  window.MADCatalog = {
    initializeHomePage,
    showPlaylistView,
    showAlbumDetail,
    hidePlaylistView
  };

  // Initialize on load
  document.addEventListener('DOMContentLoaded', function() {
    initializeHomePage();
  });
})();
