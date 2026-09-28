import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Paystack monthly renewals (fixed 2026-09-28). Found: all 15 Paystack subscription codes
// expired after month one — the subscription link was never saved ("sub: null"), renewals were
// looked up in the deploy-wiped JSON file, and a renewal charge without a subscription_code fell
// through to the one-time path (a fresh 7-day code). These tests pin the new behaviour against
// FileMaker (faked in memory), with Paystack-shaped, correctly signed events.

const fm = { rows: [] };
vi.mock('../../fm-client.js', async (importOriginal) => {
  const mod = await importOriginal();
  const want = (v) => String(v).replace(/^==/, '').replace(/\\(.)/g, '$1');   // undo FM find escaping (\@ etc.)
  return {
    ...mod,
    fmCreateRecord: vi.fn(async (_l, fieldData) => { fm.rows.push({ recordId: String(fm.rows.length + 1), fieldData: { Issued_Date: '9/1/2026 10:00:00', ...fieldData } }); return {}; }),
    fmFindRecords: vi.fn(async (_l, queries) => {
      const data = fm.rows.filter((r) => queries.some((q) => Object.entries(q).every(([k, v]) => String(r.fieldData[k] ?? '').toLowerCase() === want(v).toLowerCase())));
      return data.length ? { ok: true, data, total: data.length } : { ok: false, code: '401', data: [], total: 0 };
    }),
    fmUpdateRecord: vi.fn(async (_l, id, fields) => { Object.assign(fm.rows.find((r) => r.recordId === id).fieldData, fields); }),
  };
});
const welcome = [];
vi.mock('../../lib/email.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, sendSubscriptionWelcomeEmail: vi.fn(async (...a) => { welcome.push(a); }), sendTokenEmail: vi.fn(async () => {}) };
});

let app, caches;
beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'mad-renewals-'));
  process.env.FM_TIMEZONE_OFFSET = '0';
  ({ app } = await import('../../server.js'));
  caches = await import('../../cache.js');
});
beforeEach(() => {
  caches.pendingPaymentsCache.clear();
  caches.processedWebhookEventsCache.clear();
  fm.rows.length = 0;
  welcome.length = 0;
});

const post = (event) => {
  const raw = JSON.stringify(event);
  return request(app).post('/api/payments/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Paystack-Signature', createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(raw).digest('hex'))
    .send(raw);
};
const PLAN = { plan_code: 'PLN_monthly', interval: 'monthly', name: 'Monthly Subscription' };
const customer = { email: 'fan@example.com' };
const iso = (daysFromNow) => new Date(Date.now() + daysFromNow * 864e5).toISOString();
const parseFm = (s) => new Date(s);
// A code the payment callback made in month one: "sub: null", used, now lapsed.
function lapsedCode({ expiredDaysAgo = 20, notes } = {}) {
  const exp = new Date(Date.now() - expiredDaysAgo * 864e5);
  fm.rows.push({ recordId: '1', fieldData: {
    Token_Code: 'MASS-SUB-001', Token_Type: 'subscription', Active: 1, Email: 'fan@example.com',
    Issued_Date: '8/1/2026 10:00:00', First_Used: '8/1/2026 10:01:00',
    Expiration_Date: `${exp.getMonth() + 1}/${exp.getDate()}/${exp.getFullYear()} 10:01:00`,
    Token_Duration_Hours: String(31 * 86400),
    Notes: notes || 'Paystack subscription (fan@example.com, sub: null, plan: PLN_monthly)',
  } });
  return fm.rows[0].fieldData;
}

describe('Paystack subscription renewals', () => {
  it('a renewal charge (plan, no subscription_code) extends the customer’s own code', async () => {
    const f = lapsedCode();
    const res = await post({ event: 'charge.success', data: { reference: 'T-RENEW-1', status: 'success', paid_at: iso(0), plan: PLAN, customer } });
    expect(res.status).toBe(200);
    const exp = parseFm(f.Expiration_Date);
    expect(exp.getTime()).toBeGreaterThan(Date.now() + 30 * 864e5);
    expect(f.Notes).toMatch(/\[renewed .* ref T-RENEW-1\]/);
    expect(fm.rows).toHaveLength(1);                 // no fresh 7-day code
    expect(welcome).toHaveLength(0);
  });

  it('is idempotent: charge.success and invoice.update for the same payment add one month, not two', async () => {
    const f = lapsedCode();
    await post({ event: 'charge.success', data: { reference: 'T-2', paid_at: iso(0), plan: PLAN, customer } });
    const first = f.Expiration_Date;
    await post({ event: 'invoice.update', data: { paid: true, status: 'success', paid_at: iso(0), subscription: { subscription_code: 'SUB_abc', plan: PLAN }, customer, transaction: { reference: 'T-2', status: 'success' } } });
    expect(f.Expiration_Date).toBe(first);
    expect(f.Notes).toMatch(/sub: SUB_abc/);         // and the link is now saved
  });

  it('subscription.create links the code made by the first payment instead of making a second', async () => {
    const f = lapsedCode({ expiredDaysAgo: -30 });   // brand new, still valid
    await post({ event: 'subscription.create', data: { subscription_code: 'SUB_new', plan: PLAN, customer } });
    expect(fm.rows).toHaveLength(1);
    expect(f.Notes).toBe('Paystack subscription (fan@example.com, sub: SUB_new, plan: PLN_monthly)');
    expect(welcome).toHaveLength(0);
  });

  it('first payment from a customer who never returned creates their code once', async () => {
    const ev = { event: 'charge.success', data: { reference: 'T-FIRST', paid_at: iso(0), plan: PLAN, customer } };
    await post(ev);
    expect(fm.rows).toHaveLength(1);
    expect(fm.rows[0].fieldData.Notes).toMatch(/\[ref T-FIRST\]/);
    expect(welcome).toHaveLength(1);
    caches.processedWebhookEventsCache.clear(); caches.pendingPaymentsCache.clear();
    await post(ev);                                   // a retry of the same payment
    expect(fm.rows).toHaveLength(1);
  });

  it('a failed monthly charge changes nothing', async () => {
    const f = lapsedCode();
    const before = f.Expiration_Date;
    await post({ event: 'invoice.payment_failed', data: { paid: false, status: 'failed', subscription: { subscription_code: 'SUB_abc' }, customer } });
    expect(f.Expiration_Date).toBe(before);
  });

  it('cancelling notes it on the code and leaves the paid-for time alone', async () => {
    const f = lapsedCode({ expiredDaysAgo: -12 });
    const before = f.Expiration_Date;
    await post({ event: 'subscription.not_renew', data: { subscription_code: 'SUB_abc', customer } });
    expect(f.Expiration_Date).toBe(before);
    expect(f.Notes).toMatch(/\[cancelled by customer /);
  });

  it('one-time passes still work as before', async () => {
    await post({ event: 'charge.success', data: { reference: 'T-PASS', paid_at: iso(0), customer, metadata: { plan_id: '7-day', days: 7 } } });
    expect(fm.rows).toHaveLength(1);
    expect(fm.rows[0].fieldData.Token_Type).not.toBe('subscription');
  });
});
