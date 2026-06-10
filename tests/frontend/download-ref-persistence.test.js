// Guards the paid-download reference handoff in app.html. The security fix in
// routes/download.js deliberately strips the Paystack ref from the callback's
// browser-facing URL (it is a replayable bearer token for /api/download/file),
// so the frontend MUST persist the ref across the Paystack redirect itself.
// This contract broke once in production (paid, no download, no error) — these
// static scans make sure neither half regresses again.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appHtml = readFileSync(join(root, 'public', 'app.html'), 'utf8');
const downloadRoute = readFileSync(join(root, 'routes', 'download.js'), 'utf8');

describe('download ref persistence (app.html ↔ download.js contract)', () => {
  it('initiate handler saves the Paystack ref to sessionStorage before redirecting', () => {
    // The save must happen in the same block that performs the Paystack redirect.
    const idx = appHtml.indexOf("sessionStorage.setItem('mass_download_ref'");
    expect(idx, 'initiate flow must persist mass_download_ref').toBeGreaterThan(-1);
    const window = appHtml.slice(idx, idx + 800);
    expect(window).toMatch(/window\.location\.href = data\.authorization_url/);
  });

  it('return handler recovers the ref from sessionStorage (not only the URL)', () => {
    expect(appHtml).toMatch(/sessionStorage\.getItem\('mass_download_ref'\)/);
    // Single-use: the stored ref must be removed once read.
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
  });
});
