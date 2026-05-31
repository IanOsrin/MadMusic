// Deterministic page harness for the visual/behavior baseline.
//
// Seeds a valid access token into localStorage, replays captured /api fixtures so
// rails populate identically every run, serves a fixed placeholder for artwork,
// and blocks external network (fonts, analytics) so screenshots are reproducible
// offline. The real backend is never contacted.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

const ACCESS_TOKEN = 'MASS-UNLIMITED-ACCESS';
const SESSION_ID = 'pw-baseline-session';

// 2x2 grey PNG used for every artwork container so images are byte-identical.
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNkYPhfz0AEYBxVSF8FAHc9B/4qY4Z2AAAAAElFTkSuQmCC',
  'base64',
);

function fixture(name) {
  const p = join(FIXTURES, `${name}.json`);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

// Map an /api pathname (no query) to a fixture name. Returns null if none.
function fixtureForPath(pathname) {
  const map = {
    '/api/new-releases': 'new-releases',
    '/api/singles': 'singles',
    '/api/trending': 'trending',
    '/api/featured-albums': 'featured-albums',
    '/api/genres': 'genres',
    '/api/public-playlists': 'public-playlists',
    '/api/random-songs': 'random-songs',
    '/api/my-stats': 'my-stats',
    '/api/access/validate': 'access-validate',
  };
  return map[pathname] || null;
}

// Install all routing + storage seeding on a page. Call before page.goto().
export async function primePage(page) {
  // Seed token + suppress cookie banner / dark mode before any app script runs.
  await page.addInitScript(
    ([token, sessionId]) => {
      try {
        localStorage.setItem('mass_access_token', token);
        localStorage.setItem('mass_session_id', sessionId);
        localStorage.setItem('mass_token_email', 'baseline@example.com');
        localStorage.setItem('cookie_consent', 'true');
        localStorage.setItem('cookieConsent', 'true');
        localStorage.setItem('mass_dark_mode', 'false');
      } catch (_) { /* storage may be unavailable; ignore */ }
    },
    [ACCESS_TOKEN, SESSION_ID],
  );

  // IMPORTANT: Playwright runs the LAST-registered matching handler first, and
  // route.continue() goes to the network — not to other handlers. So register
  // from most-general to most-specific; the specific ones shadow the general one.

  // (1) Most general: block external network (fonts, GTM, CDNs); pass through local.
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return route.continue();
    return route.abort();
  });

  // (2) Any /api/** → fixture, or a safe empty default. Shadows the handler above.
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    const name = fixtureForPath(url.pathname);
    const body = name && fixture(name);
    if (body) {
      return route.fulfill({ status: 200, contentType: 'application/json', body });
    }
    // Unknown endpoint: succeed emptily so the page never errors or hangs.
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, items: [] }),
    });
  });

  // (3) Most specific: artwork proxy → deterministic placeholder. Shadows (2).
  await page.route('**/api/container**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PLACEHOLDER_PNG }),
  );
}

export { ACCESS_TOKEN, SESSION_ID };
