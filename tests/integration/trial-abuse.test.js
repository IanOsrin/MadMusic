import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The 2026-08-27 abuse fix: trial tokens were returned in the HTTP response,
// so the email was never verified — invented addresses minted unlimited
// trials, and the JSON-only dedupe forgot everything on redeploy. These tests
// pin the new contract: token travels ONLY by email, dedupe is canonical, and
// a failed send rolls the token back so the address can retry.
//
// 2026-09-26 (Ian): "straight on, confirm later" — the response carries a
// 1-DAY code so the listener is in at once; the email's signed Confirm link
// extends it to 7 days. An invented address gets a day, not a week.

const sendTrialEmailMock = vi.fn(async () => {});

vi.mock('../../lib/email.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    // Truthy transporter so the route doesn't 503; sends are mocked.
    emailTransporter: { mocked: true },
    sendTrialEmail: (...args) => sendTrialEmailMock(...args),
  };
});

let app;

beforeAll(async () => {
  // Keep the token store out of the repo's real data/ directory.
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'mad-trial-test-'));
  const mod = await import('../../server.js');
  app = mod.app;
});

describe('free-trial abuse hardening (2026-08-27)', () => {
  it('signs straight on with a 1-day code and emails a signed Confirm link', async () => {
    const res = await request(app).post('/api/payments/trial').send({ email: 'first@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.token).toMatch(/^MASS-/);
    expect(res.body.confirmWithinHours).toBe(24);
    expect(sendTrialEmailMock).toHaveBeenCalledWith(
      'first@example.com', res.body.token,
      expect.stringMatching(/\/api\/payments\/trial\/confirm\?t=MASS-[^&]+&s=[A-Za-z0-9_-]{32}$/));
    const { loadAccessTokens } = await import('../../lib/token-store.js');
    const stored = (await loadAccessTokens()).tokens.find((t) => t.code === res.body.token);
    const days = (new Date(stored.expirationDate) - new Date(stored.issuedDate)) / 86_400_000;
    expect(Math.round(days)).toBe(1);
  });

  it('refuses a Confirm link whose signature does not match', async () => {
    const res = await request(app).get('/api/payments/trial/confirm?t=MASS-AAA-BBB&s=not-the-signature-at-all-1234567');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/didn’t work/);
    expect(res.text).not.toMatch(/Start listening/);
  });

  it('blocks a second trial for the same email', async () => {
    const res = await request(app).post('/api/payments/trial').send({ email: 'first@example.com' });
    expect(res.status).toBe(409);
  });

  it('blocks gmail plus/dot aliases of an already-used address', async () => {
    await request(app).post('/api/payments/trial').send({ email: 'claimant@gmail.com' });
    for (const alias of ['claimant+2@gmail.com', 'clai.mant@gmail.com', 'CLAIMANT+x@googlemail.com']) {
      const res = await request(app).post('/api/payments/trial').send({ email: alias });
      expect(res.status, alias).toBe(409);
    }
  });

  it('rolls the token back when the email fails to send, so the address can retry', async () => {
    sendTrialEmailMock.mockRejectedValueOnce(new Error('smtp down'));
    const fail = await request(app).post('/api/payments/trial').send({ email: 'retry@example.com' });
    expect(fail.status).toBe(502);

    const retry = await request(app).post('/api/payments/trial').send({ email: 'retry@example.com' });
    expect(retry.status).toBe(200);
    expect(retry.body.sent).toBe(true);
  });
});

describe('canonicalizeEmail', () => {
  it('collapses aliases to the delivering mailbox', async () => {
    const { canonicalizeEmail } = await import('../../lib/validators.js');
    expect(canonicalizeEmail('Ian+trial2@Gmail.com')).toBe('ian@gmail.com');
    expect(canonicalizeEmail('i.a.n@googlemail.com')).toBe('ian@gmail.com');
    expect(canonicalizeEmail('ian+x@company.co.za')).toBe('ian@company.co.za');
    // non-gmail dots are meaningful and must be kept
    expect(canonicalizeEmail('ian.osrin@company.co.za')).toBe('ian.osrin@company.co.za');
  });
});
