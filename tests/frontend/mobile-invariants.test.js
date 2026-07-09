// Enforces the mobile.html invariants documented in CLAUDE.md, so a future
// agent that trips one fails CI instead of shipping a silent bug. These are
// static source scans (no backend) — they encode the landmines that the visual
// net cannot catch.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The mobile app's JS was externalized from an inline <script> in mobile.html
// into the public/js/mobile/ module graph (main.js + fetch-interceptor.js). Scan
// markup + every mobile module so these source checks hold wherever the code
// lives (markup stays in mobile.html; functions live in the modules).
const mobileHtml = readFileSync(join(root, 'public', 'mobile.html'), 'utf8');
const mobileDir = join(root, 'public', 'js', 'mobile');
const mobileJs = readdirSync(mobileDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(join(mobileDir, f), 'utf8'))
  .join('\n');
const mobile = mobileHtml + '\n' + mobileJs;
const helpers = readFileSync(join(root, 'public', 'js', 'helpers.js'), 'utf8');

// Brace-matched extraction of `function NAME(...) {...}` (handles default-param
// object literals via paren-then-brace matching).
function extractFn(src, name) {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!m) return null;
  let p = src.indexOf('(', m.index), pd = 0, q = p;
  for (; q < src.length; q++) { const c = src[q]; if (c === '(') pd++; else if (c === ')') { pd--; if (pd === 0) { q++; break; } } }
  let b = src.indexOf('{', q), bd = 0, k = b;
  for (; k < src.length; k++) { const c = src[k]; if (c === '{') bd++; else if (c === '}') { bd--; if (bd === 0) { k++; break; } } }
  return src.slice(m.index, k);
}

const lines = (src) => src.split('\n').map((l, i) => ({ n: i + 1, l }));

describe('mobile invariant: album grouping keys use getAlbumArtist (not track-first getArtistField)', () => {
  // Using getArtistField (track-first) in an album|||artist grouping key splits a
  // compilation into one card per track artist. (CLAUDE.md invariant #1.)
  it('no album-key (|||) line calls getArtistField, in mobile.html or helpers.js', () => {
    for (const [file, src] of [['mobile.html', mobile], ['helpers.js', helpers]]) {
      const offenders = lines(src).filter(({ l }) => l.includes('|||') && /\bgetArtistField\s*\(/.test(l));
      expect(offenders.map((o) => `${file}:${o.n}`), 'grouping key uses track-first getArtistField').toEqual([]);
    }
  });

  it('no albumArtist variable is assigned from getArtistField in mobile.html', () => {
    const offenders = lines(mobile).filter(({ l }) => /albumArtist\s*[:=]\s*getArtistField\s*\(/.test(l));
    expect(offenders.map((o) => `mobile.html:${o.n}`), 'albumArtist must come from getAlbumArtist').toEqual([]);
  });

  it('helpers.js groupByAlbum keys on getAlbumArtist', () => {
    const body = extractFn(helpers, 'groupByAlbum');
    expect(body, 'groupByAlbum exists').toBeTruthy();
    expect(body).toMatch(/getAlbumArtist\s*\(/);
  });
});

describe('mobile invariant: shared utilities delegate to window.MADHelpers (no re-grown local copies)', () => {
  // A re-implemented local copy drifts from canonical and reintroduces bugs like
  // the 5-field hasValidAudio that hid playable tracks. (CLAUDE.md.)
  const DELEGATED = [
    'getFieldValue', 'getTitleField', 'getAlbumField', 'getGenreField',
    'getArtistField', 'getAlbumArtist', 'hasValidAudio',
  ];

  for (const name of DELEGATED) {
    it(`mobile.html ${name}() is a delegation to window.MADHelpers.${name}`, () => {
      const body = extractFn(mobile, name);
      expect(body, `${name} is defined in mobile.html`).toBeTruthy();
      expect(body, `${name} must delegate to window.MADHelpers.${name}, not re-implement it`)
        .toMatch(new RegExp(`window\\.MADHelpers\\.${name}\\b`));
    });
  }
});

describe('mobile invariant: the access gate offers the 7-day free trial', () => {
  // The trial is the mobile acquisition path (2026-07-03 urgent fix): both the
  // no-token gate (main.js empty state) and the Profile tab must offer it, and
  // it must hit the same endpoint the desktop gate uses.
  it('the no-token empty state includes a Start 7-Day Free Trial button', () => {
    const mainJs = readFileSync(join(mobileDir, 'main.js'), 'utf8');
    expect(mainJs).toMatch(/Access Token Required[\s\S]*startTrial\(\)/);
    expect(mainJs).toMatch(/Start 7-Day Free Trial/);
  });

  it('the Profile tab has the trial button and main.js wires + exposes startTrial', () => {
    expect(mobileHtml).toMatch(/id="trial-btn"/);
    const mainJs = readFileSync(join(mobileDir, 'main.js'), 'utf8');
    expect(mainJs).toMatch(/getElementById\('trial-btn'\)/);
    expect(mainJs, 'startTrial must be window-exposed for inline onclick').toMatch(/Object\.assign\(window,[\s\S]*startTrial/);
  });

  it('startTrial posts to /api/payments/trial and stores the token under mass_access_token', () => {
    const authJs = readFileSync(join(mobileDir, 'auth.js'), 'utf8');
    const body = extractFn(authJs, 'startTrial');
    expect(body, 'startTrial exists in auth.js').toBeTruthy();
    expect(body).toMatch(/\/api\/payments\/trial/);
    expect(body).toMatch(/mass_access_token/);
  });
});

describe('mobile invariant: guest preview mode never leaks a full stream', () => {
  // Guest playback must route through the server-clipped /api/preview/:recordId
  // endpoint. If the guest branch in playTrack disappears (or falls through to
  // the /api/container resolution), token-less visitors get FULL tracks.
  it('playTrack has a window.__GUEST branch that uses /api/preview/ and never /api/container', () => {
    const playerJs = readFileSync(join(mobileDir, 'player.js'), 'utf8');
    const body = extractFn(playerJs, 'playTrack');
    expect(body, 'playTrack exists in player.js').toBeTruthy();
    expect(body, 'guest branch missing').toMatch(/window\.__GUEST\b/);
    expect(body).toMatch(/\/api\/preview\//);
    // The container resolution must sit in the NON-guest branch: the guest
    // branch must return/assign before any /api/container use.
    const guestIdx = body.indexOf('window.__GUEST');
    const containerIdx = body.indexOf('/api/container');
    expect(guestIdx, 'guest check must come before container resolution').toBeLessThan(containerIdx);
  });

  // The clipped preview keeps the FULL track's header, so audio.duration
  // lies for guests. updateProgress must fill the bar against the capped
  // preview length and label the total honestly ("0:30 of 6:08").
  it('updateProgress caps the guest bar at the preview length and labels "of full"', () => {
    const playerJs = readFileSync(join(mobileDir, 'player.js'), 'utf8');
    const body = extractFn(playerJs, 'updateProgress');
    expect(body, 'updateProgress exists').toBeTruthy();
    expect(body).toMatch(/window\.__GUEST && total > GUEST_PREVIEW_SECS/);
    expect(body).toMatch(/isPreview \? GUEST_PREVIEW_SECS : total/);
    expect(body).toMatch(/of \$\{formatTime\(total\)\}/);
  });

  it('main.js boots guest mode only behind window.__GUEST_PREVIEW', () => {
    const mainJs = readFileSync(join(mobileDir, 'main.js'), 'utf8');
    expect(mainJs).toMatch(/window\.__GUEST_PREVIEW === true/);
    expect(mainJs, 'guest boot must call enterGuestMode').toMatch(/enterGuestMode\(\)/);
  });

  it('the 30 s client stop exists in the timeupdate listener', () => {
    const mainJs = readFileSync(join(mobileDir, 'main.js'), 'utf8');
    expect(mainJs).toMatch(/window\.__GUEST && elements\.audio\.currentTime >= 30/);
  });

  it('the ringtone button is suppressed for guests (it carries the audio src URL)', () => {
    const fnBody = extractFn(mobileHtml, 'updateRingtoneBtn');
    expect(fnBody, 'updateRingtoneBtn exists in mobile.html').toBeTruthy();
    expect(fnBody).toMatch(/window\.__GUEST/);
  });

  it('auth.js paywall sheet is dismissible and offers trial + buy + token', () => {
    const authJs = readFileSync(join(mobileDir, 'auth.js'), 'utf8');
    expect(authJs).toMatch(/guest-paywall-close/);
    expect(authJs).toMatch(/guest-paywall-trial/);
    expect(authJs).toMatch(/guest-paywall-buy/);
    expect(authJs).toMatch(/guest-paywall-token/);
  });
});
