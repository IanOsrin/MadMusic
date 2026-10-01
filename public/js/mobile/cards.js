// Album/track card builders + their modals for the mobile app.

import { elements, state } from './state.js?v=37';
import { escapeHtml, getAlbumArtist, getAlbumField, getArtistField, getArtworkUrl, getGenreField, getTitleField } from './fields.js?v=37';
import { switchTab } from './nav.js?v=37';
import { search } from './search.js?v=37';
import { closeModal, playTrack, renderPlayerQueue } from './player.js?v=37';
import { pushOverlay, replaceOverlay } from './router.js?v=37';
import { showToast } from './util.js?v=37';

// ── Shared album tile (the New Releases / G100 look) ─────────────────────────
// One square-cover tile: first tap reveals the title/artist overlay, second tap
// opens the tracks modal (or a custom onOpen), the ▶ plays with the album as
// the queue (or a custom onPlay). Every album surface uses THIS so the app has
// one visual language — don't hand-roll new card markups.
let _tileDismissArmed = false;
function armTileOverlayDismiss() {
      if (_tileDismissArmed) return;
      _tileDismissArmed = true;
      // Dismiss open overlays when tapping OUTSIDE any tile. Must ignore taps
      // on tiles themselves: this runs in the capture phase (before the tile's
      // own handler), and the old version stripped overlay-active from the very
      // card being tapped — which silently broke second-tap-opens-tracks on
      // New Releases/G100 (every tap registered as a first tap).
      document.addEventListener('click', (e) => {
        if (e.target.closest && e.target.closest('.nr-album-card')) return;
        document.querySelectorAll('.nr-album-card.overlay-active').forEach(c => c.classList.remove('overlay-active'));
      }, { capture: true });
    }

export function createAlbumTile(album, opts = {}) {
      const { badge = '', badgeClass = 'nr-new-badge', playBtnStyle = '', countBadgeKey = null, onOpen = null, onPlay = null, openOnTap = false } = opts;
      armTileOverlayDismiss();

      const card = document.createElement('div');
      card.className = 'nr-album-card';

      const trackCount = album.tracks.length;
      const trackLabel = trackCount === 1 ? 'track' : 'tracks';
      const playSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;

      card.innerHTML = `
        <img class="nr-album-artwork" src="${escapeHtml(album.artwork)}" alt="${escapeHtml(album.title)}" loading="lazy" onerror="this.onerror=null;this.src='/img/placeholder.png'">
        <div class="nr-card-caption"><div class="t">${escapeHtml(album.artist || '')}</div><div class="a">${escapeHtml(album.title)}</div></div>
        ${badge ? `<span class="${badgeClass}">${escapeHtml(badge)}</span>` : ''}
        <div class="nr-card-overlay">
          <div class="nr-overlay-title">${escapeHtml(album.title)}</div>
          <div class="nr-overlay-artist">${escapeHtml(album.artist)}</div>
          <div class="nr-overlay-actions">
            <span class="nr-track-count"${countBadgeKey ? ` data-album-key="${escapeHtml(countBadgeKey)}"` : ''}><span class="nr-count-num">${trackCount}</span> ${trackLabel}</span>
            ${trackCount > 0 || onPlay ? `<button class="nr-play-btn"${playBtnStyle ? ` style="${playBtnStyle}"` : ''} title="Play">${playSVG}</button>` : ''}
          </div>
        </div>
      `;

      // One tap, everywhere (client, 2026-09-29): the cover or the album name opens the album's
      // songs; the ARTIST name under the cover opens that artist's songs. The old first-tap
      // "reveal the overlay" step read as "nothing happened". (`openOnTap` is now the only mode;
      // the option is kept so existing callers still read naturally.)
      void openOnTap;
      card.addEventListener('click', (e) => {
        if (e.target.closest('.nr-play-btn')) return;
        const artistEl = e.target.closest('.nr-card-caption .t, .nr-overlay-artist');
        if (artistEl && album.artist && album.artist !== 'My playlist') {
          e.stopPropagation();
          showArtistTracks(album.artist);
          return;
        }
        (onOpen || showAlbumTracksModal)(album);
      });

      const playBtn = card.querySelector('.nr-play-btn');
      if (playBtn) {
        playBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (onPlay) onPlay(album);
          else if (album.tracks.length > 0) {
            state.playlistContext = { tracks: album.tracks, currentIndex: 0, name: album.title, playFn: playTrack };
            playTrack(album.tracks[0]);
            upgradeQueueToFullAlbum(album, album.tracks[0]);
          }
          card.classList.remove('overlay-active');
        });
      }

      return card;
    }

// Feed-built album objects often carry only the feed's SUBSET of the album's
// tracks (new releases ships ~1 track per album), which left the player queue
// one track deep and skips dead. After playback starts, swap the queue for the
// real album from /api/album — silently, without interrupting the audio.
const fullAlbumCache = new Map();
// The whole album (search results only carry the tracks that matched), cached per album.
async function fetchFullAlbum(album) {
      const key = `${album.title}|||${album.artist}`.toLowerCase();
      let full = fullAlbumCache.get(key);
      if (!full) {
        try {
          const res = await fetch(`/api/album?${new URLSearchParams({ title: album.title, artist: album.artist })}`);
          const data = await res.json();
          full = (data.ok && data.items?.length) ? { ...album, tracks: data.items } : album;
        } catch { full = album; }
        fullAlbumCache.set(key, full);
      }
      return full;
    }

// Open an album from a search result: show what we have at once, then swap in the full
// track list when it arrives (only if that album's sheet is still the one showing).
export async function openFullAlbum(album) {
      showAlbumTracksModal(album);
      const full = await fetchFullAlbum(album);
      const stillOpen = elements.modalOverlay.classList.contains('show') &&
        elements.bottomSheet.dataset.albumKey === `${album.title}|||${album.artist}`;
      if (stillOpen && full.tracks.length > album.tracks.length) showAlbumTracksModal(full, { refresh: true });
    }

export async function upgradeQueueToFullAlbum(album, playingTrack) {
      const full = await fetchFullAlbum(album);
      // Only swap if the user is still on the track this play started
      if (state.currentTrack !== playingTrack) return;
      if (!full.tracks || full.tracks.length <= (state.playlistContext?.tracks?.length || 0)) return;
      const idx = full.tracks.findIndex(t => t.recordId === playingTrack.recordId);
      state.playlistContext = { tracks: full.tracks, currentIndex: idx >= 0 ? idx : 0, name: album.title, playFn: playTrack };
      renderPlayerQueue();
    }

export function renderAlbumTileGrid(container, albums, optsFor = () => ({})) {
      const grid = document.createElement('div');
      grid.className = 'nr-album-grid';
      albums.forEach(album => grid.appendChild(createAlbumTile(album, optsFor(album))));
      container.appendChild(grid);
      return grid;
    }

// "3:05" from FileMaker's "00:03:05" — blank when the record has no duration (nothing invented).
function trackTime(d) {
  const p = String(d || '').split(':').map(Number);
  if (!p.length || p.some((n) => !Number.isFinite(n))) return '';
  const secs = p.reduce((a, n) => a * 60 + n, 0);
  return secs ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : '';
}

// Album / playlist page — MAD Streamer design, step 5 (2026-09-28): a header with the square
// cover over its own blurred copy (square art is never stretched — docs/banners.md), the kind
// label, big title and artist; a wide gradient Play; numbered tracks with their real length.
// Hooks kept for the rest of the app: [data-track-index] rows, [data-basket-add] buttons
// (basket.js), .bs-close-btn (the suggestions rail inserts itself before it).
export function showAlbumTracksModal(album, { refresh = false } = {}) {
      elements.bottomSheet.dataset.albumKey = `${album.title}|||${album.artist}`;
      const art = album.artwork || '/img/placeholder.png';
      const kind = album.kind || (album.artist === 'My playlist' ? 'PLAYLIST' : 'ALBUM');
      const count = album.tracks.length;
      elements.bottomSheet.innerHTML = `
        <div class="alb-hero">
          <img class="alb-hero-bg" src="${escapeHtml(art)}" alt="" aria-hidden="true" onerror="this.remove()">
          <div class="alb-hero-row">
            <img class="alb-cover" src="${escapeHtml(art)}" alt="" onerror="this.onerror=null;this.src='/img/placeholder.png'">
            <div class="alb-meta">
              <div class="alb-kind">${escapeHtml(kind)}</div>
              <div class="bottom-sheet-header alb-title">${escapeHtml(album.title)}</div>
              <div class="alb-artist${kind === 'ALBUM' && album.artist ? ' alb-artist-link' : ''}">${escapeHtml(album.artist)}</div>
              <div class="alb-count">${count} ${count === 1 ? 'song' : 'songs'}</div>
            </div>
          </div>
        </div>
        ${count ? `<button type="button" class="alb-play" data-play-all>
          <svg width="13" height="14" viewBox="0 0 13 14" fill="currentColor" aria-hidden="true"><path d="M2 1.6 12 7 2 12.4z"/></svg>Play</button>` : ''}
        <div class="alb-tracks">
        ${album.tracks.map((track, index) => {
          const fields = track.fields || {};
          const trackTitle = getTitleField(fields);
          // On an artist page every row is the same artist — show which album each song is from.
          const trackArtist = kind === 'ARTIST' ? getAlbumField(fields) : getArtistField(fields);
          // Downloads are sold per track; the basket pays for several at once.
          // Never inside the native shell — store rules forbid it (see
          // native-purchase-guards.test.js).
          const price = parseFloat(fields['Download_Price'] || fields['DownloadPrice'] || 0) || 0;
          const sellable = price > 0 && !document.documentElement.classList.contains('native-app');
          return `
            <div class="alb-row">
              <button class="bottom-sheet-option alb-track" data-track-index="${index}">
                <span class="alb-no">${index + 1}</span>
                <span class="alb-t"><span class="alb-tt">${escapeHtml(trackTitle)}</span>${trackArtist ? `<span class="alb-ta">${escapeHtml(trackArtist)}</span>` : ''}</span>
                <span class="alb-dur">${escapeHtml(trackTime(fields.Duration))}</span>
              </button>
              ${sellable ? `<button class="btn btn-secondary alb-basket" data-basket-add
                data-record-id="${escapeHtml(track.recordId || '')}"
                data-price="${price}"
                data-name="${escapeHtml(trackTitle)}"
                data-artist="${escapeHtml(getArtistField(fields) || album.artist || '')}">+ Basket · R${price.toFixed(2)}</button>` : ''}
            </div>
          `;
        }).join('')}
        </div>
        <button class="btn btn-secondary bs-close-btn" onclick="closeModal()">Close</button>
      `;

      // A refresh is the same sheet; a sheet opened from inside another sheet takes over its
      // history entry — either way one Back closes it.
      const sheetOpen = elements.modalOverlay.classList.contains('show');
      elements.modalOverlay.classList.add('show');
      if (!refresh) {
        const st = history.state;
        // …or opened from Now Playing, which has just been put away but still owns the entry.
        const fromPlayer = st && st.overlay && st.overlay.type === 'player' && !elements.playerModal.classList.contains('show');
        if (st && st.mad && st.kind === 'overlay' && (sheetOpen || fromPlayer)) replaceOverlay('album-tracks', album.recordId || album.title);
        else pushOverlay('album-tracks', album.recordId || album.title);
      }

      const playFrom = (trackIndex) => {
        state.playlistContext = { tracks: album.tracks, currentIndex: trackIndex, name: album.title, playFn: playTrack };
        playTrack(album.tracks[trackIndex]);
        if (kind === 'ALBUM') upgradeQueueToFullAlbum(album, album.tracks[trackIndex]);
        closeModal();
      };
      // The artist's name in an album header opens that artist's songs.
      elements.bottomSheet.querySelector('.alb-artist-link')?.addEventListener('click', () => showArtistTracks(album.artist));
      elements.bottomSheet.querySelector('[data-play-all]')?.addEventListener('click', () => playFrom(0));
      elements.bottomSheet.querySelectorAll('[data-track-index]').forEach(btn => {
        btn.addEventListener('click', () => playFrom(parseInt(btn.dataset.trackIndex)));
      });

      // Append suggestions rail asynchronously — doesn't block the modal opening.
      if (window.__SUGGESTIONS !== false && kind === 'ALBUM') {
        appendMobileSuggestions(elements.bottomSheet, album);
      }
    }

async function appendMobileSuggestions(sheet, album) {
  const closeBtn = sheet.querySelector('.bs-close-btn');
  if (!closeBtn) return;

  // Placeholder shown immediately; replaced with cards or removed on completion.
  const rail = document.createElement('div');
  rail.className = 'mob-suggestions';
  rail.innerHTML = `<div class="mob-suggestions-title">You might also like</div>
    <div class="mob-suggestions-scroll"><div class="mob-suggestions-loading">Loading…</div></div>`;
  sheet.insertBefore(rail, closeBtn);

  try {
    const params = new URLSearchParams({ title: album.title, artist: album.artist, limit: 6 });
    const res = await fetch(`/api/suggestions?${params}`);
    const data = await res.json();

    // Rail may have been removed by a new modal tap — bail if stale.
    if (!rail.isConnected) return;

    // Defensive: drop sleeveless suggestions (placeholder art reads as broken).
    // The backend already excludes cover-less albums; this guards a stale index.
    const sugItems = (data.items || []).filter(item => item.artworkSrc);
    if (!data.ok || !sugItems.length) { rail.remove(); return; }

    const scroll = rail.querySelector('.mob-suggestions-scroll');
    scroll.innerHTML = sugItems.map(item => `
      <button class="mob-sug-card" data-title="${escapeHtml(item.album)}" data-artist="${escapeHtml(item.artist)}">
        <img class="mob-sug-art" src="${escapeHtml(item.artworkSrc || '/img/placeholder.png')}"
             alt="${escapeHtml(item.album)}" loading="lazy" onerror="this.src='/img/placeholder.png'">
        <div class="mob-sug-name">${escapeHtml(item.album)}</div>
        <div class="mob-sug-artist">${escapeHtml(item.artist)}</div>
      </button>
    `).join('');

    scroll.querySelectorAll('.mob-sug-card').forEach(btn => {
      btn.addEventListener('click', async () => {
        const title = btn.dataset.title;
        const artist = btn.dataset.artist;
        const cacheKey = `${title}|||${artist}`.toLowerCase();
        const cached = state.discoverAlbumCache.get(cacheKey);
        if (cached) { showAlbumTracksModal(cached); return; }

        btn.disabled = true;
        try {
          const r = await fetch(`/api/album?${new URLSearchParams({ title, artist })}`);
          const d = await r.json();
          if (d.ok && d.items?.length) {
            const sugAlbum = { title, artist, artwork: btn.querySelector('img').src, tracks: d.items };
            state.discoverAlbumCache.set(cacheKey, sugAlbum);
            showAlbumTracksModal(sugAlbum);
          }
        } finally {
          btn.disabled = false;
        }
      });
    });
  } catch {
    if (rail.isConnected) rail.remove();
  }
}

// ── Artist page (client, 2026-09-29: "clicking the artist should open the songs associated with
// the artist") ── the album-page design, labelled ARTIST, listing the artist's songs from the
// catalogue (/api/search?artist=, which matches the artist fields). Play plays them in order.
export async function showArtistTracks(name) {
      // "X feat. Y" names a single song's line-up; the artist page is X's.
      const artist = String(name || '').replace(/\s+(feat\.?|ft\.?|featuring)\s.*$/i, '').trim();
      if (!artist) return;
      const load = async (a) => {
        const r = await fetch(`/api/search?${new URLSearchParams({ artist: a, limit: '100' })}`);
        if (!r.ok) return null;
        const d = await r.json();
        return (d && d.items) || [];
      };
      try {
        // Names carrying characters the search refuses (e.g. "&", "*") are retried without them.
        let tracks = await load(artist);
        if (tracks === null) tracks = (await load(artist.replace(/[^\p{L}\p{N}\s'.-]/gu, ' ').replace(/\s+/g, ' ').trim())) || [];
        if (!tracks.length) { showToast(`No songs found for ${artist}`, 'error'); return; }
        const withArt = tracks.find((t) => getArtworkUrl(t.fields || {}));
        showAlbumTracksModal({
          kind: 'ARTIST',
          title: artist,
          artist: 'Songs by this artist',
          artwork: withArt ? getArtworkUrl(withArt.fields) : '/img/placeholder.png',
          tracks,
        });
      } catch (err) {
        console.warn('[Mobile] Artist page failed:', err);
        showToast('Could not load this artist just now', 'error');
      }
    }

// The album a single track belongs to (Now Playing, Global Favourites, "Pick up where you left
// off"): open it at once with what we have, then the full track list replaces it.
export function openAlbumForTrack(track) {
      const f = (track && track.fields) || {};
      const title = getAlbumField(f);
      if (!title) { showToast('No album details for this song', 'error'); return; }
      openFullAlbum({ title, artist: getAlbumArtist(f), artwork: getArtworkUrl(f) || '/img/placeholder.png', tracks: [track] });
    }

export function showMobileArtistPrompt(artistName) {
      document.getElementById('mobileArtistPrompt')?.remove();

      const overlay = document.createElement('div');
      overlay.id = 'mobileArtistPrompt';
      overlay.className = 'mobile-artist-prompt-overlay';
      overlay.innerHTML = `
        <div class="mobile-artist-prompt-box">
          <p class="mobile-artist-prompt-q">See all albums by</p>
          <p class="mobile-artist-prompt-name">${escapeHtml(artistName)}</p>
          <div class="mobile-artist-prompt-actions">
            <button class="mobile-artist-prompt-btn mobile-artist-yes">Yes, search</button>
            <button class="mobile-artist-prompt-btn mobile-artist-no">Dismiss</button>
          </div>
        </div>
      `;
      overlay.querySelector('.mobile-artist-yes').addEventListener('click', () => {
        overlay.remove();
        // Switch to search tab and pre-fill with artist name
        const searchInput = document.getElementById('search-input');
        if (searchInput) searchInput.value = artistName;
        switchTab('search');
        if (typeof search === 'function') search(artistName);
      });
      overlay.querySelector('.mobile-artist-no').addEventListener('click', () => overlay.remove());
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      document.body.appendChild(overlay);
    }
