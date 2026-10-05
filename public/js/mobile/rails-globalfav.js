// Global Favourites on Home — a numbered list, as in the MAD Streamer design (step 2,
// 2026-09-28). Same feed as the desktop rail (GET /api/global-favorites, public, SWR-cached):
// tracks flagged Global_Favorites in the catalogue. Every value shown comes from the record —
// rank is just the order the feed returns; the right-hand time is the track's own Duration.
import { state } from './state.js?v=40';
import { getArtworkUrl, getTitleField, getArtistField, getAlbumField, escapeHtml } from './fields.js?v=40';
import { playTrack } from './player.js?v=40';
import { openAlbumForTrack, showArtistTracks } from './cards.js?v=40';

const LIMIT = 10;

function mmss(d) {
  const p = String(d || '').split(':').map(Number);
  if (!p.length || p.some((n) => !Number.isFinite(n))) return '';
  const s = p.reduce((a, n) => a * 60 + n, 0);
  if (!s) return '';
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export async function loadGlobalFavourites() {
  const wrap = document.getElementById('home-gf');
  const list = document.getElementById('home-gf-list');
  if (!wrap || !list) return;
  try {
    const r = await fetch(`/api/global-favorites?limit=${LIMIT}`);
    const d = await r.json();
    const items = (d && d.items) || [];
    if (!items.length) { wrap.hidden = true; return; }
    list.innerHTML = items.map((t, i) => {
      const f = t.fields || {};
      const album = getAlbumField(f);
      return `<button type="button" class="gf-row" data-i="${i}">
          <span class="gf-rank">${i + 1}</span>
          <img class="gf-art" src="${escapeHtml(getArtworkUrl(f))}" alt="" loading="lazy" onerror="this.onerror=null;this.src='/img/placeholder.png'">
          <span class="gf-text">
            <span class="gf-title">${escapeHtml(getTitleField(f) || '')}</span>
            <span class="gf-artist">${[
              getArtistField(f) ? `<span class="gf-link" data-go="artist">${escapeHtml(getArtistField(f))}</span>` : '',
              album ? `<span class="gf-link" data-go="album">${escapeHtml(album)}</span>` : '',
            ].filter(Boolean).join(' · ')}</span>
          </span>
          <span class="gf-time">${escapeHtml(mmss(f.Duration))}</span>
        </button>`;
    }).join('');
    // The song plays; its cover or album name opens the album, its artist opens the artist's
    // songs (client, 2026-09-29).
    list.onclick = (e) => {
      const row = e.target.closest('.gf-row');
      if (!row) return;
      const i = Number(row.dataset.i);
      const go = e.target.closest('.gf-art') ? 'album' : e.target.closest('[data-go]')?.dataset.go;
      if (go === 'album') { openAlbumForTrack(items[i]); return; }
      if (go === 'artist') { showArtistTracks(getArtistField(items[i].fields || {})); return; }
      state.playlistContext = { tracks: items, currentIndex: i, name: 'Global Favourites', playFn: playTrack };
      playTrack(items[i]);
    };
    wrap.hidden = false;
  } catch (err) {
    console.warn('[Mobile] Global Favourites failed:', err);
    wrap.hidden = true;
  }
}
