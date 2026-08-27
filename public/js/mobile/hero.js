// Mobile hero carousel (desktop-parity pass, client 2026-08-26).
// Data flow mirrors app.html's hero: /api/featured-editorial first (16:9
// masters, rendered cover), else new-release albums (square art — ambient
// blur behind, contain in front; never stretched, per docs/banners.md).
// Swipe-driven scroll-snap with dots; auto-advance 6.5s that pauses on touch,
// when the tab is hidden, and entirely under prefers-reduced-motion.
import { state } from './state.js';
import { getAlbumArtist, getAlbumField, getArtworkUrl, getTitleField } from './fields.js';
import { showAlbumTracksModal } from './cards.js';

const DWELL_MS = 6500, MAX_SLIDES = 6;
const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let started = false;

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// Rail thumbnails are 300px derivatives — the hero fills the banner, so
// upgrade any resized URL back to the master (no-op when already a master).
function heroRes(url) {
  return String(url || '').replace('/resized/', '/').replace(/_\d+\.webp(\?.*)?$/i, '.jpg$1');
}

function render(slides) {
  const hero = document.getElementById('mobHero');
  const track = document.getElementById('mobHeroTrack');
  const dots = document.getElementById('mobHeroDots');
  if (!hero || !track || !slides.length) return;

  track.innerHTML = '';
  dots.innerHTML = '';
  slides.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'mob-hero-slide' + (s.editorial ? ' editorial' : '');
    el.innerHTML = `
      ${s.editorial ? '' : `<img class="mob-hero-ambient" src="${esc(s.image)}" alt="" aria-hidden="true">`}
      <img class="mob-hero-art" src="${esc(s.image)}" alt="${esc(s.title)}" loading="${i ? 'lazy' : 'eager'}">
      <div class="mob-hero-caption"><div class="t">${esc(s.title)}</div><div class="a">${esc(s.subtitle)}</div></div>`;
    el.addEventListener('click', () => s.onTap && s.onTap());
    track.appendChild(el);
    const d = document.createElement('span');
    if (i === 0) d.classList.add('on');
    dots.appendChild(d);
  });
  hero.hidden = false;

  // dots follow the swipe; auto-advance loops until the user touches it
  let idx = 0, timer = null;
  const setDot = (n) => { [...dots.children].forEach((d, i) => d.classList.toggle('on', i === n)); };
  track.addEventListener('scroll', () => {
    const n = Math.round(track.scrollLeft / track.clientWidth);
    if (n !== idx && n >= 0 && n < slides.length) { idx = n; setDot(n); }
  }, { passive: true });
  const advance = () => {
    idx = (idx + 1) % slides.length;
    track.scrollTo({ left: idx * track.clientWidth, behavior: 'smooth' });
    setDot(idx);
  };
  const arm = () => { if (!REDUCED && slides.length > 1) timer = setInterval(() => { if (!document.hidden) advance(); }, DWELL_MS); };
  const disarm = () => { if (timer) { clearInterval(timer); timer = null; } };
  track.addEventListener('touchstart', disarm, { passive: true });
  track.addEventListener('mousedown', disarm);
  arm();
}

function albumSlides(tracks) {
  const albumMap = new Map();
  (tracks || []).forEach(t => {
    const f = t.fields || t.fieldData || {};
    const title = getAlbumField(f) || getTitleField(f) || 'Unknown Album';
    const artist = getAlbumArtist(f);
    const art = getArtworkUrl(f);
    const key = `${title}|||${artist}`.toLowerCase();
    if (!albumMap.has(key)) albumMap.set(key, { title, artist, artwork: art, tracks: [] });
    albumMap.get(key).tracks.push(t);
  });
  const albums = [...albumMap.values()].filter(a => a.artwork);
  albums.forEach(a => window.MADHelpers.sortTracksBySeq(a.tracks));
  return albums.slice(0, MAX_SLIDES).map(a => ({
    image: heroRes(a.artwork), title: a.title, subtitle: a.artist,
    editorial: false, onTap: () => showAlbumTracksModal(a),
  }));
}

export function initMobHero() {
  if (started) return;
  started = true;
  fetch('/api/featured-editorial', { signal: AbortSignal.timeout(6000) })
    .then(r => r.ok ? r.json() : null).catch(() => null)
    .then(j => {
      const items = (j && (j.slides || j.items)) || [];
      const slides = items.filter(s => s && s.image).slice(0, MAX_SLIDES).map(s => ({
        image: s.image, title: s.title || '', subtitle: s.subtitle || s.artist || '',
        editorial: true,
        onTap: () => { if (s.action === 'external' && s.url) window.open(s.url, '_blank', 'noopener'); },
      }));
      if (slides.length) return render(slides);
      // Fallback: new-release albums — wait for the rail's own load to land.
      let tries = 0;
      const poll = setInterval(() => {
        tries++;
        if (state.newReleaseTracks && state.newReleaseTracks.length) {
          clearInterval(poll);
          render(albumSlides(state.newReleaseTracks));
        } else if (tries > 30) clearInterval(poll);
      }, 500);
    });
}
