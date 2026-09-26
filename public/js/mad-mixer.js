/* Mad Mixer adapter — runs after the Stems app (injected by scripts/build-mad-mixer.mjs).
 *
 * The Stems app was written to talk to DCMax's own server with a per-person access code.
 * Inside MAD it talks to /api/mixer instead, and the listener's MAD access token IS the
 * sign-in, so this file:
 *   1. points the app's API_BASE at /api/mixer and adds the MAD token to those calls;
 *   2. signs in automatically (or explains why not: not signed in to MAD / no Mad Mixer tier);
 *   3. opens the MADMixer song given as ?song=<id>, or the song picker (the server resolves
 *      the audio; no raw URLs — and only MADMixer songs can be opened);
 *   4. hides the few buttons that only make sense in the desktop DCMax (→ Restore).
 * The app's top-level `let`s and functions (API_BASE, accessCode, mvsepKey, serverConnected,
 * _renderCreditsPill, loadMvsepModels…) live in the shared global scope, which is why they
 * can be set from here. Every touch is guarded: if the master renames something, Mad Mixer
 * degrades to "sign in" rather than breaking.
 */
(function () {
  'use strict';
  const MIXER = '/api/mixer';
  let token = '';
  try { token = (localStorage.getItem('mass_access_token') || '').trim(); } catch (_) {}

  // 1 · API base + token on every Mad Mixer call ─────────────────────────────
  try { API_BASE = MIXER; } catch (_) {}                    // eslint-disable-line no-undef
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (token && (url.startsWith(MIXER) || url.startsWith(location.origin + MIXER))) {
      init = Object.assign({}, init);
      const h = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
      h.set('X-Access-Token', token);
      h.delete('X-Access-Code');                           // the app's own header — not used here
      init.headers = h;
    }
    return nativeFetch(input, init);
  };

  const $id = (id) => document.getElementById(id);
  function banner(html, kind) {
    let b = $id('mmBanner');
    if (!b) {
      b = document.createElement('div'); b.id = 'mmBanner';
      const header = document.querySelector('header');
      (header && header.parentNode) ? header.parentNode.insertBefore(b, header.nextSibling) : document.body.prepend(b);
    }
    b.className = 'mm-banner' + (kind ? ' mm-' + kind : '');
    b.innerHTML = html;
    b.hidden = !html;
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 2 · sign in with the MAD token ───────────────────────────────────────────
  let signedOut = false;   // arrived with no MAD sign-in → the welcome screen, not the picker
  async function signIn() {
    // No MAD token: still ask — on this Mac (MIXER_DEV_NO_TOKEN) the mixer API works without one.
    // In production it answers 403 and we stay quietly signed out (no banner — Ian, 2026-09-25).
    let r, info = {};
    try { r = await fetch(`${MIXER}/auth`, { method: 'POST' }); info = await r.json().catch(() => ({})); }
    catch (_) { banner('Mad Mixer can’t reach the server right now. Check your connection and reload.', 'warn'); return false; }
    if (r.status === 402) {
      banner('<strong>Mad Mixer is part of the Mad Mixer subscription.</strong> You can open and play audio here, but splitting into stems needs the Mad Mixer tier.', 'upsell');
      return false;
    }
    if (!token && (r.status === 403 || r.status === 400)) { signedOut = true; return false; }
    if (r.status === 403) {
      banner('Your MAD access has expired or isn’t valid on this device. <a href="/">Open MAD</a> to sign in again.', 'warn');
      return false;
    }
    if (!r.ok) { banner('Sign-in to Mad Mixer failed (' + r.status + '). Reload to try again.', 'warn'); return false; }
    try {
      accessCode = token || 'local'; mvsepKey = accessCode; serverConnected = true;   // eslint-disable-line no-undef
      const setup = $id('setupBox'); if (setup) setup.style.display = 'none';
      const dot = $id('serverDot'); if (dot) dot.className = 's-dot ready';
      // The splits count is Mad Mixer's own monthly allowance — only meaningful once the server
      // has an MVSEP key. Until then say so, and keep AI Split off (mixing still works).
      if (typeof _renderCreditsPill === 'function') {                            // eslint-disable-line no-undef
        const appPill = _renderCreditsPill;                                      // eslint-disable-line no-undef
        _renderCreditsPill = function (u) {                                      // eslint-disable-line no-undef
          if (u && u.splitterReady === false) {
            serverConnected = false;                                             // eslint-disable-line no-undef
            const lbl = $id('serverLabel'); if (lbl) lbl.textContent = 'Stem Splitter — not set up yet';
            const d = $id('serverDot'); if (d) d.className = 's-dot';
            const b = $id('btnAiSplit'); if (b) { b.disabled = true; b.title = 'Stem splitting isn’t switched on yet'; }
            return;
          }
          serverConnected = true;                                                // eslint-disable-line no-undef
          const d = $id('serverDot'); if (d) d.className = 's-dot ready';
          const b = $id('btnAiSplit'); if (b) b.title = '';
          if (typeof audioBuf !== 'undefined' && audioBuf && b) b.disabled = false;   // eslint-disable-line no-undef
          appPill(u);
        };
        _renderCreditsPill(info);                                                // eslint-disable-line no-undef
      }
      if (serverConnected && typeof audioBuf !== 'undefined' && audioBuf && $id('btnAiSplit')) $id('btnAiSplit').disabled = false;   // eslint-disable-line no-undef
      if (typeof loadMvsepModels === 'function') loadMvsepModels();             // eslint-disable-line no-undef
    } catch (e) { console.warn('[Mad Mixer] could not hand the sign-in to the app', e); }
    return true;
  }

  // Give the app the audio with its real type. The app's own dc-load-stems path always tags the
  // file audio/wav, so an MP3 showed as "WAV" in the source line; loadFile() takes a File as-is.
  function handToApp(ab, name) {
    const type = /\.mp3$/i.test(name) ? 'audio/mpeg' : 'audio/wav';
    try { if (typeof loadFile === 'function') { loadFile(new File([ab], name, { type })); return; } }   // eslint-disable-line no-undef
    catch (e) { console.warn('[Mad Mixer] direct load failed, using the message path', e); }
    window.postMessage({ type: 'dc-load-stems', ab, name }, location.origin);
  }

  // 3b · the Mad Mixer songs (MADMixer on FM Cloud) ─────────────────────────────
  async function loadSong(id) {
    banner('Loading the song…');
    try {
      const r = await fetch(`${MIXER}/songs/${id}`);
      const s = await r.json().catch(() => ({}));
      if (!r.ok || !s.ok) { banner(esc(s.error || 'That song couldn’t be opened.'), 'warn'); return; }
      const a = await nativeFetch(s.audioUrl);
      if (!a.ok) throw new Error('audio ' + a.status);
      const ab = await a.arrayBuffer();
      handToApp(ab, [s.artist, s.title].filter(Boolean).join(' — ') + '.mp3');
      document.title = `${s.title || 'Song'} · Mad Mixer`;
      banner(`Loaded <strong>${esc(s.title)}</strong>${s.artist ? ' by ' + esc(s.artist) : ''}${s.album ? ' <span class="mm-cat">' + esc(s.album) + '</span>' : ''}.`, 'ok');
    } catch (e) {
      console.warn('[Mad Mixer] song load failed', e);
      banner('The song’s audio couldn’t be loaded.', 'warn');
    }
  }

  let songs = null;
  async function openPicker() {
    let m = $id('mmPicker');
    if (!m) {
      m = document.createElement('div'); m.id = 'mmPicker'; m.className = 'mm-picker'; m.hidden = true;
      m.innerHTML = `<div class="mm-picker-box" role="dialog" aria-label="Mad Mixer songs">
          <div class="mm-picker-head"><strong>Mad Mixer songs</strong><span id="mmPickCount"></span>
            <button class="mm-x" id="mmPickClose" title="Close (Esc)">×</button></div>
          <input id="mmPickSearch" type="search" placeholder="Search by song, artist, album or genre…" autocomplete="off">
          <div class="mm-pick-list" id="mmPickList"><div class="mm-pick-empty">Loading…</div></div>
        </div>`;
      document.body.appendChild(m);
      m.addEventListener('click', (e) => { if (e.target === m) closePicker(); });
      $id('mmPickClose').addEventListener('click', closePicker);
      $id('mmPickSearch').addEventListener('input', renderPicker);
      $id('mmPickList').addEventListener('click', (e) => {
        const row = e.target.closest('[data-song]'); if (!row || row.classList.contains('off')) return;
        closePicker(); loadSong(row.dataset.song);
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !m.hidden) closePicker(); });
    }
    m.hidden = false; $id('mmPickSearch').focus();
    if (!songs) {
      try {
        const r = await fetch(`${MIXER}/songs`); const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || r.status);
        songs = j.songs;
      } catch (e) {
        const msg = /subscription/i.test(e.message) ? esc(e.message) : `Couldn’t load the song list (${esc(e.message)}).`;
        $id('mmPickList').innerHTML = `<div class="mm-pick-empty">${msg}</div>`; return;
      }
    }
    renderPicker();
  }
  // FM durations arrive as "0:05:13", "00:03:06" or "05:48" → "5:13"; zero → blank
  function fmtDur(d) {
    const p = String(d || '').split(':').map(Number);
    if (p.some(isNaN)) return '';
    const sec = p.reduce((a, n) => a * 60 + n, 0);
    if (!sec) return '';
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }
  function closePicker() { const m = $id('mmPicker'); if (m) m.hidden = true; }
  function renderPicker() {
    if (!songs) return;
    const words = $id('mmPickSearch').value.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = songs.filter((s) => { const t = `${s.title} ${s.artist} ${s.album} ${s.genre}`.toLowerCase(); return words.every((w) => t.includes(w)); });
    const playable = songs.filter((s) => s.playable).length;
    $id('mmPickCount').textContent = `${hit.length} of ${songs.length} · ${playable} playable`;
    $id('mmPickList').innerHTML = hit.length ? hit.map((s) => `
      <div class="mm-pick-row${s.playable ? '' : ' off'}" data-song="${esc(s.id)}" title="${s.playable ? 'Open in Mad Mixer' : 'No playable audio yet'}">
        <div class="mm-pick-main"><span class="mm-pick-title">${esc(s.title)}</span><span class="mm-pick-artist">${esc(s.artist)}</span></div>
        <div class="mm-pick-sub">${esc(s.album)}${s.genre ? ' · ' + esc(s.genre) : ''}</div>
        <div class="mm-pick-dur">${s.playable ? esc(fmtDur(s.duration)) : 'no audio yet'}</div>
      </div>`).join('') : '<div class="mm-pick-empty">No songs match.</div>';
  }
  function addSongsButton() {
    const fm = $id('fileMenu');
    if (fm && !$id('mmSongsBtn')) {
      const b = document.createElement('button');
      b.id = 'mmSongsBtn'; b.className = 'btn-file-menu mm-songs-btn'; b.type = 'button';
      b.textContent = '🎵 Songs'; b.title = 'Open a song from the Mad Mixer catalogue';
      b.addEventListener('click', (e) => { e.stopPropagation(); openPicker(); });
      fm.parentNode.insertBefore(b, fm);
    }
  }

  // 3c · arriving cold (no MAD sign-in): Mad Mixer's own front door ─────────────
  // One account for MAD and Mad Mixer: "Sign in" goes to MAD's access page (which also
  // handles email claims and the device limit) and comes straight back here — to the same
  // song, if one was asked for.
  function showWelcome() {
    const song = new URLSearchParams(location.search).get('song');
    const back = '/mixer' + (song && /^\d{1,12}$/.test(song) ? '?song=' + song : '');
    const w = document.createElement('div');
    w.id = 'mmWelcome'; w.className = 'mm-picker mm-welcome';
    w.innerHTML = `<div class="mm-picker-box mm-welcome-box" role="dialog" aria-label="Welcome to Mad Mixer">
        <img class="mm-welcome-logo" src="/img/Madmusiclogonew-dark.png" alt="MAD — Music Africa Direct">
        <h2>Mad Mixer</h2>
        <p>Open South African classics as separate stems — vocals, drums, bass and more.
           Mix them here, or download them to your DAW.</p>
        <a class="mm-welcome-btn" href="/access?next=${encodeURIComponent(back)}">Sign in with your MAD access code</a>
        <p class="mm-welcome-small">No access code yet? The sign-in page also lets you get one.
           <br><a href="/">Or browse Music Africa Direct</a></p>
      </div>`;
    document.body.appendChild(w);
  }

  // 4 · desktop-only bits (the Restore tab doesn't exist in Mad Mixer) ────────
  function hideDesktopOnly() {
    document.querySelectorAll('.dc-max-torestore').forEach((b) => b.remove());
  }
  new MutationObserver(hideDesktopOnly).observe(document.documentElement, { childList: true, subtree: true });

  function boot() {
    hideDesktopOnly();
    addSongsButton();
    signIn().then(() => {
      if (signedOut) return showWelcome();
      // ?song=<MADMixer id> — from a 🎚 Mad Mixer button in MAD (only MADMixer songs have one)
      const song = new URLSearchParams(location.search).get('song');
      if (song && /^\d{1,12}$/.test(song)) return loadSong(song);
      openPicker();                      // no song asked for: start at the song list
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
