// Catalogue search for the mobile app.

import { elements, state } from './state.js';
import { groupTracksByAlbum, hasValidArtwork, hasValidAudio, escapeHtml } from './fields.js';
import { createAlbumCard } from './cards.js';

export async function search(query) {
      try {
        elements.searchResults.innerHTML = '<div class="skeleton-card skeleton"></div><div class="skeleton-card skeleton"></div>';

        // Use 'q' parameter for general search across all fields
        const params = new URLSearchParams({
          q: query,
          limit: 100
        });

        console.log('[Search] Query:', query);
        const response = await fetch(`/api/search?${params}`);
        const data = await response.json();
        console.log('[Search] Results:', data.total || 0, 'tracks found');

        state.searchResults = data.items || [];
        renderSearchResults();
      } catch (err) {
        console.error('[Search] Failed:', err);
        elements.searchResults.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><p>Search failed</p></div>';
      }
    }

export function renderSearchResults() {
      elements.searchResults.innerHTML = '';
      resetArtistBio(); // clear any previous artist bio before re-rendering

      // Filter to only show tracks with valid audio AND valid artwork
      const validResults = state.searchResults.filter(track => hasValidAudio(track) && hasValidArtwork(track));

      if (validResults.length === 0) {
        if (state.searchResults.length > 0) {
          elements.searchResults.innerHTML = '<div class="empty-state"><p>No results with audio and artwork available</p></div>';
        } else {
          elements.searchResults.innerHTML = '<div class="empty-state"><p>No results found</p></div>';
        }
        return;
      }

      // Group search results by album
      const albums = groupTracksByAlbum(validResults);

      albums.forEach(album => {
        const card = createAlbumCard(album);
        elements.searchResults.appendChild(card);
      });

      // Artist biography above the albums — shown only when the search clearly
      // resolves to one dominant artist (i.e. an artist search, not a keyword).
      maybeShowArtistBio(albums);
    }

// ── Artist biography (mobile) ────────────────────────────────────────────────
// Mobile has no dedicated artist view; when a search resolves to a single
// dominant artist, the flat album grid IS that artist's albums, so we render the
// bio (FM API_Artist_Bio via /api/artist-bio) above it. Reuses the same endpoint
// as desktop; the server returns { found:false } for un-curated artists.

function resetArtistBio() {
  const box = document.getElementById('mobile-artist-bio');
  if (box) { box.hidden = true; box.innerHTML = ''; box.classList.remove('expanded'); }
}

function maybeShowArtistBio(albums) {
  const box = document.getElementById('mobile-artist-bio');
  if (!box || window.__ARTIST_BIO === false || !albums.length) return;

  // Dominant album-artist across the result albums.
  const counts = new Map();
  for (const a of albums) {
    const key = (a.artist || '').trim();
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  let top = '', topN = 0;
  for (const [key, n] of counts) if (n > topN) { top = key; topN = n; }

  // Only treat it as an artist search when one artist owns the majority of the
  // albums — avoids showing a bio on a broad keyword/track search.
  if (!top || topN / albums.length < 0.6) return;

  loadArtistBioMobile(top, box);
}

async function loadArtistBioMobile(name, box) {
  try {
    const r = await fetch('/api/artist-bio?name=' + encodeURIComponent(name));
    if (!r.ok) return;
    const data = await r.json();
    if (!data || !data.found || !data.artist) return;
    const a = data.artist;
    const photo = a.imageUrl
      ? `<img class="mab-photo" src="/api/container?u=${encodeURIComponent(a.imageUrl)}" alt="${escapeHtml(a.name)}" onerror="this.remove()">`
      : '';
    const country = a.country ? `<span class="mab-country">${escapeHtml(a.country)}</span>` : '';
    box.innerHTML =
      photo +
      '<div class="mab-body">' +
        `<div class="mab-head"><span class="mab-label">About ${escapeHtml(a.name)}</span>${country}</div>` +
        `<div class="mab-text">${escapeHtml(a.bio)}</div>` +
        '<button type="button" class="mab-toggle">Read more</button>' +
      '</div>';
    box.hidden = false;
    const textEl = box.querySelector('.mab-text');
    const toggle = box.querySelector('.mab-toggle');
    requestAnimationFrame(() => {
      if (textEl.scrollHeight <= textEl.clientHeight + 4) toggle.style.display = 'none';
    });
    toggle.addEventListener('click', () => {
      const expanded = box.classList.toggle('expanded');
      toggle.textContent = expanded ? 'Read less' : 'Read more';
    });
  } catch (e) { /* silent — no bio is a fine default */ }
}
