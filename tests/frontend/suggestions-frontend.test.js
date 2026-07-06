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

  it('rail opens albums by catalogue (so compilations show tracks)', () => {
    // openAlbumDirect re-searches by artist and returns no tracks for
    // "Various Artists" compilations; the rail must prefer /api/album?cat=.
    expect(appHtml).toMatch(/openSimilarAlbumByCat/);
    expect(appHtml).toContain('data-cat=');
    expect(appHtml).toMatch(/\/api\/album\?cat=/);
  });

  it('rail respects the server-injected feature flag (skips fetch when off)', () => {
    expect(appHtml).toContain('window.__SUGGESTIONS');
    expect(serverJs).toContain('window.__SUGGESTIONS=');
  });
});

describe('Similar-albums endless radio (2026-07-06)', () => {
  const playerJs = readFileSync(join(root, 'public', 'js', 'player.js'), 'utf8');

  it('player.js supports a refill hook instead of stopping at queue end', () => {
    expect(playerJs).toMatch(/shuffleRefillFn/);
    expect(playerJs).toMatch(/_refillShuffleQueue/);
    // The hook must be consulted BEFORE the stop path in _shuffleAdvance.
    const adv = playerJs.slice(playerJs.indexOf('function _shuffleAdvance'));
    expect(adv.indexOf('shuffleRefillFn')).toBeLessThan(adv.indexOf('stopShufflePlay()'));
  });

  it('non-radio shuffles clear the refill hook (no cross-contamination)', () => {
    // startShufflePlay / startShuffleFromItems / stopShufflePlay must all reset
    // the hook, or a random-cards shuffle would inherit the similar-albums refill.
    const resets = playerJs.match(/shuffleRefillFn = null/g) || [];
    expect(resets.length).toBeGreaterThanOrEqual(3);
  });

  it('"Shuffle these" registers a refill seeded by the last-played catalogue', () => {
    expect(appHtml).toMatch(/refillFromSimilar/);
    expect(appHtml).toMatch(/startShuffleTracks\(descriptors, \{ refill: refillFromSimilar \}\)/);
    // The refill re-queries suggestions by the LAST descriptor's cat.
    const refill = appHtml.slice(appHtml.indexOf('async function refillFromSimilar'));
    expect(refill).toMatch(/last && last\.cat/);
    expect(refill.slice(0, 900)).toMatch(/\/api\/suggestions\?cat=/);
  });
});
