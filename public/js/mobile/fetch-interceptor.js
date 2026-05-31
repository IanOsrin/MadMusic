// Access-token fetch interceptor for the mobile app.
// MUST load (classic <script>) before the module graph and before any API
// call (incl. the ringtone inline script). Patches window.fetch in place.
    // ===== Fetch Interceptor for Access Token =====
    // This must run FIRST to intercept all API calls
    (function() {
      const originalFetch = window.fetch;

      window.fetch = function(url, options = {}) {
        const isApiCall = url.includes('/api/') || url.startsWith('/api/');

        if (isApiCall) {
          const accessToken = localStorage.getItem('mass_access_token');

          if (accessToken) {
            // Initialize headers if not present
            if (!options.headers) {
              options.headers = {};
            }

            // Add access token header
            if (options.headers instanceof Headers) {
              options.headers.set('X-Access-Token', accessToken);
            } else if (typeof options.headers === 'object') {
              options.headers['X-Access-Token'] = accessToken;
            }
          }
        }

        // Call original fetch
        return originalFetch(url, options);
      };
    })();
