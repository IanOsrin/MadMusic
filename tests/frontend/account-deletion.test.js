/**
 * Apple Guideline 5.1.1(v): an app that supports account creation must offer
 * account deletion from inside the app. We mint accounts (a trial token against
 * an email), so this is a submission blocker, not a nicety — and it is the kind
 * of requirement that is easy to break silently later by tidying up a button.
 *
 * These are static assertions against the shipped page and modules, in the same
 * spirit as mobile-invariants: the frontend test-net does not exercise this flow
 * for real, so what it CAN prove is that the surface still exists and still
 * refuses to fire on a single tap.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root       = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mobileHtml = readFileSync(join(root, 'public/mobile.html'), 'utf8');
const authJs     = readFileSync(join(root, 'public/js/mobile/auth.js'), 'utf8');
const mainJs     = readFileSync(join(root, 'public/js/mobile/main.js'), 'utf8');
const routeJs    = readFileSync(join(root, 'routes/account.js'), 'utf8');
const engineJs   = readFileSync(join(root, 'lib/account-delete.js'), 'utf8');
const serverJs   = readFileSync(join(root, 'server.js'), 'utf8');
const paymentsJs = readFileSync(join(root, 'routes/payments.js'), 'utf8');

describe('in-app account deletion (Apple 5.1.1(v))', () => {
  it('the profile tab has a delete-account control', () => {
    expect(mobileHtml).toMatch(/id="delete-account-btn"/);
  });

  it('the control is wired to the deletion flow', () => {
    expect(mainJs).toMatch(/deleteAccountFlow/);
    expect(mainJs).toMatch(/delete-account-btn'\)\?\.addEventListener/);
    expect(authJs).toMatch(/export async function deleteAccountFlow/);
  });

  it('is hidden for guests and shown once signed in', () => {
    expect(authJs).toMatch(/deleteBtn\.hidden = !state\.currentUser/);
    expect(mobileHtml).toMatch(/id="delete-account-btn"[^>]*hidden/);
  });

  it('never deletes on a single tap — the confirm step is separate', () => {
    // The flow must render a confirm button and only call the endpoint from it.
    expect(authJs).toMatch(/id="del-confirm"/);
    expect(authJs).toMatch(/id="del-cancel"/);
    const confirmIdx = authJs.indexOf("id=\"del-confirm\"");
    const postIdx    = authJs.indexOf("'/api/account/delete'");
    expect(confirmIdx).toBeGreaterThan(-1);
    expect(postIdx).toBeGreaterThan(confirmIdx);
  });

  it('clears local credentials so the next launch is not left holding a dead token', () => {
    const flow = authJs.slice(authJs.indexOf('export async function deleteAccountFlow'));
    expect(flow).toMatch(/removeItem\('mass_access_token'\)/);
    expect(flow).toMatch(/removeItem\('mass_token_email'\)/);
  });
});

describe('account deletion server contract', () => {
  it('the route is mounted and NOT in the auth skip-list', () => {
    expect(serverJs).toMatch(/app\.use\('\/api\/account', accountRouter\)/);
    // A skip-listed path would let anyone delete anyone's account.
    const skipBlock = serverJs.slice(serverJs.indexOf('const skipPaths'), serverJs.indexOf('skipPaths.some'));
    expect(skipBlock).not.toMatch(/'\/account/);
  });

  it('requires an explicit confirm token in the body', () => {
    expect(routeJs).toMatch(/confirm !== 'DELETE'/);
  });

  it('evicts the validation cache so a deleted token stops working immediately', () => {
    expect(routeJs).toMatch(/tokenValidationCache\.delete/);
  });

  it('reads every token write back — FM silently discards off-layout fields', () => {
    expect(engineJs).toMatch(/fmGetRecordById/);
    expect(engineJs).toMatch(/still carries an email after scrub/);
  });

  it('refuses to act without an identity', () => {
    expect(engineJs).toMatch(/if \(!normalised && !code\)/);
  });

  it('keeps a one-way fingerprint rather than the address', () => {
    expect(engineJs).toMatch(/createHash\('sha256'\)/);
    // The raw address must never be what we retain for dedupe.
    expect(engineJs).toMatch(/canonicalizeEmail/);
  });

  it('deleting an account cannot mint a second free trial', () => {
    expect(paymentsJs).toMatch(/wasAccountDeleted/);
    const trial     = paymentsJs.slice(paymentsJs.indexOf("router.post('/trial'"));
    const checkIdx  = trial.indexOf('wasAccountDeleted');
    const createIdx = trial.indexOf('createAccessToken');
    expect(checkIdx).toBeGreaterThan(-1);
    expect(checkIdx, 'the check must precede token creation').toBeLessThan(createIdx);
  });
});
