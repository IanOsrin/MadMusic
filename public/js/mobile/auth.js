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
