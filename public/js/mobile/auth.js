// Auth + access-token flow for the mobile app.

import { elements, state } from './state.js';
import { showToast } from './util.js';

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

      try {
        const response = await fetch('/api/payments/trial', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim() })
        });

        const data = await response.json();

        if (response.ok && data.ok && data.token) {
          localStorage.setItem('mass_access_token', String(data.token).trim());
          localStorage.setItem('mass_token_email', email.trim().toLowerCase());
          showToast('Trial started! Reloading…', 'success');
          setTimeout(() => window.location.reload(), 1000);
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
      <button class="btn btn-secondary" id="guest-paywall-buy">Buy Access</button>
      <button class="btn btn-secondary" id="guest-paywall-token">Enter Access Token</button>
    </div>`;
  document.body.appendChild(overlay);

  document.getElementById('guest-paywall-close').addEventListener('click', hideGuestPaywall);
  document.getElementById('guest-paywall-trial').addEventListener('click', startTrial);
  document.getElementById('guest-paywall-buy').addEventListener('click', buyAccess);
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

export async function buyAccess() {
      const email = prompt('Enter your email address for the receipt:');
      if (!email || !email.includes('@')) {
        showToast('Please enter a valid email address', 'error');
        return;
      }

      showToast('Redirecting to payment...', 'success');

      try {
        const response = await fetch('/api/payments/initialize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), plan: '7-day', source: 'mobile' })
        });

        const data = await response.json();

        if (response.ok && data.authorization_url) {
          window.location.href = data.authorization_url;
        } else {
          showToast(data.error || 'Failed to start payment', 'error');
        }
      } catch (err) {
        console.error('[Mobile] Payment error:', err);
        showToast('Payment service unavailable', 'error');
      }
    }
