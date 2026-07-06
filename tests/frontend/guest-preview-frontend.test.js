// Static guards for desktop guest preview mode (2026-07-05). Guest playback
// must never reach a full stream: _PLAYER.playTrack is the single chokepoint
// every desktop playback path routes through, and its guest branch rewrites
// playback to the server-clipped /api/preview/:recordId stream.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appHtml = readFileSync(join(root, 'public', 'app.html'), 'utf8');
const authJs = readFileSync(join(root, 'public', 'js', 'auth.js'), 'utf8');
const playerJs = readFileSync(join(root, 'public', 'js', 'player.js'), 'utf8');

describe('desktop guest preview mode', () => {
  it('_PLAYER.playTrack has the guest rewrite to /api/preview/ (and blocks recordId-less plays)', () => {
    // Locate the _PLAYER IIFE and its playTrack
    const playerIdx = appHtml.indexOf('window._PLAYER =');
    expect(playerIdx, '_PLAYER definition exists').toBeGreaterThan(-1);
    const playTrackIdx = appHtml.indexOf('function playTrack(url, meta)', playerIdx);
    expect(playTrackIdx, '_PLAYER.playTrack exists').toBeGreaterThan(-1);
    const body = appHtml.slice(playTrackIdx, appHtml.indexOf('function playQueue', playTrackIdx));
    expect(body, 'guest branch missing from _PLAYER.playTrack').toMatch(/window\.__GUEST\b/);
    expect(body).toMatch(/\/api\/preview\//);
    // Guests without a recordId must not fall through to the raw URL.
    expect(body).toMatch(/__guestPreviewDenied/);
  });

  it('the 30 s client stop exists in the _PLAYER timeupdate wiring', () => {
    expect(appHtml).toMatch(/window\.__GUEST && player\.currentTime >= 30/);
  });

  it('auth.js boots guest mode only behind window.__GUEST_PREVIEW', () => {
    expect(authJs).toMatch(/window\.__GUEST_PREVIEW === true/);
    expect(authJs, 'enterGuestMode must exist').toMatch(/function enterGuestMode\(\)/);
  });

  it('a token holder only becomes a guest on a DEFINITIVE invalid verdict (with retries first)', () => {
    // Regression (2026-07-06): transient validation failures (network, FM
    // hiccup, post-payment record lock, in-use-elsewhere) silently dropped
    // subscribers into preview mode AND wiped their stored token.
    expect(authJs).toMatch(/function validateTokenAtBoot/);
    const boot = authJs.slice(authJs.indexOf('async function validateTokenAtBoot'));
    // Guest entry + token clearing must be gated on the definitive branch.
    const defIdx = boot.indexOf('failure.definitive');
    const guestIdx = boot.indexOf('enterGuestMode()');
    const clearIdx = boot.indexOf('clearAccessToken()');
    expect(defIdx).toBeGreaterThan(-1);
    expect(guestIdx).toBeGreaterThan(defIdx);
    expect(clearIdx).toBeGreaterThan(defIdx);
    // Transient failures retry, then keep the token and show the overlay.
    expect(boot).toMatch(/retry/i);
    expect(boot).toMatch(/keeping token, showing overlay/);
    // validateToken must classify failures for the boot path.
    expect(authJs).toMatch(/_lastValidateFailure/);
    expect(authJs).toMatch(/invalid token\|expired\|disabled\|not found/);
  });

  it('auth.js does not auto-pop the overlay on 403s in guest mode', () => {
    expect(authJs).toMatch(/if \(!window\.__GUEST\) showTokenOverlay\(\);/);
  });

  it('the interceptor allowlists /api/preview/ so guest playback is not client-blocked', () => {
    expect(authJs).toMatch(/'\/api\/preview\/'/);
  });

  it('the payment overlay close button exists and is guest-gated in CSS', () => {
    expect(appHtml).toMatch(/id="paymentOverlayClose"/);
    const appCss = readFileSync(join(root, 'public', 'css', 'app.css'), 'utf8');
    expect(appCss).toMatch(/body\.guest-mode \.payment-close/);
  });

  it('the ringtone button is suppressed for guests (it carries the full audio URL)', () => {
    const idx = playerJs.indexOf('function showRingtoneBtn');
    expect(idx).toBeGreaterThan(-1);
    const body = playerJs.slice(idx, playerJs.indexOf('function hideRingtoneBtn', idx));
    expect(body).toMatch(/window\.__GUEST/);
  });

  it('the SECOND desktop ringtone wiring (app.html updateRingtoneBtn) is also guest-guarded', () => {
    // app.html has its own updateRingtoneBtn watching the audio element —
    // found showing the button to guests during share-feature verification.
    const idx = appHtml.indexOf('function updateRingtoneBtn');
    expect(idx).toBeGreaterThan(-1);
    const body = appHtml.slice(idx, appHtml.indexOf('function hideRingtoneBtn', idx));
    expect(body).toMatch(/window\.__GUEST/);
  });
});
