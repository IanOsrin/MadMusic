import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isStrictEmail } from '../../lib/validators.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const payments   = readFileSync(join(root, 'routes/payments.js'), 'utf8');
const tokenStore = readFileSync(join(root, 'lib/token-store.js'), 'utf8');

// A paid-for token whose email is the literal string 'unknown' is worse than
// one with no email at all: the send can only fail, and FM stores a fake
// address that breaks the account binding and the free-trial dedupe keyed on
// it. These are source scans rather than behavioural tests because
// routes/payments.js cannot be imported without booting the app — and the
// thing worth guarding is the real file, not a copy of its logic.
describe('Paystack payloads without a customer email', () => {
  it('never invents an address from a missing customer email', () => {
    const offenders = payments
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /customer\?\.email\s*\|\|/.test(line));
    expect(offenders, `payments.js falls back to a literal address:\n` +
      offenders.map(o => `  line ${o.n}: ${o.line}`).join('\n')).toEqual([]);
  });

  it('routes every customer email through the validating helper', () => {
    const reads = (payments.match(/customer\?\.email/g) || []).length;
    const viaHelper = (payments.match(/customerEmail\(\s*(?:data\.data|sub|paymentData)\.customer\?\.email\s*\)/g) || []).length;
    expect(viaHelper).toBe(reads);
  });

  it('logs a manual-action line wherever a token cannot be emailed', () => {
    // One per send site: two subscription paths in the webhook, one in the
    // callback, plus the two one-time paths.
    const sends = (payments.match(/send(?:Token|SubscriptionWelcome)Email\(/g) || []).length;
    // Call sites only — `function warnUndeliverable(` is the declaration.
    const warns = (payments.match(/(?<!function )warnUndeliverable\(/g) || []).length;
    expect(warns).toBe(sends);
  });

  it('keeps the sentinel out of FileMaker in createSubscriptionToken', () => {
    const fn = tokenStore.slice(tokenStore.indexOf('export async function createSubscriptionToken'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toMatch(/realEmail/);
    // The raw parameter must not reach the FM field or the stored token
    expect(body).not.toMatch(/fmFields\['Email'\]\s*=\s*email\b/);
    expect(body).not.toMatch(/email:\s*email\s*\|\|\s*null/);
  });
});

// The helper's own contract. Mirrors routes/payments.js customerEmail(), which
// is not exportable from a route module; isStrictEmail is the real dependency
// and is imported, so the part that decides validity is under test for real.
describe('customerEmail contract', () => {
  const customerEmail = (raw) => {
    const trimmed = String(raw ?? '').trim();
    return isStrictEmail(trimmed) ? trimmed : null;
  };

  it('accepts a real address and trims it', () => {
    expect(customerEmail('  ian@digitalcupboard.net ')).toBe('ian@digitalcupboard.net');
  });

  it('returns null for everything that is not one', () => {
    for (const bad of [undefined, null, '', '   ', 'unknown', 'UNKNOWN', 'not an email', '@nope', 'a@b']) {
      expect(customerEmail(bad), `${JSON.stringify(bad)} should not be treated as an address`).toBeNull();
    }
  });
});
