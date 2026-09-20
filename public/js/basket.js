/**
 * basket.js — buy several downloads in one payment.
 *
 * Paying per track was what stopped people buying more than one (Ian,
 * 2026-09-21). The basket collects tracks in the BROWSER (so guests and
 * subscribers alike can fill one without signing in), then pays for the lot in
 * a single Paystack transaction.
 *
 * Everything after the payment stays per track — a purchase record each, a link
 * each, three downloads each — so a failed download costs one track rather than
 * the whole basket. The single-track ⬇ Download button is untouched.
 *
 * Self-wiring: it listens for clicks on [data-basket-add] anywhere in the page,
 * reading the track from data attributes, so new rails and rebuilt lists need no
 * extra code.
 */
(function () {
  'use strict';

  var KEY = 'mad_basket';
  var PENDING = 'mad_basket_pending';   // survives the trip to Paystack

  // ── store ─────────────────────────────────────────────────────────────────
  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; }
  }
  function write(items) {
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) { /* private mode */ }
    render();
  }
  function has(id) { return read().some(function (i) { return i.recordId === id; }); }
  function total(items) {
    return (items || read()).reduce(function (sum, i) { return sum + (Number(i.price) || 0); }, 0);
  }

  function add(item) {
    if (blocked()) return;
    if (!item || !item.recordId || !(Number(item.price) > 0)) return;
    var items = read();
    if (items.some(function (i) { return i.recordId === item.recordId; })) return;
    items.push({
      recordId: String(item.recordId),
      name: item.name || 'Track',
      artist: item.artist || '',
      price: Number(item.price) || 0,
    });
    write(items);
    toast('Added to basket — ' + items.length + ' track' + (items.length === 1 ? '' : 's'));
  }
  function remove(id) {
    write(read().filter(function (i) { return i.recordId !== id; }));
  }

  function toast(msg, kind) {
    // Desktop and mobile name their toast differently.
    if (typeof window.MADShowToast === 'function') window.MADShowToast(msg, kind || 'success');
    else if (typeof window.showToast === 'function') window.showToast(msg, kind || 'success');
  }

  // Inside the native app wrappers no purchase may happen outside store billing,
  // so the basket hides itself there — the same rule the Buy Access buttons
  // follow, applied in JS because markup-only hiding has been reached around
  // before (mobile.html, native-purchase-guards).
  function blocked() {
    return document.documentElement.classList.contains('native-app');
  }
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
  var rands = function (n) { return 'R' + (Number(n) || 0).toFixed(2); };

  // ── the button that lives in the corner ───────────────────────────────────
  function shell() {
    var el = document.getElementById('madBasketBtn');
    if (el) return el;
    el = document.createElement('button');
    el.id = 'madBasketBtn';
    el.type = 'button';
    el.setAttribute('aria-label', 'Download basket');
    el.style.cssText = [
      'position:fixed', 'right:18px', 'bottom:96px', 'z-index:3500',
      'background:var(--accent,#8b5cf6)', 'color:#fff', 'border:none', 'border-radius:999px',
      'padding:12px 18px', 'font-size:14px', 'font-weight:700', 'cursor:pointer',
      'box-shadow:0 6px 20px rgba(0,0,0,.35)', 'display:none', 'font-family:inherit',
    ].join(';');
    el.addEventListener('click', open);
    document.body.appendChild(el);
    return el;
  }

  function render() {
    var items = read();
    var btn = shell();
    btn.style.display = (items.length && !blocked()) ? 'block' : 'none';
    btn.textContent = '🛒 ' + items.length + ' · ' + rands(total(items));
    var panel = document.getElementById('madBasketPanel');
    if (panel) drawPanel(panel);
    labelButtons();
  }

  // Add-buttons say what they hold and what they cost. Since the basket became
  // the only way to buy a download (the single-track button went on 2026-09-21),
  // the price belongs on the button itself.
  function labelButtons() {
    document.querySelectorAll('[data-basket-add]').forEach(function (b) {
      var inBasket = has(String(b.getAttribute('data-record-id') || ''));
      var price = parseFloat(b.getAttribute('data-price') || '0');
      var want = inBasket ? '✓ In basket' : (price > 0 ? '+ Basket · ' + rands(price) : '+ Basket');
      if (b.textContent !== want) b.textContent = want;
      b.disabled = false;
    });
  }

  // Rails, album panels and search results are rebuilt constantly, and a button
  // drawn after the last render would otherwise keep a stale label. Watch for
  // new ones — labels only, never the open panel, which would wipe a half-typed
  // email address underneath the customer.
  function watchForButtons() {
    if (!window.MutationObserver) return;
    var pending = null;
    new MutationObserver(function () {
      if (pending) return;
      pending = setTimeout(function () { pending = null; labelButtons(); }, 120);
    }).observe(document.body, { childList: true, subtree: true });
  }

  // ── the panel ─────────────────────────────────────────────────────────────
  function open() {
    if (blocked() || document.getElementById('madBasketPanel')) return;
    var wrap = document.createElement('div');
    wrap.id = 'madBasketPanel';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:4000;display:flex;align-items:center;justify-content:center;padding:20px;';
    wrap.addEventListener('click', function (e) { if (e.target === wrap) wrap.remove(); });
    document.body.appendChild(wrap);
    drawPanel(wrap);
  }

  function drawPanel(wrap) {
    var items = read();
    var email = '';
    try { email = localStorage.getItem('mass_token_email') || localStorage.getItem('mad_buyer_email') || ''; } catch (e) {}
    wrap.innerHTML =
      '<div style="background:var(--card,#1c1c26);color:var(--fg,#eee);border:1px solid var(--border,rgba(255,255,255,.12));border-radius:14px;max-width:460px;width:100%;max-height:82vh;display:flex;flex-direction:column;font-family:inherit">' +
        '<div style="padding:18px 20px 12px;display:flex;align-items:center;gap:10px">' +
          '<b style="font-size:16px">Your basket</b>' +
          '<span style="color:var(--muted,#999);font-size:13px">' + items.length + ' track' + (items.length === 1 ? '' : 's') + '</span>' +
          '<button type="button" data-basket-close style="margin-left:auto;background:none;border:none;color:var(--muted,#999);font-size:20px;cursor:pointer;line-height:1">×</button>' +
        '</div>' +
        (items.length
          ? '<div style="overflow:auto;padding:0 20px">' + items.map(function (i) {
              return '<div style="display:flex;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid var(--border,rgba(255,255,255,.08))">' +
                '<div style="min-width:0;flex:1"><div style="font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(i.name) + '</div>' +
                (i.artist ? '<div style="font-size:12px;color:var(--muted,#999);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(i.artist) + '</div>' : '') +
                '</div><div style="font-size:14px;white-space:nowrap">' + rands(i.price) + '</div>' +
                '<button type="button" data-basket-remove="' + esc(i.recordId) + '" title="Remove" style="background:none;border:none;color:var(--muted,#999);font-size:16px;cursor:pointer">×</button>' +
              '</div>';
            }).join('') + '</div>'
          : '<div style="padding:8px 20px 4px;color:var(--muted,#999);font-size:14px">Nothing in the basket yet. Use <b>+ Basket</b> next to any track you want to buy.</div>') +
        '<div style="padding:14px 20px 18px;border-top:1px solid var(--border,rgba(255,255,255,.08))">' +
          (items.length
            ? '<div style="display:flex;justify-content:space-between;font-size:15px;font-weight:700;margin-bottom:12px"><span>Total</span><span>' + rands(total(items)) + '</span></div>' +
              '<form id="madBasketForm" style="display:flex;gap:8px">' +
                '<input id="madBasketEmail" type="email" required placeholder="you@example.com" autocomplete="email" value="' + esc(email) + '" ' +
                'style="flex:1;background:rgba(127,127,127,.12);border:1px solid var(--border,rgba(255,255,255,.15));border-radius:8px;padding:10px 12px;color:inherit;font-size:14px;outline:none">' +
                '<button type="submit" style="background:var(--accent,#8b5cf6);color:#fff;border:none;border-radius:8px;padding:0 18px;cursor:pointer;font-size:14px;font-weight:700">Pay ' + rands(total(items)) + '</button>' +
              '</form>' +
              '<div id="madBasketMsg" style="font-size:12px;color:var(--muted,#999);margin-top:10px;min-height:15px">Your links are emailed too — each track downloads up to three times.</div>' +
              '<button type="button" data-basket-clear style="background:none;border:none;color:var(--muted,#999);font-size:12px;cursor:pointer;margin-top:6px;padding:0">Empty basket</button>'
            : '') +
        '</div>' +
      '</div>';

    wrap.querySelector('[data-basket-close]').addEventListener('click', function () { wrap.remove(); });
    var clear = wrap.querySelector('[data-basket-clear]');
    if (clear) clear.addEventListener('click', function () { write([]); wrap.remove(); });
    wrap.querySelectorAll('[data-basket-remove]').forEach(function (b) {
      b.addEventListener('click', function () { remove(b.getAttribute('data-basket-remove')); });
    });
    var form = wrap.querySelector('#madBasketForm');
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); checkout(wrap); });
  }

  // ── checkout ──────────────────────────────────────────────────────────────
  function checkout(wrap) {
    var items = read();
    var msg = wrap.querySelector('#madBasketMsg');
    var email = (wrap.querySelector('#madBasketEmail').value || '').trim();
    if (!items.length || !email || email.indexOf('@') < 0) return;
    try { localStorage.setItem('mad_buyer_email', email); } catch (e) {}
    msg.textContent = 'Setting up your payment…';
    wrap.querySelector('#madBasketForm button[type=submit]').disabled = true;

    fetch('/api/download/basket/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items.map(function (i) { return i.recordId; }), email: email }),
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (!data.ok || !data.authorization_url) throw new Error(data.error || 'Could not start the payment');
      // The callback deliberately keeps the reference out of the return URL (it
      // is a bearer token for the file route), so the only copy that survives
      // the round trip is this one.
      try {
        sessionStorage.setItem(PENDING, JSON.stringify({ ref: data.reference, items: data.items, total: data.total }));
      } catch (e) {}
      if (data.rejected && data.rejected.length) {
        toast(data.rejected.length + ' track(s) are not available for download and were left out', 'error');
      }
      window.location.href = data.authorization_url;
    }).catch(function (err) {
      msg.textContent = err.message;
      var btn = wrap.querySelector('#madBasketForm button[type=submit]');
      if (btn) btn.disabled = false;
    });
  }

  // ── coming back from Paystack ─────────────────────────────────────────────
  function showLinks(pending) {
    var items = (pending && pending.items) || [];
    var ref = pending && pending.ref;
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:4000;display:flex;align-items:center;justify-content:center;padding:20px;';
    var link = function (id) {
      return '/api/download/file?ref=' + encodeURIComponent(ref) + '&track=' + encodeURIComponent(id);
    };
    wrap.innerHTML =
      '<div style="background:var(--card,#1c1c26);color:var(--fg,#eee);border:1px solid var(--border,rgba(255,255,255,.12));border-radius:14px;max-width:460px;width:100%;max-height:82vh;display:flex;flex-direction:column;font-family:inherit">' +
        '<div style="padding:18px 20px 10px"><b style="font-size:16px">Thank you — your downloads are ready</b>' +
        '<div style="color:var(--muted,#999);font-size:13px;margin-top:4px">We have emailed these links as well. Each track can be downloaded three times.</div></div>' +
        '<div style="overflow:auto;padding:0 20px 8px">' + items.map(function (i) {
          return '<div style="display:flex;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid var(--border,rgba(255,255,255,.08))">' +
            '<div style="min-width:0;flex:1"><div style="font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(i.name) + '</div>' +
            (i.artist ? '<div style="font-size:12px;color:var(--muted,#999)">' + esc(i.artist) + '</div>' : '') + '</div>' +
            '<a href="' + link(i.trackRecordId) + '" style="background:var(--accent,#8b5cf6);color:#fff;text-decoration:none;border-radius:8px;padding:8px 14px;font-size:13px">Download</a>' +
          '</div>';
        }).join('') + '</div>' +
        '<div style="padding:12px 20px 18px;border-top:1px solid var(--border,rgba(255,255,255,.08))">' +
          '<button type="button" data-basket-done style="background:var(--accent,#8b5cf6);color:#fff;border:none;border-radius:8px;padding:10px 16px;cursor:pointer;font-size:14px;width:100%">Done</button></div>' +
      '</div>';
    document.body.appendChild(wrap);
    wrap.querySelector('[data-basket-done]').addEventListener('click', function () { wrap.remove(); });
  }

  function handleReturn() {
    var params = new URLSearchParams(window.location.search);
    if (params.get('download') !== 'basket') return;
    history.replaceState(history.state, '', window.location.pathname);
    var pending = null;
    try {
      pending = JSON.parse(sessionStorage.getItem(PENDING) || 'null');
      sessionStorage.removeItem(PENDING);
    } catch (e) {}
    write([]);                       // paid for: the basket is done
    if (pending && pending.ref && pending.items && pending.items.length) {
      showLinks(pending);
    } else {
      // The reference didn't survive the round trip (new tab, cleared session).
      // The purchase IS recorded and the email has the links.
      toast('Payment received — your download links have been emailed to you.', 'success');
    }
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-basket-add]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    var id = String(btn.getAttribute('data-record-id') || '');
    if (!id) return;
    if (has(id)) { open(); return; }
    add({
      recordId: id,
      name: btn.getAttribute('data-name') || 'Track',
      artist: btn.getAttribute('data-artist') || '',
      price: parseFloat(btn.getAttribute('data-price') || '0'),
    });
  }, true);

  window.MADBasket = { add: add, remove: remove, items: read, count: function () { return read().length; }, open: open, render: render };

  function boot() { render(); watchForButtons(); handleReturn(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
