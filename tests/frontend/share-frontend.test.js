// Static guards for the social-share feature (2026-07-06). The share loop:
// share button → /?t=<recordId> URL → server-injected OG tags (crawlers) +
// __SHARE_TRACK bootstrap (humans) → album reveal + guest 30 s previews.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appHtml = readFileSync(join(root, 'public', 'app.html'), 'utf8');
const mobileHtml = readFileSync(join(root, 'public', 'mobile.html'), 'utf8');
const mobileMain = readFileSync(join(root, 'public', 'js', 'mobile', 'main.js'), 'utf8');
const serverJs = readFileSync(join(root, 'server.js'), 'utf8');

describe('desktop share wiring', () => {
  it('MADShare helper exists with native-share-first + popover fallback', () => {
    expect(appHtml).toMatch(/window\.MADShare = \{/);
    expect(appHtml).toMatch(/navigator\.share/);
    expect(appHtml).toMatch(/id="sharePopover"/);
  });

  it('player bar has the share button and _PLAYER stashes the now-playing identity', () => {
    expect(appHtml).toMatch(/id="upShareBtn"/);
    expect(appHtml).toMatch(/window\.__nowPlayingShare/);
  });

  it('playlist share modal has the social row', () => {
    expect(appHtml).toMatch(/id="shareModalSocial"/);
    expect(appHtml).toMatch(/data-share-to="facebook"/);
    expect(appHtml).toMatch(/data-share-to="whatsapp"/);
  });

  it('share deep link reveals the album via the existing mad-reveal-album flow', () => {
    expect(appHtml).toMatch(/window\.__SHARE_TRACK/);
    // Reuses the reveal event — no duplicated album-open logic.
    const deepLink = appHtml.slice(appHtml.indexOf('var st = window.__SHARE_TRACK'));
    expect(deepLink.slice(0, 900)).toMatch(/mad-reveal-album/);
  });
});

describe('mobile share wiring', () => {
  it('player modal has the share button with a native-sheet handler', () => {
    expect(mobileHtml).toMatch(/id="share-track-btn"/);
    expect(mobileMain).toMatch(/share-track-btn/);
    expect(mobileMain).toMatch(/navigator\.share/);
  });

  it('mobile handles the /?t= deep link via __SHARE_TRACK + public /api/album?cat=', () => {
    expect(mobileMain).toMatch(/function handleShareDeepLink/);
    expect(mobileMain).toMatch(/window\.__SHARE_TRACK/);
    expect(mobileMain).toMatch(/showAlbumTracksModal\(/);
    // Deep link must run for BOTH guest and token boots.
    const guestIdx = mobileMain.indexOf('enterGuestMode()');
    const guestBlock = mobileMain.slice(guestIdx, guestIdx + 300);
    expect(guestBlock).toMatch(/handleShareDeepLink\(\)/);
  });
});

describe('server share landing', () => {
  it('injects OG tags for /?t= and /?share= and redirects phones to /mobile', () => {
    expect(serverJs).toMatch(/function sendShareLanding/);
    expect(serverJs).toMatch(/getTrackShareMeta/);
    expect(serverJs).toMatch(/\/mobile\?t=/);
  });
});
