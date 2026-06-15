// Static guards for the desktop "Similar albums" rail. These encode the two
// landmines hit while building the feature: (1) /api/suggestions must be in the
// client-side public-endpoint allowlist or the fetch interceptor blocks it as a
// no-token call; (2) the rail markup + render wiring must stay present in
// app.html. Source scans only — no backend.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const authJs = readFileSync(join(root, 'public', 'js', 'auth.js'), 'utf8');
const appHtml = readFileSync(join(root, 'public', 'app.html'), 'utf8');
const serverJs = readFileSync(join(root, 'server.js'), 'utf8');

describe('Similar-albums frontend wiring', () => {
  it('client public-endpoint allowlist includes /api/suggestions', () => {
    // The fetch interceptor blocks any /api/* call without a token unless it's
    // listed here — suggestions is public catalogue content.
    expect(authJs).toMatch(/['"]\/api\/suggestions['"]/);
  });

  it('app.html contains the rail markup and render wiring', () => {
    expect(appHtml).toContain('id="similarAlbumsSection"');
    expect(appHtml).toContain('id="similarAlbumsRail"');
    expect(appHtml).toMatch(/function\s+renderSimilarAlbums/);
    // The rail must be invoked from the album detail panel.
    expect(appHtml).toMatch(/renderSimilarAlbums\(album\)/);
    // Cards navigate via the shared album opener.
    expect(appHtml).toMatch(/openAlbumDirect\(/);
  });

  it('rail respects the server-injected feature flag (skips fetch when off)', () => {
    expect(appHtml).toContain('window.__SUGGESTIONS');
    expect(serverJs).toContain('window.__SUGGESTIONS=');
  });
});
