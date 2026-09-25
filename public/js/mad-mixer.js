/* Mad Mixer adapter — runs after the Stems app (injected by scripts/build-mad-mixer.mjs).
 *
 * The Stems app was written to talk to DCMax's own server with a per-person access code.
 * Inside MAD it talks to /api/mixer instead, and the listener's MAD access token IS the
 * sign-in, so this file:
 *   1. points the app's API_BASE at /api/mixer and adds the MAD token to those calls;
 *   2. signs in automatically (or explains why not: not signed in to MAD / no Mad Mixer tier);
 *   3. opens the track given as ?t=<recordId> (the server resolves the audio; no raw URLs);
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
  async function signIn() {
    if (!token) return false;   // no banner (Ian, 2026-09-25) — the pill still reads "Sign in to enable"
    let r, info = {};
    try { r = await fetch(`${MIXER}/auth`, { method: 'POST' }); info = await r.json().catch(() => ({})); }
    catch (_) { banner('Mad Mixer can’t reach the server right now. Check your connection and reload.', 'warn'); return false; }
    if (r.status === 402) {
      banner('<strong>Mad Mixer is part of the Mad Mixer subscription.</strong> You can open and play audio here, but splitting into stems needs the Mad Mixer tier.', 'upsell');
      return false;
    }
    if (r.status === 403) {
      banner('Your MAD access has expired or isn’t valid on this device. <a href="/">Open MAD</a> to sign in again.', 'warn');
      return false;
    }
    if (!r.ok) { banner('Sign-in to Mad Mixer failed (' + r.status + '). Reload to try again.', 'warn'); return false; }
    try {
      accessCode = token; mvsepKey = token; serverConnected = true;   // eslint-disable-line no-undef
      const setup = $id('setupBox'); if (setup) setup.style.display = 'none';
      const dot = $id('serverDot'); if (dot) dot.className = 's-dot ready';
      if (typeof _renderCreditsPill === 'function') _renderCreditsPill(info);     // eslint-disable-line no-undef
      if (typeof audioBuf !== 'undefined' && audioBuf && $id('btnAiSplit')) $id('btnAiSplit').disabled = false;   // eslint-disable-line no-undef
      if (typeof loadMvsepModels === 'function') loadMvsepModels();             // eslint-disable-line no-undef
    } catch (e) { console.warn('[Mad Mixer] could not hand the sign-in to the app', e); }
    return true;
  }

  // 3 · open the track passed as ?t=<recordId> ────────────────────────────────
  async function openTrack() {
    const t = new URLSearchParams(location.search).get('t');
    if (!t || !/^\d{1,12}$/.test(t) || !token) return;
    banner('Loading the track from the MAD catalogue…');
    try {
      const r = await fetch(`${MIXER}/track/${t}`);
      const meta = await r.json().catch(() => ({}));
      if (!r.ok || !meta.ok) { banner(esc(meta.error || 'That track couldn’t be opened.') + ' You can still open your own audio with <b>Open Audio</b>.', 'warn'); return; }
      const a = await nativeFetch(meta.audioUrl);
      if (!a.ok) throw new Error('audio ' + a.status);
      const ab = await a.arrayBuffer();
      const name = [meta.artist, meta.title].filter(Boolean).join(' — ') || 'MAD track';
      window.postMessage({ type: 'dc-load-stems', ab, name: name + '.mp3' }, location.origin);
      document.title = `${meta.title || 'Track'} · Mad Mixer`;
      banner(`Loaded <strong>${esc(meta.title)}</strong>${meta.artist ? ' by ' + esc(meta.artist) : ''}${meta.catalogue ? ' <span class="mm-cat">' + esc(meta.catalogue) + '</span>' : ''}. Press <b>AI Split</b> to separate it into stems.`, 'ok');
    } catch (e) {
      console.warn('[Mad Mixer] track load failed', e);
      banner('The track’s audio couldn’t be loaded. You can still open your own audio with <b>Open Audio</b>.', 'warn');
    }
  }

  // 4 · desktop-only bits (the Restore tab doesn't exist in Mad Mixer) ────────
  function hideDesktopOnly() {
    document.querySelectorAll('.dc-max-torestore').forEach((b) => b.remove());
  }
  new MutationObserver(hideDesktopOnly).observe(document.documentElement, { childList: true, subtree: true });

  function boot() {
    hideDesktopOnly();
    signIn().then(openTrack);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
