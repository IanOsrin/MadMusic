  // ========= ACCESS TOKEN MANAGEMENT =========
  // IMPORTANT: This must run BEFORE app.min.js to intercept fetch calls
  (function() {
    const STORAGE_KEY = 'mass_access_token';
    const STORAGE_INFO_KEY = 'mass_access_token_info';
    const SESSION_ID_KEY = 'mass_session_id';

    // ── Paystack callback guard — MUST run before anything else ──────────────
    // If we land here with ?payment=success&token=NEW, save the new token and
    // navigate to the clean pathname BEFORE reading localStorage (which may
    // hold an old expired token).  Using location.replace() is a single atomic
    // navigation — unlike replaceState+reload() there is no window in which the
    // original URL can be re-read, preventing an infinite reload loop in browsers
    // that process the reload before replaceState fully commits.
    // Returning from the outer IIFE stops auth.js entirely so the stale token
    // never gets into the fetch interceptor and no race condition can occur.
    // On the second load the URL is clean and auth.js activates normally.
    const _cbp = new URLSearchParams(window.location.search);
    if (_cbp.get('payment') === 'success' && _cbp.get('token')) {
      localStorage.setItem(STORAGE_KEY, _cbp.get('token').trim().toUpperCase());
      localStorage.removeItem(STORAGE_INFO_KEY);
      window.location.replace(window.location.pathname); // atomic: clean URL + reload
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
    // Set by validateToken() on every failure so the boot path can distinguish
    // a DEFINITIVE server verdict (invalid/expired/disabled → guest mode) from
    // a transient one (network/FM hiccup/in-use → retry, keep the token).
    let _lastValidateFailure = null;
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
        '/api/podcasts',   // public catalogue content; server fences it when the feature flag is off
        '/api/suggestions', // "Similar albums" rail; server fences it when the feature flag is off
        '/api/artist-bio',  // artist biography; server returns { found:false } when the feature flag is off
        '/api/featured-albums',
        '/api/missing-audio-songs',
        '/api/singles',
        '/api/new-releases',      // hero rail — public catalogue content
        '/api/g100-albums',       // G100 view — public catalogue content
        '/api/g100-playlists',
        '/api/genres',
        '/api/featured-editorial',
        '/api/preview/',          // guest 30 s previews — public by design
        '/api/payments/',    // payment flow must work before token exists
        '/api/download/',    // download purchase flow — token-free by design
        '/api/audio-proxy',  // Audio Lab proxy — no auth needed (key is gated separately)
        '/api/audio-lab/'    // Audio Lab key validation
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
              // Only wipe the stored token if the server explicitly confirms it is
              // invalid/expired.  Transient FileMaker failures should NOT cause a
              // still-valid token to be erased from localStorage.
              const isDefinitelyInvalid =
                data.reason === 'invalid' || data.reason === 'expired' ||
                (typeof data.error === 'string' &&
                  (data.error.toLowerCase().includes('invalid') || data.error.toLowerCase().includes('expired')));
              if (isDefinitelyInvalid) {
                clearAccessToken();
              }
              // In guest mode a stray token-gated call must NOT pop the
              // overlay — the 5-minute timer (and explicit CTAs) own that.
              if (!window.__GUEST) showTokenOverlay();
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

          // If the FM token record has no Issued_To, force the user through
          // the email-claim modal before any app access. We save the token
          // locally so the claim endpoints can be called with it, but we do
          // NOT mark access-ready — the app stays gated.
          if (data.requiresEmail) {
            console.log('[Access Token] Token valid but requires email — showing claim modal');
            localStorage.setItem(STORAGE_KEY, normalized);
            currentAccessToken = normalized;
            _lastValidateFailure = { requiresEmail: true, definitive: false, reason: 'requires_email' };
            showEmailClaimModal(normalized);
            return false; // not "valid for app use" yet
          }

          saveAccessToken(normalized, {
            type: data.type,
            expirationDate: data.expirationDate
          });

          // Save email to localStorage for currentUser
          if (data.email) {
            localStorage.setItem('mass_token_email', data.email);
          }

          // Guest → subscriber: the page booted in preview mode (blocked
          // fetches, preview playback, popup timer). A clean reload re-boots
          // it as a normal token session with none of that state.
          if (window.__GUEST) {
            window.location.reload();
            return true;
          }

          // Pass Audio Lab entitlement to the gate script
          window.massAudioLabEnabled = data.audioLabEnabled || false;

          hideTokenOverlay();
          console.log('[Access Token] Token validated successfully');

          // Notify app that access is ready so it can do its initial load
          window.massAccessReady = true;
          window.massAccessToken = normalized;
          window.dispatchEvent(new CustomEvent('mass:access-ready', {
            detail: { token: normalized, email: data.email || null, audioLabEnabled: data.audioLabEnabled || false }
          }));

          return true;
        } else {
          // Classify the failure so the BOOT path can tell "this token is
          // dead" (drop to guest) from "we couldn't be sure" (keep the token,
          // retry, never silently downgrade a subscriber to preview mode).
          const reason = String(data.reason || data.error || '');
          const definitive = response.status === 401 &&
            /invalid token|expired|disabled|not found/i.test(reason);
          _lastValidateFailure = { definitive, requiresEmail: false, reason };
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
        _lastValidateFailure = { definitive: false, requiresEmail: false, reason: 'network' };
        showError('Failed to validate token. Please try again.');
        return false;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Activate Access';
      }
    }

    // ── Email claim flow ─────────────────────────────────────────────────
    // Shown when /validate returns { requiresEmail: true }. The user must
    // bind a verified email to their token before they can use the app —
    // otherwise their playlists / saved albums would be stored under the
    // token code and orphaned the moment an email gets bound later.
    const emailClaimSection  = document.getElementById('emailClaimSection');
    const emailClaimStep1    = document.getElementById('emailClaimStep1');
    const emailClaimStep2    = document.getElementById('emailClaimStep2');
    const emailClaimInput    = document.getElementById('emailClaimInput');
    const emailClaimCodeInput = document.getElementById('emailClaimCodeInput');
    const emailClaimSendBtn  = document.getElementById('emailClaimSendBtn');
    const emailClaimConfirmBtn = document.getElementById('emailClaimConfirmBtn');
    const emailClaimAddress  = document.getElementById('emailClaimAddress');
    const emailClaimResend   = document.getElementById('emailClaimResend');
    const emailClaimError    = document.getElementById('emailClaimError');

    let _emailClaimToken = null;
    let _emailClaimEmail = null;

    function showEmailClaimError(msg) {
      if (!emailClaimError) return;
      emailClaimError.textContent = msg;
      emailClaimError.classList.add('show');
    }
    function clearEmailClaimError() {
      if (!emailClaimError) return;
      emailClaimError.textContent = '';
      emailClaimError.classList.remove('show');
    }

    function showEmailClaimModal(token) {
      _emailClaimToken = token;
      // Hide the standard sections, show the claim section
      const tokenSection    = document.getElementById('tokenSection');
      const purchaseSection = document.getElementById('purchaseSection');
      if (tokenSection)    tokenSection.classList.remove('active');
      if (purchaseSection) purchaseSection.classList.add('hidden');
      if (emailClaimSection) emailClaimSection.hidden = false;
      if (emailClaimStep1)  emailClaimStep1.hidden = false;
      if (emailClaimStep2)  emailClaimStep2.hidden = true;
      clearEmailClaimError();
      if (emailClaimInput) {
        emailClaimInput.value = '';
        setTimeout(() => emailClaimInput.focus(), 50);
      }
      overlay.classList.remove('hidden');
    }

    async function emailClaimSendCode() {
      clearEmailClaimError();
      const email = (emailClaimInput?.value || '').trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        showEmailClaimError('Please enter a valid email address');
        return;
      }
      if (!_emailClaimToken) {
        showEmailClaimError('No token in progress — please start over');
        return;
      }

      emailClaimSendBtn.disabled = true;
      emailClaimSendBtn.textContent = 'Sending…';
      try {
        const res = await originalFetch('/api/access/email/start', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ token: _emailClaimToken, email })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          showEmailClaimError(data.error || 'Could not send code');
          return;
        }
        _emailClaimEmail = email;
        if (emailClaimAddress) emailClaimAddress.textContent = email;
        if (emailClaimStep1) emailClaimStep1.hidden = true;
        if (emailClaimStep2) emailClaimStep2.hidden = false;
        if (emailClaimCodeInput) {
          emailClaimCodeInput.value = '';
          setTimeout(() => emailClaimCodeInput.focus(), 50);
        }
      } catch (err) {
        console.error('[EmailClaim] start error:', err);
        showEmailClaimError('Network error — please try again');
      } finally {
        emailClaimSendBtn.disabled = false;
        emailClaimSendBtn.textContent = 'Send verification code';
      }
    }

    async function emailClaimConfirm() {
      clearEmailClaimError();
      const code = (emailClaimCodeInput?.value || '').trim();
      if (!/^\d{6}$/.test(code)) {
        showEmailClaimError('Enter the 6-digit code from your email');
        return;
      }

      emailClaimConfirmBtn.disabled = true;
      emailClaimConfirmBtn.textContent = 'Verifying…';
      try {
        const res = await originalFetch('/api/access/email/confirm', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ token: _emailClaimToken, code })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          let msg = data.error || 'Could not verify code';
          if (typeof data.attemptsRemaining === 'number') {
            msg += ` (${data.attemptsRemaining} attempt${data.attemptsRemaining === 1 ? '' : 's'} left)`;
          }
          showEmailClaimError(msg);
          return;
        }
        // Email is now bound to the token. Hide the claim UI and re-run the
        // normal token validation path — this time requiresEmail will be false
        // and the app will start.
        if (emailClaimSection) emailClaimSection.hidden = true;
        await validateToken(_emailClaimToken);
        _emailClaimToken = null;
        _emailClaimEmail = null;
      } catch (err) {
        console.error('[EmailClaim] confirm error:', err);
        showEmailClaimError('Network error — please try again');
      } finally {
        emailClaimConfirmBtn.disabled = false;
        emailClaimConfirmBtn.textContent = 'Verify & continue';
      }
    }

    if (emailClaimSendBtn)    emailClaimSendBtn.addEventListener('click', emailClaimSendCode);
    if (emailClaimConfirmBtn) emailClaimConfirmBtn.addEventListener('click', emailClaimConfirm);
    if (emailClaimInput) {
      emailClaimInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); emailClaimSendCode(); }
      });
    }
    if (emailClaimCodeInput) {
      emailClaimCodeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); emailClaimConfirm(); }
      });
    }
    if (emailClaimResend) {
      emailClaimResend.addEventListener('click', () => {
        if (emailClaimStep1) emailClaimStep1.hidden = false;
        if (emailClaimStep2) emailClaimStep2.hidden = true;
        clearEmailClaimError();
        if (emailClaimInput) {
          emailClaimInput.value = '';
          setTimeout(() => emailClaimInput.focus(), 50);
        }
      });
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

    // ── Guest preview mode (2026-07-05) ─────────────────────────────────────
    // When the server stamps window.__GUEST_PREVIEW=true, a visitor with no
    // token browses the app freely: public rails load, every play is the
    // server-clipped 30 s preview (see _PLAYER.playTrack in app.html), and the
    // payment overlay pops every 5 minutes as a DISMISSIBLE popup instead of a
    // blocking wall. Subscribing/activating a token reloads into a normal
    // session (see validateToken).
    const GUEST_POPUP_INTERVAL_MS = 5 * 60 * 1000;

    function showGuestToast(message) {
      let toast = document.getElementById('guestToast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'guestToast';
        toast.className = 'guest-toast';
        document.body.appendChild(toast);
      }
      toast.textContent = message;
      toast.classList.add('show');
      clearTimeout(toast._hideTimer);
      toast._hideTimer = setTimeout(() => toast.classList.remove('show'), 4000);
    }

    function enterGuestMode() {
      console.log('[Guest] Preview mode active — browsing without a token');
      window.__GUEST = true;
      document.body.classList.add('guest-mode');

      // Persistent CTA pill — lets the visitor subscribe without waiting for
      // the 5-minute popup.
      const pill = document.getElementById('guestPill');
      if (pill) {
        pill.classList.remove('hidden');
        pill.addEventListener('click', showTokenOverlay);
      }

      // Close (×) on the payment overlay — only rendered in guest mode
      // (display gated on body.guest-mode, see app.css).
      const closeBtn = document.getElementById('paymentOverlayClose');
      if (closeBtn) closeBtn.addEventListener('click', hideTokenOverlay);

      // Hooks for the player (app.html _PLAYER wiring).
      window.__guestPreviewEnded = () => {
        showGuestToast('Preview ended — subscribe to hear the full track');
      };
      window.__guestPreviewDenied = () => {
        showGuestToast('Subscribe to play this — previews are available from the catalogue');
      };

      // Let the app do its initial load — the landing rails are public
      // endpoints. Token-gated calls stay client-blocked by the interceptor.
      window.massAccessReady = true;
      window.dispatchEvent(new CustomEvent('mass:access-ready', {
        detail: { token: null, guest: true }
      }));

      // The 5-minute subscribe popup. The interval keeps ticking: closing the
      // popup just resumes browsing until the next tick.
      setInterval(() => {
        if (overlay.classList.contains('hidden')) showTokenOverlay();
      }, GUEST_POPUP_INTERVAL_MS);
    }

    // Validate an existing token at boot with retries for TRANSIENT failures.
    // A paying subscriber must never be silently downgraded to guest preview
    // mode because of a network blip, an FM hiccup (incl. the record-lock
    // right after a fresh payment), or an in-use-elsewhere conflict — only a
    // definitive "invalid/expired/disabled" verdict may do that.
    async function validateTokenAtBoot(token) {
      const DELAYS = [1500, 3000];
      for (let attempt = 0; ; attempt++) {
        _lastValidateFailure = null;
        const valid = await validateToken(token);
        if (valid) return; // session started (event dispatched in validateToken)
        const failure = _lastValidateFailure || { definitive: false, reason: 'unknown' };

        // Email-claim modal is already up; token stays saved. Nothing to do.
        if (failure.requiresEmail) return;

        if (failure.definitive) {
          console.log('[Access Token] Token definitively invalid — clearing');
          // Await clearAccessToken so currentAccessToken is nulled out before
          // anything else fires — prevents the dead token being attached to
          // fetches the user triggers immediately (e.g. payment initialisation).
          await clearAccessToken();
          if (window.__GUEST_PREVIEW === true) enterGuestMode();
          else showTokenOverlay();
          return;
        }

        if (attempt < DELAYS.length) {
          console.warn(`[Access Token] Transient validation failure (${failure.reason}) — retry ${attempt + 1}/${DELAYS.length}`);
          await new Promise((r) => setTimeout(r, DELAYS[attempt]));
          continue;
        }

        // Still uncertain after retries: KEEP the token and show the overlay
        // (with the error already set by validateToken) so the user can see
        // what's happening and retry — never guest mode, never a wiped token.
        console.warn('[Access Token] Validation still failing after retries — keeping token, showing overlay');
        showTokenOverlay();
        return;
      }
    }

    // Check for existing token on page load
    const existingToken = loadAccessToken();
    if (existingToken) {
      console.log('[Access Token] Found existing token, validating...');
      validateTokenAtBoot(existingToken);
    } else if (window.__GUEST_PREVIEW === true) {
      enterGuestMode();
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
