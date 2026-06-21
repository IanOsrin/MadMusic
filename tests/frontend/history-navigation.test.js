// Guards for the SPA Back/Forward history router (desktop MADRouter + mobile
// router.js). Static source scans — the visual/structural nets don't exercise
// history behaviour, so these encode the wiring + the no-stale-URL invariant so a
// future agent that breaks them fails CI instead of shipping a silent regression.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

const appHtml = read('public', 'app.html');
const appMin = read('public', 'app.min.js');
const catalog = read('public', 'js', 'catalog.js');

const mobileDir = join(root, 'public', 'js', 'mobile');
const mobileFiles = Object.fromEntries(
  readdirSync(mobileDir).filter((f) => f.endsWith('.js')).map((f) => [f, readFileSync(join(mobileDir, f), 'utf8')]),
);
const mobileAll = Object.values(mobileFiles).join('\n');

// Lines that call history.pushState/replaceState — used by the no-stale-URL guard.
const historyCallLines = (src) =>
  src.split('\n').filter((l) => /\.(pushState|replaceState)\s*\(/.test(l));

describe('desktop history router (app.html MADRouter)', () => {
  it('defines window.MADRouter and window.navigateToView', () => {
    expect(appHtml).toMatch(/window\.MADRouter\s*=/);
    expect(appHtml).toMatch(/window\.navigateToView\s*=/);
  });

  it('seeds a root floor + live view entry (stay-on-home-once)', () => {
    expect(appHtml).toMatch(/kind:\s*'root'/);
    expect(appHtml).toMatch(/kind:\s*'view'/);
  });

  it('routes overlay opens through MADRouter.pushOverlay with an id (no bare MADNav.push calls)', () => {
    // The 4 former MADNav.push() sites now carry identity.
    expect(appHtml).toMatch(/MADRouter\.pushOverlay\('album'/);
    expect(appHtml).toMatch(/MADRouter\.pushOverlay\('user-playlist'/);
    expect(appHtml).toMatch(/MADRouter\.pushOverlay\('public-playlist'/);
    expect(catalog).toMatch(/MADRouter\.pushOverlay\('catalog-playlist'/);
    // No leftover MADNav.push() CALLS anywhere (the shim is `push: function`, not a call).
    expect(appHtml).not.toMatch(/MADNav\.push\s*\(/);
    expect(catalog).not.toMatch(/MADNav\.push\s*\(/);
  });

  it('app.min.js share popstate yields to MADRouter-owned entries', () => {
    expect(appMin).toMatch(/e\.state\s*&&\s*e\.state\.mad\)\s*return/);
  });

  it('share/download URL cleaners preserve the history.state marker (not null/{})', () => {
    expect(appHtml).not.toMatch(/replaceState\(\s*null\s*,/);
    expect(appHtml).toMatch(/replaceState\(\s*history\.state\s*,/);
  });
});

describe('mobile history router (js/mobile/router.js)', () => {
  it('router.js exports the router API and listens for popstate', () => {
    const r = mobileFiles['router.js'];
    expect(r, 'router.js exists').toBeTruthy();
    expect(r).toMatch(/export function initRouter/);
    expect(r).toMatch(/export function pushTab/);
    expect(r).toMatch(/export function pushOverlay/);
    expect(r).toMatch(/export function isRestoring/);
    expect(r).toMatch(/addEventListener\(\s*'popstate'/);
    expect(r).toMatch(/replaceState\(.*kind:\s*'root'/);
  });

  it('switchTab records history, guarded against restore + active-tab refresh', () => {
    const nav = mobileFiles['nav.js'];
    expect(nav).toMatch(/import\s*\{[^}]*pushTab[^}]*\}\s*from\s*'\.\/router\.js'/);
    expect(nav).toMatch(/!wasAlreadyActive\s*&&\s*!isRestoring\(\)\)\s*pushTab/);
  });

  it('main.js wires initRouter() after init()', () => {
    expect(mobileFiles['main.js']).toMatch(/initRouter\(\)/);
  });

  it('closeModal pops its overlay entry so Back has no phantom stop', () => {
    const p = mobileFiles['player.js'];
    expect(p).toMatch(/kind\s*===\s*'overlay'/);
    expect(p).toMatch(/history\.back\(\)/);
  });

  it('drill-down modals push an overlay entry', () => {
    expect(mobileFiles['cards.js']).toMatch(/pushOverlay\('album-tracks'/);
    expect(mobileFiles['playlists.js']).toMatch(/pushOverlay\('playlist-tracks'/);
    expect(mobileFiles['rails-g100.js']).toMatch(/pushOverlay\('g100-playlist'/);
  });
});

describe('history state never carries expiring FM URLs (CLAUDE.md invariant #2)', () => {
  // history.state must hold stable ids only — a stored RCType=RCFileProcessor URL
  // would 401 on Forward-restore.
  for (const [label, src] of [['app.html', appHtml], ['app.min.js', appMin], ['mobile', mobileAll]]) {
    it(`${label}: no pushState/replaceState line embeds RCFileProcessor`, () => {
      const offenders = historyCallLines(src).filter((l) => l.includes('RCFileProcessor'));
      expect(offenders).toEqual([]);
    });
  }
});
