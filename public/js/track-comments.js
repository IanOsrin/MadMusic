/* public/js/track-comments.js — SoundCloud-style timed comments + reactions (client request, 2026-10-12).
 *
 * One script for both players. Each page calls MADComments.attach({...}) with its own elements and
 * getters; this then watches the player on a light 250 ms timer (no hooks into the playback code):
 *   · a dot on the progress bar for every comment, at its moment in the song
 *   · each comment pops up over the bar as the song reaches it
 *   · reactions 🔥 👏 🥲 with counts, a "Comment at 1:23" box (the moment is frozen when you start
 *     typing), and the list — tap a time to jump there, ⋮ to report (or delete your own)
 * Everyone reads; guests are sent to the page's subscribe screen when they try to post or react.
 * Server: routes/comments.js (GET /api/track-comments/:id public; /api/comments/* for subscribers).
 */
(function () {
  'use strict';
  var EMOJI = { fire: '🔥', clap: '👏', tear: '🥲' };
  var cfg = null, trackId = null, data = null, loadSeq = 0, prevT = -1, queue = [], bubbleTimer = null,
      lastDur = 0, composerAt = null, busy = false, pendingBody = null, open = false,
      posted = {};   // trackId → [comment]: your own fresh posts, kept until the server lists them (MAD runs several server copies)

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function mmss(ms) { var s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  function isGuest() { return !!window.__GUEST || !localStorage.getItem('mass_access_token'); }
  function initial(name) { return esc(String(name || '?').trim().charAt(0).toUpperCase() || '?'); }
  function hue(name) { var h = 0; for (var i = 0; i < String(name).length; i++) h = (h * 31 + String(name).charCodeAt(i)) % 360; return h; }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function api(path, method, body) {
    return fetch(path, { method: method || 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.__status = r.status; return j; }); });
  }

  // ── styles (both themes: desktop body.light-mode, mobile prefers-color-scheme / .light) ──────────
  function css() {
    if (document.getElementById('mc-css')) return;
    var s = el('style'); s.id = 'mc-css';
    s.textContent = [
      '.mc-layer{position:absolute;left:0;right:0;top:0;bottom:0;pointer-events:none;z-index:3}',
      '.mc-dot{position:absolute;top:50%;width:9px;height:9px;margin:-4.5px 0 0 -4.5px;border-radius:50%;background:#f59e0b;box-shadow:0 0 0 2px rgba(0,0,0,.35);pointer-events:auto;cursor:pointer;transition:transform .12s}',
      '.mc-dot:hover,.mc-dot.on{transform:scale(1.5)}',
      '.mc-bubble{position:absolute;bottom:calc(100% + 10px);max-width:min(300px,80vw);transform:translateX(-50%);display:flex;gap:8px;align-items:flex-start;padding:7px 11px 7px 7px;border-radius:14px;background:rgba(20,18,26,.92);color:#fff;font-size:12.5px;line-height:1.3;box-shadow:0 6px 20px rgba(0,0,0,.35);pointer-events:none;opacity:0;transition:opacity .2s, transform .2s;z-index:5;white-space:normal;text-align:left}',
      '.mc-bubble.show{opacity:1;transform:translateX(-50%) translateY(-2px)}',
      '.mc-bubble b{display:block;font-size:11px;opacity:.75;font-weight:700}',
      '.mc-av{flex:none;width:24px;height:24px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;color:#fff}',
      '.mc-panel{display:flex;flex-direction:column;gap:10px;font-size:13px;color:inherit;text-align:left}',
      '.mc-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.mc-react{border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;border-radius:999px;padding:4px 10px;font:inherit;cursor:pointer;display:inline-flex;gap:5px;align-items:center}',
      '.mc-react.mine{border-color:#f59e0b;background:rgba(245,158,11,.15)}',
      '.mc-count{margin-left:auto;opacity:.7;font-size:12px}',
      '.mc-box{display:flex;gap:6px}',
      '.mc-box input{flex:1;min-width:0;padding:9px 12px;border-radius:999px;border:1px solid rgba(128,128,128,.35);background:rgba(128,128,128,.1);color:inherit;font:inherit;outline:none}',
      '.mc-box input:focus{border-color:#8b5cf6}',
      '.mc-box button,.mc-btn{border:0;border-radius:999px;padding:8px 14px;background:#8b5cf6;color:#fff;font:inherit;font-weight:700;cursor:pointer}',
      '.mc-btn.ghost{background:transparent;border:1px solid rgba(128,128,128,.4);color:inherit}',
      '.mc-msg{font-size:12px;color:#f59e0b;min-height:0}',
      '.mc-msg:empty{display:none}',
      '.mc-list{display:flex;flex-direction:column;gap:2px;max-height:var(--mc-list-h,320px);overflow-y:auto;overscroll-behavior:contain}',
      '.mc-item{display:flex;gap:9px;padding:7px 4px;border-radius:8px;align-items:flex-start}',
      '.mc-item:hover{background:rgba(128,128,128,.08)}',
      '.mc-item .mc-body{flex:1;min-width:0;overflow-wrap:anywhere}',
      '.mc-item .mc-name{font-weight:700;font-size:12px}',
      '.mc-at{color:#8b5cf6;font-weight:700;font-size:12px;background:none;border:0;padding:0 2px;cursor:pointer;font-family:inherit}',
      '.mc-more{background:none;border:0;color:inherit;opacity:.55;cursor:pointer;font-size:16px;padding:0 4px;line-height:1}',
      '.mc-empty{opacity:.65;font-size:12.5px;padding:6px 2px}',
      '.mc-name-form{display:flex;flex-direction:column;gap:6px;padding:10px;border-radius:10px;background:rgba(139,92,246,.1)}'
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── the song's data ───────────────────────────────────────────────────────────────────────────
  function load(id) {
    var seq = ++loadSeq;
    data = null; render();
    api('/api/track-comments/' + encodeURIComponent(id)).then(function (j) {
      if (seq !== loadSeq) return;
      if (!j.ok) { data = { comments: [], reactions: { fire: 0, clap: 0, tear: 0 }, myReactions: [], me: null, off: j.__status === 404 }; render(); return; }
      var mine = posted[id] || [], have = {};
      j.comments.forEach(function (c) { have[c.id] = true; });
      posted[id] = mine.filter(function (c) { return !have[c.id]; });
      if (posted[id].length) { j.comments = j.comments.concat(posted[id]).sort(function (a, b) { return a.atMs - b.atMs; }); }
      data = j; render();
    }).catch(function () { if (seq === loadSeq) { data = { comments: [], reactions: { fire: 0, clap: 0, tear: 0 }, myReactions: [], me: null, failed: true }; render(); } });
  }

  // ── markers + pop-ups on the progress bar ───────────────────────────────────────────────────────
  function layer() {
    var host = cfg.progressEl(); if (!host) return null;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    var l = host.querySelector(':scope > .mc-layer');
    if (!l) { l = el('div', 'mc-layer'); host.appendChild(l); }
    return l;
  }
  function drawMarkers() {
    var l = layer(); if (!l) return;
    l.innerHTML = '';
    var dur = cfg.getDuration() * 1000;
    lastDur = dur;
    if (!data || !data.comments || !(dur > 0) || data.off) return;
    var seen = {};
    data.comments.forEach(function (c, i) {
      if (c.atMs > dur) return;                         // beyond what's playable (a guest's 30 s preview)
      var pct = (c.atMs / dur) * 100, bucket = Math.round(pct * 1.2);   // one dot per ~0.8% of the bar
      if (seen[bucket] != null) return;
      seen[bucket] = i;
      var d = el('span', 'mc-dot'); d.style.left = pct + '%'; d.style.background = 'hsl(' + hue(c.name) + ',80%,58%)';
      d.title = c.name + ': ' + c.body;
      d.addEventListener('click', function (e) { e.stopPropagation(); e.preventDefault(); showBubble(c, true); });
      d.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      l.appendChild(d);
    });
    var b = el('div', 'mc-bubble'); b.id = 'mc-bubble-' + cfg.name; l.appendChild(b);
  }
  function showBubble(c, pinned) {
    var l = layer(); if (!l) return;
    var b = l.querySelector('.mc-bubble'); if (!b) return;
    var dur = cfg.getDuration() * 1000, pct = dur > 0 ? Math.min(100, (c.atMs / dur) * 100) : 0;
    var w = l.clientWidth || 1, x = Math.max(110, Math.min(w - 110, (pct / 100) * w));
    b.style.left = x + 'px';
    b.innerHTML = '<span class="mc-av" style="background:hsl(' + hue(c.name) + ',55%,45%)">' + initial(c.name) + '</span><span><b>' + esc(c.name) + ' · ' + mmss(c.atMs) + '</b>' + esc(c.body.length > 120 ? c.body.slice(0, 117) + '…' : c.body) + '</span>';
    b.classList.add('show');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(function () { b.classList.remove('show'); bubbleTimer = setTimeout(nextBubble, 250); }, pinned ? 5000 : 3600);
  }
  function nextBubble() { var c = queue.shift(); if (c) showBubble(c); }

  // ── the panel: reactions, the box, the list ─────────────────────────────────────────────────────
  function render() {
    var host = cfg.panelHost(); if (!host) return;
    if (!trackId) { host.innerHTML = ''; return; }
    if (cfg.onCount) cfg.onCount(data && !data.off ? data.comments.length : null);
    if (!data) { host.innerHTML = '<div class="mc-panel"><div class="mc-empty">Loading comments…</div></div>'; return; }
    if (data.off) { host.innerHTML = ''; return; }
    var mine = data.myReactions || [], r = data.reactions || {};
    var reacts = Object.keys(EMOJI).map(function (k) {
      return '<button type="button" class="mc-react' + (mine.indexOf(k) >= 0 ? ' mine' : '') + '" data-react="' + k + '" title="' + (mine.indexOf(k) >= 0 ? 'Take back' : 'React') + '">' + EMOJI[k] + ' <span>' + (r[k] || 0) + '</span></button>';
    }).join('');
    var list = data.comments.length ? data.comments.map(function (c) {
      return '<div class="mc-item" data-id="' + esc(c.id) + '"><span class="mc-av" style="background:hsl(' + hue(c.name) + ',55%,45%)">' + initial(c.name) + '</span>' +
        '<div class="mc-body"><span class="mc-name">' + esc(c.name) + '</span> <button type="button" class="mc-at" data-seek="' + c.atMs + '" title="Play from here">at ' + mmss(c.atMs) + '</button><div>' + esc(c.body) + '</div></div>' +
        '<button type="button" class="mc-more" data-more="' + esc(c.id) + '" title="' + (c.mine ? 'Delete' : 'Report') + '" aria-label="' + (c.mine ? 'Delete your comment' : 'Report this comment') + '">⋮</button></div>';
    }).join('') : '<div class="mc-empty">No comments yet — be the first. Your comment is pinned to the moment you’re at in the song.</div>';
    var guest = isGuest();
    host.innerHTML = '<div class="mc-panel">' +
      '<div class="mc-row">' + reacts + '<span class="mc-count">' + data.comments.length + ' comment' + (data.comments.length === 1 ? '' : 's') + '</span></div>' +
      '<form class="mc-box" autocomplete="off"><input type="text" maxlength="280" placeholder="' + (guest ? 'Subscribe to comment' : 'Comment at ' + mmss(currentMs())) + '" aria-label="Write a comment"' + (guest ? ' readonly' : '') + '><button type="submit">' + (guest ? 'Subscribe' : 'Post') + '</button></form>' +
      '<div class="mc-msg" role="status"></div>' +
      '<div class="mc-list">' + list + '</div></div>';
    wire(host);
  }
  function currentMs() { return Math.round((cfg.getTime() || 0) * 1000); }
  function msg(host, text) { var m = host.querySelector('.mc-msg'); if (m) m.textContent = text || ''; }
  function needSub() { if (cfg.onNeedSignIn) cfg.onNeedSignIn(); }

  function wire(host) {
    var form = host.querySelector('.mc-box'), input = form.querySelector('input');
    if (pendingBody != null) { input.value = pendingBody; }
    input.addEventListener('focus', function () {
      if (isGuest()) { input.blur(); needSub(); return; }
      composerAt = currentMs(); input.placeholder = 'Comment at ' + mmss(composerAt);
    });
    input.addEventListener('blur', function () { if (!input.value) composerAt = null; });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (isGuest()) { needSub(); return; }
      var body = input.value.trim(); if (!body || busy) return;
      post(host, body, composerAt != null ? composerAt : currentMs());
    });
    host.querySelectorAll('[data-react]').forEach(function (b) {
      b.addEventListener('click', function () { if (isGuest()) { needSub(); return; } react(host, b.getAttribute('data-react')); });
    });
    host.querySelectorAll('[data-seek]').forEach(function (b) {
      b.addEventListener('click', function () { cfg.seek(Number(b.getAttribute('data-seek')) / 1000); });
    });
    host.querySelectorAll('[data-more]').forEach(function (b) {
      b.addEventListener('click', function () { more(host, b.getAttribute('data-more')); });
    });
  }

  function post(host, body, atMs) {
    busy = true; msg(host, 'Posting…');
    var id = trackId;
    api('/api/comments/' + encodeURIComponent(id), 'POST', { atMs: atMs, body: body }).then(function (j) {
      busy = false;
      if (j.ok) {
        pendingBody = null; composerAt = null;
        if (id !== trackId || !data) return;
        (posted[id] = posted[id] || []).push(j.comment);
        data.comments.push(j.comment);
        data.comments.sort(function (a, b) { return a.atMs - b.atMs; });
        drawMarkers(); render(); showBubble(j.comment, true);
        return;
      }
      if (j.needsName) { pendingBody = body; askName(host, function () { post(host, body, atMs); }); return; }
      if (j.requiresAccessToken) {
        if (!localStorage.getItem('mass_access_token')) { needSub(); msg(host, ''); return; }
        msg(host, 'Your code isn\u2019t working \u2014 it may have expired. Sign in again (My Account) and try once more.'); return;
      }
      if (j.requiresEmail) { msg(host, 'Add an email address to your code (My Account) to comment.'); return; }
      msg(host, j.error || 'Your comment couldn’t be posted — try again.');
    }).catch(function () { busy = false; msg(host, 'No connection — try again.'); });
  }

  function askName(host, then, current) {
    var box = el('div', 'mc-name-form',
      '<strong>' + (current ? 'Change your comment name' : 'Choose a name for your comments') + '</strong>' +
      '<span style="font-size:12px;opacity:.75">Other listeners see this name next to your comments. Your email and code are never shown.</span>' +
      '<div class="mc-box"><input type="text" maxlength="24" placeholder="e.g. Thabo M" value="' + esc(current || '') + '"><button type="button">Save</button></div>' +
      '<div class="mc-msg"></div>');
    var panel = host.querySelector('.mc-panel') || host;
    panel.insertBefore(box, panel.firstChild);
    var input = box.querySelector('input'), btn = box.querySelector('button');
    input.focus();
    function save() {
      var name = input.value.trim(); if (!name) return;
      btn.disabled = true;
      api('/api/comments/me', 'POST', { name: name }).then(function (j) {
        btn.disabled = false;
        if (!j.ok) { box.querySelector('.mc-msg').textContent = j.error || 'Try another name.'; return; }
        if (data) data.me = { name: j.name };
        box.remove();
        if (then) then(j.name);
      });
    }
    btn.addEventListener('click', save);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  }

  function react(host, emoji) {
    var id = trackId;
    api('/api/comments/' + encodeURIComponent(id) + '/react', 'POST', { emoji: emoji }).then(function (j) {
      if (!j.ok) { if (j.requiresAccessToken && !localStorage.getItem('mass_access_token')) needSub(); else msg(host, j.requiresAccessToken ? 'Your code isn\u2019t working \u2014 sign in again (My Account).' : (j.error || 'Try again.')); return; }
      if (id !== trackId || !data) return;
      data.reactions = j.reactions;
      var mine = (data.myReactions || []).filter(function (k) { return k !== emoji; });
      if (j.on) mine.push(emoji);
      data.myReactions = mine;
      render();
    });
  }

  function more(host, id) {
    var c = data && data.comments.filter(function (x) { return x.id === id; })[0]; if (!c) return;
    if (c.mine) {
      if (!confirm('Delete your comment?')) return;
      api('/api/comments/c/' + encodeURIComponent(id), 'DELETE').then(function (j) {
        if (!j.ok) { msg(host, j.error || 'Try again.'); return; }
        data.comments = data.comments.filter(function (x) { return x.id !== id; });
        if (posted[trackId]) posted[trackId] = posted[trackId].filter(function (x) { return x.id !== id; });
        drawMarkers(); render();
      });
      return;
    }
    if (isGuest()) { needSub(); return; }
    if (!confirm('Report this comment to the MAD team?\n\n“' + c.body + '”')) return;
    api('/api/comments/c/' + encodeURIComponent(id) + '/report', 'POST').then(function (j) {
      msg(host, j.ok ? 'Thanks — the team will take a look.' : (j.error || 'Try again.'));
    });
  }

  // ── the watcher: new song → load; playing → markers follow the duration, comments pop up in turn ──
  function tick() {
    var id = cfg.getTrackId() || null;
    if (id !== trackId) { trackId = id; data = null; queue = []; prevT = -1; if (id) load(id); else render(); drawMarkers(); return; }
    if (!data) return;
    var durMs = cfg.getDuration() * 1000;
    if (durMs > 0 && Math.abs(durMs - lastDur) > 500) drawMarkers();
    var t = currentMs();
    if (prevT >= 0 && t > prevT && t - prevT < 2000 && !cfg.isPaused()) {
      data.comments.forEach(function (c) { if (c.atMs > prevT && c.atMs <= t) queue.push(c); });
      if (queue.length > 3) queue = queue.slice(-3);
      var b = document.getElementById('mc-bubble-' + cfg.name);
      if (queue.length && (!b || !b.classList.contains('show'))) nextBubble();
    }
    prevT = t;
    // keep "Comment at m:ss" honest while nobody is typing
    var host = cfg.panelHost(), input = host && host.querySelector('.mc-box input');
    if (input && document.activeElement !== input && !input.value && !isGuest()) input.placeholder = 'Comment at ' + mmss(t);
  }

  window.MADComments = {
    /** opts: { name, progressEl(), panelHost(), getTrackId(), getTime(), getDuration(), isPaused(), seek(s), onNeedSignIn(), onCount(n) } */
    attach: function (opts) {
      cfg = opts; css();
      setInterval(tick, 250);
      tick();
    },
    /** My Account: change the comment name (or set it). */
    changeName: function (host) {
      api('/api/comments/me').then(function (j) {
        if (!j.ok) { host.textContent = j.requiresEmail ? 'Add an email to your code first.' : (j.error || 'Not available right now.'); return; }
        host.innerHTML = '';
        askName(host, function (name) { host.textContent = 'Saved — your comments now show as “' + name + '”.'; }, j.name || '');
      });
    },
    reload: function () { if (trackId) load(trackId); },
    /** The time/duration/pause/seek getters for a plain <audio> element (both pages use one). */
    forAudio: function (audio) {
      return {
        getTime: function () { return audio.currentTime || 0; },
        getDuration: function () { return isFinite(audio.duration) ? audio.duration : 0; },
        isPaused: function () { return audio.paused; },
        seek: function (s) { audio.currentTime = s; if (audio.paused) audio.play().catch(function () {}); }
      };
    }
  };
})();
