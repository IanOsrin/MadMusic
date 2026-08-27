// Mobile hero carousel (desktop-parity pass, client 2026-08-26).
// Data flow mirrors app.html's hero: /api/featured-editorial first (16:9
// masters, rendered cover), else new-release albums (square art — ambient
// blur behind, contain in front; never stretched, per docs/banners.md).
// Swipe-driven scroll-snap with dots; auto-advance 6.5s that pauses on touch,
// when the tab is hidden, and entirely under prefers-reduced-motion.
import { state } from './state.js?v=8';
import { getAlbumArtist, getAlbumField, getArtworkUrl, getTitleField } from './fields.js?v=8';
import { showAlbumTracksModal } from './cards.js?v=8';
import { playTrack } from './player.js?v=8';

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
  // A carousel of designed banners gets the shorter, banner-shaped container.
  hero.classList.toggle('editorial', slides.every(s => s.editorial));
  slides.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'mob-hero-slide' + (s.editorial ? ' editorial' : '');
    el.innerHTML = `
      <img class="mob-hero-ambient" src="${esc(s.image)}" alt="" aria-hidden="true">
      <img class="mob-hero-art" src="${esc(s.image)}" alt="${esc(s.title)}" loading="${i ? 'lazy' : 'eager'}">
      ${s.clean ? '' : `<div class="mob-hero-caption"><div class="t">${esc(s.title)}</div><div class="a">${esc(s.subtitle)}</div></div>`}`;
    // a broken banner never shows: drop the slide, like desktop
    el.querySelector('.mob-hero-art').addEventListener('error', () => { el.remove(); });
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

// Editorial target → action, mirroring desktop's editorialAction():
// external opens; track resolves by recordId and plays (a hero track is never
// in the rails below, so lookups-by-card would no-op); album finds the
// catalogue (spaced and despaced — the same album is spelled both ways across
// systems) and opens the album modal.
function editorialAction(it) {
  return async () => {
    const t = String(it.targetType || ''), id = String(it.targetId || '');
    if (t === 'external' && /^https?:\/\//.test(id)) {
      window.open(id, '_blank', 'noopener,noreferrer');
      return;
    }
    if (t === 'track' && id) {
      const track = { recordId: id, fields: {
        'Track Name': it.title || '', 'Track Artist': it.eyebrow || '',
        'Album Artist': it.eyebrow || '', 'Artwork_S3_URL': it.imageUrl || '',
      } };
      state.playlistContext = { tracks: [track], currentIndex: 0, name: it.title || 'Featured', playFn: playTrack };
      playTrack(track);
      return;
    }
    if (t === 'album' && id) {
      for (const cand of [id, id.replace(/\s+/g, '')]) {
        try {
          const r = await fetch('/api/album?cat=' + encodeURIComponent(cand));
          const d = await r.json();
          const items = (d && d.items) || [];
          if (!items.length) continue;
          const f0 = items[0].fields || {};
          const album = {
            title: getAlbumField(f0) || it.title || 'Album',
            artist: getAlbumArtist(f0),
            artwork: getArtworkUrl(f0) || it.imageUrl || '',
            tracks: items,
          };
          window.MADHelpers.sortTracksBySeq(album.tracks);
          showAlbumTracksModal(album);
          return;
        } catch (_) { /* try the next spelling */ }
      }
      console.warn('[MobHero] no album found for catalogue', id);
      return;
    }
    console.warn('[MobHero] unhandled editorial target:', t, id);
  };
}

export function initMobHero() {
  if (started) return;
  started = true;
  // Desktop contract (routes/featured-editorial.js): editorial only counts
  // when source === 'live'; items carry imageUrl/title/eyebrow/textBaked and
  // a target. Anything else → the new-releases fallback slides.
  fetch('/api/featured-editorial?limit=' + MAX_SLIDES, { signal: AbortSignal.timeout(6000) })
    .then(r => r.ok ? r.json() : null).catch(() => null)
    .then(j => {
      const live = j && j.source === 'live' && Array.isArray(j.items) ? j.items : [];
      const slides = live.filter(s => s && s.imageUrl).slice(0, MAX_SLIDES).map(s => ({
        image: s.imageUrl, title: s.title || '', subtitle: s.eyebrow || '',
        editorial: true, clean: s.textBaked !== false,
        onTap: editorialAction(s),
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
