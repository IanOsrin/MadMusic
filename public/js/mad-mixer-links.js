/* Mad Mixer links — show the 🎚 Mad Mixer button only on tracks Mad Mixer can open.
 *
 * Only songs in the MADMixer database can be mixed. The server works out which MAD tracks
 * those are (ISRC + title check, routes/mixer.js → GET /api/mixer/mixable) and returns
 * { tracks: { recordId: madMixerSongId } }. Track rows render the button hidden with
 * data-mix-rec="<recordId>"; this file reveals the ones on that list and points them at
 * /mixer?song=<madMixerSongId>. Rows drawn later (search, albums, playlists) are picked up
 * by a debounced MutationObserver. Does nothing unless Mad Mixer is switched on
 * (window.__MAD_MIXER) and the listener is signed in (guests have no token for the API).
 */
(function () {
  'use strict';
  if (!window.__MAD_MIXER) return;

  let tracks = null;

  function apply() {
    if (!tracks) return;
    document.querySelectorAll('[data-mix-rec]:not([data-mix-done])').forEach((el) => {
      el.setAttribute('data-mix-done', '');
      const song = tracks[el.getAttribute('data-mix-rec')];
      if (!song) return;                          // not a Mad Mixer song — stays hidden
      el.setAttribute('data-mix-song', song);
      if (el.tagName === 'A') el.href = '/mixer?song=' + encodeURIComponent(song);
      el.style.display = '';
    });
  }

  let timer = 0;
  new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(apply, 150); })
    .observe(document.documentElement, { childList: true, subtree: true });

  // Buttons (album rows) open via click; links (playlist rows) open themselves.
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button[data-mix-song]');
    if (!b) return;
    e.stopPropagation();
    window.open('/mixer?song=' + encodeURIComponent(b.getAttribute('data-mix-song')), '_blank', 'noopener');
  }, true);

  let tries = 0;
  async function load() {
    let token = '';
    try { token = localStorage.getItem('mass_access_token') || ''; } catch (_) {}
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
