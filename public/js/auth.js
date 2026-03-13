  // ========= ACCESS TOKEN MANAGEMENT =========
  // IMPORTANT: This must run BEFORE app.min.js to intercept fetch calls
  (function() {
    const STORAGE_KEY = 'mass_access_token';
    const STORAGE_INFO_KEY = 'mass_access_token_info';
    const SESSION_ID_KEY = 'mass_session_id';

    // ── Paystack callback guard — MUST run before anything else ──────────────
    // If we land here with ?payment=success&token=NEW, save the new token and
    // reload BEFORE reading localStorage (which may hold an old expired token).
    // Returning from the outer IIFE stops auth.js entirely so the stale token
    // never gets into the fetch interceptor and no race condition can occur.
    // On the second load the URL is clean and auth.js activates normally.
    const _cbp = new URLSearchParams(window.location.search);
    if (_cbp.get('payment') === 'success' && _cbp.get('token')) {
      localStorage.setItem(STORAGE_KEY, _cbp.get('token').trim().toUpperCase());
      localStorage.removeItem(STORAGE_INFO_KEY);
      window.history.replaceState({}, document.title, window.location.pathname);
      window.location.reload();
      return; // halts the entire IIFE — reload re-runs auth.js cleanly
    }
    if (_cbp.get('payment') === 'failed' || _cbp.get('payment') === 'error') {
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    // Generate or retrieve unique session ID for this device/browser
    function getSessionId() {
      let sessionId = localStorage.getItem(SESSION_ID_KEY);
      if (!sessionId) {
        // Generate UUID v4
        sessionId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
          const r = Math.random() * 16 | 0;
          const v = c === 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
        localStorage.setItem(SESSION_ID_KEY, sessionId);
        console.log('[Session] Generated new session ID:', sessionId);
      }
      return sessionId;
    }

    const sessionId = getSessionId();

    // Load token from localStorage IMMEDIATELY before anything else
    let currentAccessToken = localStorage.getItem(STORAGE_KEY);
    let tokenInfo = null;
    try {
      const infoStr = localStorage.getItem(STORAGE_INFO_KEY);
      if (infoStr) {
        tokenInfo = JSON.parse(infoStr);
      }
    } catch (e) {
      console.warn('[Access Token] Failed to parse token info:', e);
    }

    console.log('[Access Token] Pre-loaded token:', currentAccessToken ? 'YES' : 'NO');

    // Use the paymentOverlay as the main gate (has both purchase + token entry)
    const overlay = document.getElementById('paymentOverlay');
    const form = null; // paymentOverlay uses button clicks, not a form element
    const input = document.getElementById('tokenInput');
    const submitBtn = document.getElementById('tokenSubmit');
    const errorDiv = document.getElementById('paymentError');
    const infoDiv = document.getElementById('accessTokenInfo');
    const statusDiv = document.getElementById('accessTokenStatus');

    // Intercept all fetch requests to add access token header
    const originalFetch = window.fetch;
    window.fetch = function(url, options = {}) {
      const isApiCall = url.includes('/api/') || url.startsWith('/api/');

      // Public endpoints that don't require access token
      const publicEndpoints = [
        '/api/access/validate',
        '/api/wake',
        '/api/container',
        '/api/random-songs',
        '/api/public-playlists',
        '/api/search',
        '/api/album',
        '/api/trending',
        '/api/explore',
        '/api/featured-albums',
        '/api/missing-audio-songs',
        '/api/payments/'  // payment flow must work before token exists
      ];

      const isPublicEndpoint = publicEndpoints.some(endpoint => url.includes(endpoint));

      // Block API calls without token (except public endpoints)
      if (isApiCall && !currentAccessToken && !isPublicEndpoint) {
        console.warn('[Access Token] Blocking API call without token:', url);
        return Promise.reject(new Error('API call attempted before access token was ready'));
      }

      // Add access token header if we have one and it's an API request
      if (currentAccessToken && isApiCall) {
        console.log('[Access Token] Adding token to request:', url);

        // Initialize headers if not present
        if (!options.headers) {
          options.headers = {};
        }

        // Handle both Headers objects and plain objects
        if (options.headers instanceof Headers) {
          options.headers.set('X-Access-Token', currentAccessToken);
        } else if (typeof options.headers === 'object') {
          options.headers['X-Access-Token'] = currentAccessToken;
        }
      }

      // Call original fetch and handle 403 errors
      return originalFetch(url, options).then(response => {
        // If we get 403 and it requires access token, show the overlay
        if (response.status === 403 && url.includes('/api/')) {
          response.clone().json().then(data => {
            if (data.requiresAccessToken) {
              console.log('[Access Token] 403 error - token required or invalid');
              clearAccessToken();
              showTokenOverlay();
            }
          }).catch(() => {});
        }
        return response;
      });
    };

    function showError(message) {
      errorDiv.textContent = message;
      errorDiv.classList.add('show');
      setTimeout(() => {
        errorDiv.classList.remove('show');
      }, 5000);
    }

    function showTokenOverlay() {
      overlay.classList.remove('hidden');
      // Default to purchase section; token entry is secondary
      const purchaseSection = document.getElementById('purchaseSection');
      const tokenSection = document.getElementById('tokenSection');
      if (purchaseSection) purchaseSection.classList.remove('hidden');
      if (tokenSection) tokenSection.classList.remove('active');
      if (input) { input.value = ''; }
    }

    function hideTokenOverlay() {
      overlay.classList.add('hidden');
    }

    function updateTokenInfo() {
      if (!tokenInfo) {
        infoDiv.classList.add('hidden');
        return;
      }

      let statusText = '';
      if (tokenInfo.type === 'unlimited') {
        statusText = 'Unlimited Access';
      } else if (tokenInfo.expirationDate && tokenInfo.expirationDate.trim() !== '') {
        const expDate = new Date(tokenInfo.expirationDate);
        const now = new Date();

        // Check if date is valid
        if (isNaN(expDate.getTime())) {
          statusText = 'Active';
        } else {
          const hoursLeft = (expDate - now) / (1000 * 60 * 60);
          const daysLeft = Math.ceil(hoursLeft / 24);

          if (hoursLeft < 1) {
            statusText = 'Expired';
          } else if (hoursLeft < 24) {
            statusText = `Expires in ${Math.floor(hoursLeft)} hour${Math.floor(hoursLeft) !== 1 ? 's' : ''}`;
          } else if (daysLeft === 1) {
            statusText = `Expires in 1 day`;
          } else {
            statusText = `Expires in ${daysLeft} days`;
          }
        }
      } else {
        statusText = 'Active (no expiration)';
      }

      statusDiv.textContent = statusText;
      infoDiv.classList.remove('hidden');

      // Auto-hide notification after 10 seconds
      setTimeout(() => {
        infoDiv.classList.add('hidden');
      }, 10000);
    }

    function saveAccessToken(token, info) {
      currentAccessToken = token;
      tokenInfo = info;
      localStorage.setItem(STORAGE_KEY, token);
      localStorage.setItem(STORAGE_INFO_KEY, JSON.stringify(info));
      updateTokenInfo();
    }

    function loadAccessToken() {
      // Token already loaded at script start, just update UI and return it
      if (currentAccessToken) {
        updateTokenInfo();
      }
      return currentAccessToken;
    }

    async function clearAccessToken() {
      // Call backend to clear session from FileMaker
      if (currentAccessToken && sessionId) {
        console.log('[Access Token] Calling logout endpoint with token:', currentAccessToken, 'sessionId:', sessionId);
        try {
          const response = await originalFetch('/api/access/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              token: currentAccessToken,
              sessionId: sessionId
            })
          });
          const data = await response.json();
          console.log('[Access Token] Logout response:', response.status, data);
          if (response.ok) {
            console.log('[Access Token] ✅ Session cleared from server successfully');
          } else {
            console.error('[Access Token] ❌ Logout failed:', data);
          }
        } catch (err) {
          console.error('[Access Token] ❌ Logout request failed:', err);
        }
      } else {
        console.log('[Access Token] Skipping logout - no token or sessionId');
      }

      // Clear local storage
      currentAccessToken = null;
      tokenInfo = null;
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(STORAGE_INFO_KEY);
      infoDiv.classList.add('hidden');
      window.massAccessReady = false;
      window.massAccessToken = null;
    }

    async function validateToken(token) {
      try {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Validating...';
        errorDiv.classList.remove('show');

        const response = await originalFetch('/api/access/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: token.trim().toUpperCase(),
            sessionId: sessionId
          })
        });

        const data = await response.json();

        if (response.ok && data.valid) {
          const normalized = token.trim().toUpperCase();
          saveAccessToken(normalized, {
            type: data.type,
            expirationDate: data.expirationDate
          });

          // Save email to localStorage for currentUser
          if (data.email) {
            localStorage.setItem('mass_token_email', data.email);
          }

          hideTokenOverlay();
          console.log('[Access Token] Token validated successfully');

          // Notify app that access is ready so it can do its initial load
          window.massAccessReady = true;
          window.massAccessToken = normalized;
          window.dispatchEvent(new CustomEvent('mass:access-ready', {
            detail: { token: normalized, email: data.email || null }
          }));

          return true;
        } else {
          // Check for "token in use" error
          if (data.reason === 'Token is currently in use on another device') {
            showError('⚠️ This token is already active on another device. Please wait or use a different token.');
          } else {
            showError(data.reason || data.error || 'Invalid token');
          }
          return false;
        }
      } catch (err) {
        console.error('[Access Token] Validation error:', err);
        showError('Failed to validate token. Please try again.');
        return false;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Activate Access';
      }
    }

    // Token submit handler — button click in paymentOverlay tokenSection
    if (submitBtn) {
      submitBtn.addEventListener('click', async () => {
        const token = input ? input.value.trim() : '';

        if (!token) {
          showError('Please enter an access token');
          return;
        }

        await validateToken(token);
      });
    }

    // Also allow Enter key in the token input field
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (submitBtn) submitBtn.click();
        }
      });
    }

    // Check for existing token on page load
    const existingToken = loadAccessToken();
    if (existingToken) {
      console.log('[Access Token] Found existing token, validating...');
      // Validate the existing token (validateToken will dispatch 'mass:access-ready' if valid)
      validateToken(existingToken).then(valid => {
        if (!valid) {
          console.log('[Access Token] Existing token invalid, showing overlay');
          showTokenOverlay();
        } else {
          console.log('[Access Token] Existing token valid (event already dispatched)');
          // Note: hideTokenOverlay and event dispatch already handled in validateToken
        }
      });
    } else {
      console.log('[Access Token] No existing token, showing overlay');
      showTokenOverlay();
    }

    // Allow clearing token with Ctrl+Shift+T (for testing)
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'T') {
        console.log('[Access Token] Clearing token (Ctrl+Shift+T)');
        clearAccessToken();
        showTokenOverlay();
      }
    });

    // Reset App button handler
    const resetAppBtn = document.getElementById('resetAppBtn');
    if (resetAppBtn) {
      resetAppBtn.addEventListener('click', async () => {
        if (confirm('Reset app? This will clear all stored data (access token, cookies, settings) and reload the page.')) {
          console.log('[Access Token] Resetting app - clearing all localStorage');

          // First, clear session from server
          await clearAccessToken();

          // Then clear all local storage and cookies
          localStorage.clear();
          sessionStorage.clear();
          // Also clear cookies
          document.cookie.split(";").forEach((c) => {
            document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
          });
          location.reload(true); // Force reload from server, not cache
        }
      });
    }

    console.log('[Access Token] Token management initialized');


// Export key functions globally
window.MADAuth = {
  showTokenOverlay,
  hideTokenOverlay,
  clearAccessToken,
  updateTokenInfo
};

// Also keep direct window assignments for compatibility
window.clearAccessToken = clearAccessToken;
window.updateTokenInfo = updateTokenInfo;

})();
