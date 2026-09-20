// Guards the paid-download reference handoff. routes/download.js deliberately
// strips the Paystack ref from the callback's browser-facing URL (it is a
// replayable bearer token for /api/download/file), so the FRONTEND must carry
// the ref across the redirect itself. This contract broke once in production
// (paid, no download, no error), hence these static scans.
//
// The buying flow moved to the basket on 2026-09-21 — the single-track button
// in app.html was removed — so the scans now follow public/js/basket.js. The
// return handler in app.html stays for links already in customers' inboxes.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appHtml = readFileSync(join(root, 'public', 'app.html'), 'utf8');
const basketJs = readFileSync(join(root, 'public', 'js', 'basket.js'), 'utf8');
const downloadRoute = readFileSync(join(root, 'routes', 'download.js'), 'utf8');

describe('download ref persistence (app.html ↔ download.js contract)', () => {
  it('basket checkout saves the reference before redirecting to Paystack', () => {
    const idx = basketJs.indexOf('sessionStorage.setItem(PENDING');
    expect(idx, 'checkout must persist the basket reference').toBeGreaterThan(-1);
    const after = basketJs.slice(idx, idx + 800);
    expect(after).toMatch(/window\.location\.href = data\.authorization_url/);
  });

  it('basket return handler reads that reference once and clears it', () => {
    expect(basketJs).toMatch(/sessionStorage\.getItem\(PENDING\)/);
    expect(basketJs).toMatch(/sessionStorage\.removeItem\(PENDING\)/);
  });

  it('a basket that loses its reference still tells the buyer what happened', () => {
    // The old bug was a silent `if (!ref) return;`. The links are emailed too,
    // so the fallback must SAY so rather than dead-end.
    const idx = basketJs.indexOf('function handleReturn');
    const handler = basketJs.slice(idx, idx + 1400);
    expect(handler).toMatch(/toast\(/);
    expect(handler).toMatch(/emailed/i);
  });

  it('the old single-track buy button is gone, so buying has one path', () => {
    expect(appHtml).not.toMatch(/track-download-btn/);
  });

  it('return handler recovers the old single-track ref from sessionStorage', () => {
    // Still needed: links bought before the basket are in inboxes.
    expect(appHtml).toMatch(/sessionStorage\.getItem\('mass_download_ref'\)/);
    expect(appHtml).toMatch(/sessionStorage\.removeItem\('mass_download_ref'\)/);
  });

  it('return handler never fails silently when the ref is missing', () => {
    // The old bug: `if (!ref) return;` with no user feedback. Require a toast
    // (or at minimum a console.warn) on the missing-ref path.
    const handlerIdx = appHtml.indexOf('Handle return from Paystack download payment');
    expect(handlerIdx).toBeGreaterThan(-1);
    const handler = appHtml.slice(handlerIdx, handlerIdx + 3000);
    expect(handler).toMatch(/no stored reference/);
    expect(handler).toMatch(/MADShowToast/);
  });

  it('backend callback still strips the ref from the browser-facing URL', () => {
    // If someone re-adds ref to the redirect, the sessionStorage dance becomes
    // a security hole's companion rather than its replacement — flag it.
    const cbIdx = downloadRoute.indexOf("router.get('/callback'");
    const cb = downloadRoute.slice(cbIdx, downloadRoute.indexOf("router.get('/file'"));
    expect(cb).toMatch(/download=success/);
    expect(cb).not.toMatch(/download=success[^`']*ref=/);
    // The basket return carries a count, never the reference.
    expect(cb).toMatch(/download=basket/);
    expect(cb).not.toMatch(/download=basket[^`']*ref=/);
  });
});
