// Auth + access-token flow for the mobile app.

import { elements, state } from './state.js?v=19';
import { showToast } from './util.js?v=19';

export function logout() {
      localStorage.removeItem('mass_access_token');
      localStorage.removeItem('mass_token_info');
      localStorage.removeItem('mass_token_email');
      state.currentUser = null;
      state.playlists = [];
      updateAuthUI();
      showToast('Logged out');
      window.location.reload();
    }

export function updateAuthUI() {
      const tokenStatus = document.getElementById('token-status');
      const tokenEmail = document.getElementById('token-email');
      const tokenExpiry = document.getElementById('token-expiry');

      // Trial CTA only makes sense while logged out
      const trialBtn = document.getElementById('trial-btn');
      if (trialBtn) trialBtn.style.display = state.currentUser ? 'none' : '';

      // …and account deletion only while logged in. A guest has no account, so
      // offering to delete one would be a dead end (and the endpoint refuses).
      const deleteBtn = document.getElementById('delete-account-btn');
      if (deleteBtn) deleteBtn.hidden = !state.currentUser;

      if (state.currentUser) {
        if (tokenEmail) tokenEmail.textContent = state.currentUser.email || '';
        if (tokenStatus) tokenStatus.textContent = 'Access Active';

        // Show expiry info
        if (tokenExpiry && state.currentUser.expirationDate) {
          const expDate = new Date(state.currentUser.expirationDate);
          const now = new Date();
          if (isNaN(expDate.getTime())) {
            tokenExpiry.textContent = '';
          } else {
            const hoursLeft = (expDate - now) / (1000 * 60 * 60);
            const daysLeft = Math.ceil(hoursLeft / 24);
            if (hoursLeft < 1) tokenExpiry.textContent = 'Token expired';
            else if (hoursLeft < 24) tokenExpiry.textContent = `Expires in ${Math.floor(hoursLeft)} hour${Math.floor(hoursLeft) !== 1 ? 's' : ''}`;
            else tokenExpiry.textContent = `Expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`;
          }
        } else if (tokenExpiry) {
          tokenExpiry.textContent = state.currentUser.tokenType === 'unlimited' ? 'Unlimited access' : '';
        }

        elements.userBadge.textContent = state.currentUser.email ? state.currentUser.email.split('@')[0] : 'Active';
      } else {
        if (tokenStatus) tokenStatus.textContent = 'No access token';
        if (tokenEmail) tokenEmail.textContent = '';
        if (tokenExpiry) tokenExpiry.textContent = '';
        elements.userBadge.textContent = 'Guest';
      }
    }

export function setAccessToken() {
      const token = prompt('Please enter your access token:');
      if (token) {
        localStorage.setItem('mass_access_token', token);
        showToast('Access token saved! Reloading...', 'success');
        setTimeout(() => window.location.reload(), 1000);
      }
    }

// 7-day free trial — same endpoint the desktop gate uses. The server enforces
// one trial per email (409 with a friendly message on repeats).
export async function startTrial() {
      const email = prompt('Enter your email address to start your free 7-day trial:');
      if (!email || !email.includes('@')) {
        showToast('Please enter a valid email address', 'error');
        return;
      }

      showToast('Starting your trial…', 'success');

      // Funnel attribution: credit the taster link that brought this visitor.
      let via = null;
      try { via = JSON.parse(sessionStorage.getItem('mad_taster') || 'null'); } catch (e) {}

      try {
        const response = await fetch('/api/payments/trial', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(via ? { email: email.trim(), via } : { email: email.trim() })
        });

        const data = await response.json();

        if (response.ok && data.ok && data.token) {
          // Legacy path (server no longer returns the token, but stay tolerant
          // during rollout)
          try { window.umami && window.umami.track('trial-start', via || {}); } catch (e) {}
          localStorage.setItem('mass_access_token', String(data.token).trim());
          localStorage.setItem('mass_token_email', email.trim().toLowerCase());
          showToast('Trial started! Reloading…', 'success');
          setTimeout(() => window.location.reload(), 1000);
        } else if (response.ok && data.ok && data.sent) {
          // Abuse fix 2026-08-27: the token arrives ONLY by email now — a
          // trial needs a mailbox you control. Point them at their inbox,
          // then open the token prompt so it's one paste away.
          try { window.umami && window.umami.track('trial-start', via || {}); } catch (e) {}
          localStorage.setItem('mass_token_email', email.trim().toLowerCase());
          alert(`We've emailed your trial token to ${email.trim()}.\n\nCheck your inbox (and spam), then enter the token to start listening.`);
          setAccessToken();
        } else {
          showToast(data.error || 'Could not start the trial. Please try again.', 'error');
        }
      } catch (err) {
        console.error('[Mobile] Trial error:', err);
        showToast('Trial service unavailable', 'error');
      }
    }

// ── Guest preview mode (2026-07-05) ─────────────────────────────────────────
// When the server stamps window.__GUEST_PREVIEW=true, a visitor with no token
// browses the app freely: rails load from public endpoints, every play is the
// server-clipped 30 s preview (see player.js playTrack), and this dismissible
// paywall sheet pops every 5 minutes instead of the blocking key screen.
const GUEST_POPUP_INTERVAL_MS = 5 * 60 * 1000;

// True when this page is running inside the Capacitor native shell (the app
// loads the live site; Capacitor injects window.Capacitor). Google Play's
// payments policy allows NO non-Play purchase flow in the app, so every Buy
// Access surface is suppressed in native — Play Billing (RevenueCat) replaces
// them in a later release. Belt (hidden UI) and braces (refused code path).
export const isNativeApp = () =>
  !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

// ── Account deletion (Apple Guideline 5.1.1(v)) ──────────────────────────────
// An app that creates accounts must let people delete them from inside the app;
// a support address does not satisfy it, and neither does signing out. So this
// ships on the web too — one page, one behaviour, and the native shells inherit
// it the way they inherit everything else.
//
// Two taps, never one. The first shows what is actually about to go, counted
// from the server rather than promised in the abstract, and says plainly what
// is kept and why. Nothing is destroyed until the second.

export async function deleteAccountFlow() {
  if (!localStorage.getItem('mass_access_token')) {
    showToast('You are not signed in', 'error');
    return;
  }

  const overlay = document.getElementById('modal-overlay');
  const sheet   = document.getElementById('bottom-sheet');
  if (!overlay || !sheet) return;

  const show = (html) => {
    sheet.innerHTML = html;
    overlay.classList.add('show');
  };
  const close = () => (window.closeModal ? window.closeModal() : overlay.classList.remove('show'));

  show('<div class="bottom-sheet-header">Delete account</div>' +
       '<div class="empty-state"><p>Checking your account…</p></div>');

  let account;
  try {
    const res  = await fetch('/api/account');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'lookup failed');
    account = data.account;
  } catch {
    show('<div class="bottom-sheet-header">Delete account</div>' +
         '<div class="empty-state"><div class="empty-icon">⚠️</div>' +
         '<p>We could not reach your account just now. Please try again.</p></div>' +
         '<button class="btn btn-secondary" style="width:100%;margin-top:16px;" id="del-cancel">Close</button>');
    document.getElementById('del-cancel').addEventListener('click', close);
    return;
  }

  const line = (n, one, many) => (n ? `<li>${n} ${n === 1 ? one : many}</li>` : '');
  const goes = [
    line(account.tokens, 'access token', 'access tokens'),
    line(account.playlists, 'playlist', 'playlists'),
    line(account.library, 'saved library', 'saved library records'),
  ].join('') || '<li>your access</li>';

  show(`
    <div class="bottom-sheet-header">Delete account</div>
    <div style="padding:0 4px 4px;">
      <p style="margin:0 0 12px;">This permanently deletes${account.email ? ` <strong>${account.email}</strong>` : ' your account'} and cannot be undone.</p>
      <p style="margin:0 0 6px;color:var(--text-secondary);font-size:14px;">We will delete:</p>
      <ul style="margin:0 0 12px 18px;padding:0;color:var(--text-secondary);font-size:14px;">${goes}</ul>
      <p style="margin:0 0 16px;color:var(--text-muted);font-size:13px;">
        Your listening history is anonymised. Purchase receipts are kept as financial records.
        You will not be able to start another free trial with this email address.
      </p>
      <button class="btn btn-secondary" style="width:100%;margin-bottom:8px;" id="del-cancel">Keep my account</button>
      <button class="btn btn-primary" style="width:100%;background:var(--error);color:#fff;" id="del-confirm">Delete permanently</button>
    </div>`);

  document.getElementById('del-cancel').addEventListener('click', close);
  document.getElementById('del-confirm').addEventListener('click', async () => {
    const btn = document.getElementById('del-confirm');
    btn.disabled = true;
    btn.textContent = 'Deleting…';
    try {
      const res  = await fetch('/api/account/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'DELETE' }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'deletion failed');
      // Local state must go too, or the next launch reads a token the server
      // has already destroyed and shows a confusing "invalid token" screen.
      localStorage.removeItem('mass_access_token');
      localStorage.removeItem('mass_token_info');
      localStorage.removeItem('mass_token_email');
      state.currentUser = null;
      state.playlists   = [];
      show('<div class="bottom-sheet-header">Account deleted</div>' +
           '<div class="empty-state"><div class="empty-icon">✓</div>' +
           '<p>Your account has been deleted. Thanks for listening.</p></div>');
      setTimeout(() => window.location.reload(), 2500);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Delete permanently';
      showToast(err.message || 'Could not delete your account', 'error');
    }
  });
}

function injectGuestPaywall() {
  if (document.getElementById('guest-paywall')) return;

  const overlay = document.createElement('div');
  overlay.id = 'guest-paywall';
  overlay.className = 'guest-paywall';
  overlay.innerHTML = `
    <div class="guest-paywall-card">
      <button type="button" class="guest-paywall-close" id="guest-paywall-close" aria-label="Close and keep browsing">&times;</button>
      <div class="guest-paywall-icon">🎧</div>
      <h3>Enjoying the music?</h3>
      <p>You're in preview mode — 30 second clips. Get full access to every track.</p>
      <button class="btn btn-primary" id="guest-paywall-trial">Start 7-Day Free Trial</button>
      ${isNativeApp() ? '' : '<button class="btn btn-secondary" id="guest-paywall-buy">Buy Access</button>'}
      <button class="btn btn-secondary" id="guest-paywall-token">Enter Access Token</button>
    </div>`;
  document.body.appendChild(overlay);

  document.getElementById('guest-paywall-close').addEventListener('click', hideGuestPaywall);
  document.getElementById('guest-paywall-trial').addEventListener('click', startTrial);
  document.getElementById('guest-paywall-buy')?.addEventListener('click', buyAccess);
  document.getElementById('guest-paywall-token').addEventListener('click', setAccessToken);
  // Tapping the dimmed backdrop also just closes it — exploring stays easy.
  overlay.addEventListener('click', (e) => { if (e.target === overlay) hideGuestPaywall(); });

  // Persistent subscribe pill so a convinced guest never has to wait for
  // the 5-minute popup.
  const pill = document.createElement('div');
  pill.id = 'guest-pill';
  pill.className = 'guest-pill';
  pill.setAttribute('role', 'button');
  pill.innerHTML = 'Preview mode &middot; <strong>Subscribe</strong>';
  pill.addEventListener('click', showGuestPaywall);
  document.body.appendChild(pill);
}

export function showGuestPaywall() {
  const el = document.getElementById('guest-paywall');
  if (el) el.classList.add('show');
}

function hideGuestPaywall() {
  const el = document.getElementById('guest-paywall');
  if (el) el.classList.remove('show');
}

export function enterGuestMode() {
  console.log('[Mobile] Guest preview mode active — browsing without a token');
  window.__GUEST = true;
  document.body.classList.add('guest-mode');
  state.currentUser = null;
  updateAuthUI();
  injectGuestPaywall();
  // The 5-minute subscribe popup. The interval keeps ticking: closing the
  // sheet just resumes browsing until the next tick.
  setInterval(() => {
    const el = document.getElementById('guest-paywall');
    if (el && !el.classList.contains('show')) showGuestPaywall();
  }, GUEST_POPUP_INTERVAL_MS);
}

// The plan list comes from our own server, not a user, but it is still
// interpolated into innerHTML — escape it rather than rely on that staying true.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Buy access — pick a plan, then check out.
 *
 * Mobile used to hardcode plan:'7-day' and never call /api/payments/plans, so
 * the 1-day and 30-day passes were unreachable on the platform that carries
 * most of the traffic — including any price change, which reached desktop only.
 * The plans come from the server so there is still exactly one source of truth
 * (PAYSTACK_PLANS in lib/paystack.js).
 */
export async function buyAccess() {
  // Play/App Store policy: no external purchase channel inside the wrapper,
  // and naming one is itself a violation — so the wording stays neutral.
  if (isNativeApp()) {
    showToast('Purchases are not available in this app', 'error');
    return;
  }

  let plans = [];
  try {
    const res  = await fetch('/api/payments/plans');
    const data = await res.json();
    if (res.ok && Array.isArray(data.plans)) plans = data.plans;
  } catch { /* fall through to the fallback below */ }

  // Never block a sale on a failed lookup: offer the mid plan as before.
  if (!plans.length) {
    plans = [{ id: '7-day', label: '7 Day Access', days: 7, display: 'R7.50' }];
  }

  showPlanPicker(plans);
}

function closePlanPicker() {
  document.getElementById('plan-picker')?.remove();
}

function showPlanPicker(plans) {
  closePlanPicker();
  const overlay = document.createElement('div');
  overlay.id = 'plan-picker';
  overlay.className = 'guest-paywall show';   // same bottom sheet as the paywall
  overlay.innerHTML = `
    <div class="guest-paywall-card">
      <button type="button" class="guest-paywall-close" id="plan-picker-close" aria-label="Close">&times;</button>
      <div class="guest-paywall-icon">🎟️</div>
      <h3>Choose your access</h3>
      <p>Unlimited streaming for the period you pick. No subscription, no card stored.</p>
      <div class="plan-list">
        ${plans.map((p, i) => `
          <button type="button" class="plan-row${i === plans.length - 1 ? ' plan-row-best' : ''}" data-plan="${esc(p.id)}">
            <span class="plan-row-main">
              <span class="plan-row-name">${esc(p.label)}</span>
              <span class="plan-row-sub">${p.days} ${p.days === 1 ? 'day' : 'days'} of unlimited streaming</span>
            </span>
            <span class="plan-row-price">${esc(p.display)}</span>
          </button>`).join('')}
      </div>
      <label class="plan-email-label" for="plan-email">Where should we send your access code?</label>
      <input type="email" id="plan-email" class="plan-email" inputmode="email" autocomplete="email"
             autocapitalize="off" spellcheck="false" placeholder="you@example.com">
      <div class="plan-picker-status" id="plan-picker-status"></div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closePlanPicker(); });
  document.getElementById('plan-picker-close').addEventListener('click', closePlanPicker);
  for (const btn of overlay.querySelectorAll('.plan-row')) {
    btn.addEventListener('click', () => startCheckout(btn.dataset.plan));
  }
}

/** Send the chosen plan to Paystack. */
async function startCheckout(planId) {
  const input  = document.getElementById('plan-email');
  const status = document.getElementById('plan-picker-status');
  const email  = (input?.value || '').trim();

  // An inline field rather than prompt(): a native dialog on mobile is easy to
  // dismiss by accident, and loses what was typed when it happens.
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    if (status) status.textContent = 'Enter a valid email address first — your access code is sent there.';
    input?.focus();
    return;
  }

  if (status) status.textContent = 'Redirecting to payment…';
  for (const b of document.querySelectorAll('#plan-picker .plan-row')) b.disabled = true;

  try {
    const response = await fetch('/api/payments/initialize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, plan: planId, source: 'mobile' })
    });
    const data = await response.json();
    if (response.ok && data.authorization_url) {
      window.location.href = data.authorization_url;
    } else {
      if (status) status.textContent = data.error || 'Could not start payment. Please try again.';
      for (const b of document.querySelectorAll('#plan-picker .plan-row')) b.disabled = false;
    }
  } catch (err) {
    console.error('[Mobile] Payment error:', err);
    if (status) status.textContent = 'Payment service unavailable. Please try again.';
    for (const b of document.querySelectorAll('#plan-picker .plan-row')) b.disabled = false;
  }
}
