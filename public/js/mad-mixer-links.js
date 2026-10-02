/* Mad Mixer links — show the 🎚 Mad Mixer button only on tracks Mad Mixer can open.
 *
 * Only songs in the MADMixer database can be mixed. The server works out which MAD tracks
 * those are (ISRC + title check, routes/mixer.js → GET /api/mixer/mixable) and returns
 * { tracks: { recordId: madMixerSongId } }. Track rows (the tracks modal, the artist view's
 * album panel) render the button hidden with data-mix-rec="<recordId>"; this file reveals the
 * ones on that list and points them at the song in Mad Mixer. Rows drawn later are picked up by
 * a debounced MutationObserver. Does nothing unless Mad Mixer is switched on (window.__MAD_MIXER);
 * the buttons need a signed-in listener (guests have no token for the API).
 *
 * Where Mad Mixer lives: window.__MAD_MIXER_URL (server.js, from MIXER_URL) = its own home →
 * plain links to MIXER_URL/?song=<id> (new tab) and MIXER_URL/ for the left-menu item; listeners
 * sign in there with their code. false → Mad Mixer inside MAD, /mixer?song=<id>.
 */
(function () {
  'use strict';
  if (!window.__MAD_MIXER) return;

  const raw = typeof window.__MAD_MIXER_URL === 'string' ? window.__MAD_MIXER_URL : '';
  const home = /^https?:\/\/[^/?#]+(\/[^?#]*)?$/.test(raw) ? raw.replace(/\/+$/, '') : '';
  const songUrl = (song) => (home ? home + '/?song=' : '/mixer?song=') + encodeURIComponent(song);

  // The "Mad Mixer" item in the left menu (app.html) — the way in from MAD.
  function showNavItem() {
    const n = document.getElementById('navMadMixer');
    if (!n) return;
    if (home) {
      n.href = home + '/';
      n.target = '_blank';                        // MAD keeps playing in its own tab
      n.rel = 'noopener';
    }
    n.style.display = '';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showNavItem); else showNavItem();

  let tracks = null;

  function apply() {
    if (!tracks) return;
    document.querySelectorAll('[data-mix-rec]:not([data-mix-done])').forEach((el) => {
      el.setAttribute('data-mix-done', '');
      const song = tracks[el.getAttribute('data-mix-rec')];
      if (!song) return;                          // not a Mad Mixer song — stays hidden
      el.setAttribute('data-mix-song', song);
      if (el.tagName === 'A') el.href = songUrl(song);
      el.style.display = '';
    });
  }

  let timer = 0;
  new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(apply, 150); })
    .observe(document.documentElement, { childList: true, subtree: true });

  // Buttons (tracks modal) open via click; links (album panel) open themselves.
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button[data-mix-song]');
    if (!b) return;
    e.stopPropagation();
    window.open(songUrl(b.getAttribute('data-mix-song')), '_blank', 'noopener');
  }, true);

  let tries = 0;
  async function load() {
    let token = '';
    try { token = localStorage.getItem('mass_access_token') || ''; } catch (_) { /* storage blocked */ }
    if (!token) return;                           // guest — no button
    try {
      const r = await fetch('/api/mixer/mixable');
      const j = await r.json();
      if (j && j.ready) { tracks = j.tracks || {}; apply(); return; }
    } catch (_) { /* try again below */ }
    if (++tries < 6) setTimeout(load, 20000);     // list still being built on the server
  }

  if (window.massAccessReady) load();
  else window.addEventListener('mass:access-ready', (e) => { if (!(e.detail && e.detail.guest)) load(); }, { once: true });
})();
