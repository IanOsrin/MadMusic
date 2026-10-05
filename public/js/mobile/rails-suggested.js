// Home rail: Suggested for You (mobile). Mirrors loadSuggestedForYou in
// js/discovery.js — keep the two in step.
//
// Ten albums picked from this subscriber's own listening (/api/suggested-for-you).
// Called only from the token branch of init (guests have no history); the
// server answers eligible:false until the listener has 100 different songs,
// and the shelf, heading included, stays hidden until there are cards to show.

import { escapeHtml } from './fields.js?v=41';
import { openAlbumAsync } from './cards.js?v=41';

export async function loadSuggestedForYou() {
  const header = document.getElementById('home-sfy-header');
  const container = document.getElementById('home-sfy-content');
  if (!header || !container || window.__PERSONAL_RAIL !== true) return;
  try {
    const res = await fetch('/api/suggested-for-you');
    if (!res.ok) return;
    const data = await res.json();
    const items = ((data && data.eligible && data.items) || []).filter((it) => it.artworkSrc);
    if (!items.length) return;

    container.innerHTML = items.map((it) => `
      <button class="mob-sug-card" data-cat="${escapeHtml(it.catalogue || '')}" data-title="${escapeHtml(it.album)}" data-artist="${escapeHtml(it.artist)}">
        <img class="mob-sug-art" src="${escapeHtml(it.artworkSrc)}" alt="${escapeHtml(it.album)}" loading="lazy" onerror="this.closest('.mob-sug-card').remove()">
        <div class="mob-sug-name">${escapeHtml(it.album)}</div>
        <div class="mob-sug-artist">${escapeHtml(it.artist)}</div>
      </button>`).join('');

    container.querySelectorAll('.mob-sug-card').forEach((btn) => {
      btn.addEventListener('click', () => {
        const { cat, title, artist } = btn.dataset;
        // The page opens at once; the songs fill in. Catalogue first: it returns the album's exact tracks.
        openAlbumAsync({ title, artist, artwork: btn.querySelector('img')?.src || '/img/placeholder.png' }, async () => {
          const r = await fetch(`/api/album?${new URLSearchParams(cat ? { cat } : { title, artist })}`);
          const d = await r.json();
          return d.ok ? d.items || [] : [];
        });
      });
    });
    header.hidden = false;
    container.hidden = false;
  } catch (err) {
    console.warn('[SuggestedForYou] Failed to load:', err);
  }
}
