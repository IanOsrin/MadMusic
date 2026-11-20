import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stripe beside Paystack (Ian, 2026-11-20: "change our payment gateway from Paystack to Stripe ...
// first test it on the staging site"). PAYMENT_GATEWAY=stripe sends new checkouts to Stripe; the
// return trip and the webhook must make exactly the codes Paystack's did — one per payment — and
// renewals/cancellations must land on the customer's own code. Stripe's API is faked here; its
// webhook signatures are real (signed with the SDK's own test helper).

const fm = { rows: [] };
vi.mock('../../fm-client.js', async (importOriginal) => {
  const mod = await importOriginal();
  const want = (v) => String(v).replace(/^==/, '').replace(/\\(.)/g, '$1');
  return {
    ...mod,
    fmCreateRecord: vi.fn(async (_l, fieldData) => { fm.rows.push({ recordId: String(fm.rows.length + 1), fieldData: { Issued_Date: '11/1/2026 10:00:00', ...fieldData } }); return {}; }),
    fmFindRecords: vi.fn(async (_l, queries) => {
      const data = fm.rows.filter((r) => queries.some((q) => Object.entries(q).every(([k, v]) => String(r.fieldData[k] ?? '').toLowerCase() === want(v).toLowerCase())));
      return data.length ? { ok: true, data, total: data.length } : { ok: false, code: '401', data: [], total: 0 };
    }),
    fmUpdateRecord: vi.fn(async (_l, id, fields) => { Object.assign(fm.rows.find((r) => r.recordId === id).fieldData, fields); }),
  };
});
const sent = { tokens: [], welcome: [], mixer: [] };
vi.mock('../../lib/email.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod,
    sendTokenEmail: vi.fn(async (...a) => { sent.tokens.push(a); }),
    sendSubscriptionWelcomeEmail: vi.fn(async (...a) => { sent.welcome.push(a); }),
    sendMixerSubscriptionEmail: vi.fn(async (...a) => { sent.mixer.push(a); }) };
});
const paystackCalls = [];
vi.mock('../../lib/paystack.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, paystackRequest: vi.fn(async (method, endpoint, body) => {
    paystackCalls.push({ method, endpoint, body });
    if (method === 'POST' && endpoint === '/transaction/initialize') return { status: true, data: { authorization_url: 'https://checkout.paystack.com/x', reference: 'PS-REF-1' } };
    throw new Error(`unexpected Paystack call ${method} ${endpoint}`);
  }) };
});

const WHSEC = 'whsec_test_madmusic';
const fake = { created: [], sessions: new Map(), n: 0 };
const fakeClient = {
  checkout: { sessions: {
    create: vi.fn(async (params) => {
      const id = `cs_test_${++fake.n}abc`;
      fake.created.push(params);
      return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
    }),
    retrieve: vi.fn(async (id) => {
      const s = fake.sessions.get(id);
      if (!s) throw new Error('No such checkout.session');
      return s;
    }),
  } },
  webhooks: new Stripe('sk_test_unused').webhooks,
};

let app, caches, stripeLib;
beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'mad-stripe-'));
  process.env.FM_TIMEZONE_OFFSET = '0';
  process.env.MIXER_URL = 'https://mixer.example.test';
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
  ({ app } = await import('../../server.js'));
  caches = await import('../../cache.js');
  stripeLib = await import('../../lib/stripe.js');
});
beforeEach(() => {
  process.env.PAYMENT_GATEWAY = 'stripe';
  stripeLib._setStripeClientForTests(fakeClient);
  caches.pendingPaymentsCache.clear();
  caches.processedWebhookEventsCache.clear();
  fm.rows.length = 0;
  fake.created.length = 0;
  fake.sessions.clear();
  sent.tokens.length = 0; sent.welcome.length = 0; sent.mixer.length = 0;
  paystackCalls.length = 0;
});
afterEach(() => { delete process.env.PAYMENT_GATEWAY; });

const hook = (event) => {
  const payload = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, object: 'event', ...event });
  const sig = Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
  return request(app).post('/api/payments/stripe-webhook')
    .set('Content-Type', 'application/json').set('Stripe-Signature', sig).send(payload);
};
const paidSession = (over = {}) => ({
  object: 'checkout.session', status: 'complete', payment_status: 'paid', mode: 'payment',
  customer_details: { email: 'fan@example.com' }, amount_total: 750,
  metadata: { plan_id: '7-day', plan_label: '7 Day Access', days: '7', source: 'desktop' }, ...over,
});
const subSession = (over = {}) => paidSession({
  mode: 'subscription', subscription: 'sub_123', amount_total: 2999,
  metadata: { payment_type: 'subscription', plan_code: 'stripe:mad-monthly', email: 'fan@example.com', source: 'desktop' }, ...over,
});
const tokenRows = () => fm.rows.filter((r) => r.fieldData.Token_Code);

describe('the switch', () => {
  it('without PAYMENT_GATEWAY=stripe, checkout stays on Paystack (live is untouched)', async () => {
    delete process.env.PAYMENT_GATEWAY;
    const res = await request(app).post('/api/payments/initialize').send({ email: 'fan@example.com', plan: '7-day' });
    expect(res.body.authorization_url).toBe('https://checkout.paystack.com/x');
    expect(paystackCalls).toHaveLength(1);
    expect(fake.created).toHaveLength(0);
  });

  it('PAYMENT_GATEWAY=stripe without a key also stays on Paystack', async () => {
    const key = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      expect(stripeLib.activeGateway()).toBe('paystack');
    } finally { process.env.STRIPE_SECRET_KEY = key; }
  });
});

describe('Stripe one-off passes', () => {
  it('opens a Stripe Checkout in rand at the Paystack price, returning to the same callback', async () => {
    const res = await request(app).post('/api/payments/initialize').send({ email: 'Fan@Example.com', plan: '7-day', source: 'mobile' });
    expect(res.status).toBe(200);
    expect(res.body.authorization_url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(res.body.reference).toMatch(/^cs_test_/);
    const p = fake.created[0];
    expect(p.mode).toBe('payment');
    expect(p.customer_email).toBe('fan@example.com');
    expect(p.line_items[0].price_data).toMatchObject({ currency: 'zar', unit_amount: 750 });
    expect(p.success_url).toMatch(/\/api\/payments\/callback\?source=mobile&reference=\{CHECKOUT_SESSION_ID\}$/);
    expect(p.metadata).toMatchObject({ plan_id: '7-day', days: '7' });
    expect(paystackCalls).toHaveLength(0);
  });

  it('a price Stripe refuses says why, instead of the bare "Failed to initialize payment"', async () => {
    const refusing = { ...fakeClient, checkout: { sessions: { ...fakeClient.checkout.sessions, create: async () => {
      throw new Stripe.errors.StripeInvalidRequestError({
        type: 'invalid_request_error', code: 'amount_too_small',
        message: 'The Checkout Session\'s total amount due must add up to at least $0.50 usd',
      });
    } } } };
    stripeLib._setStripeClientForTests(refusing);
    const res = await request(app).post('/api/payments/initialize').send({ email: 'fan@example.com', plan: '1-day' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/below the card payment minimum/);
    expect(res.body.error).toMatch(/at least \$0\.50 usd/);   // test keys pass Stripe's own reason through

    const other = { ...refusing, checkout: { sessions: { ...refusing.checkout.sessions, create: async () => {
      throw new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', message: 'Something else' });
    } } } };
    stripeLib._setStripeClientForTests(other);
    const sub = await request(app).post('/api/payments/subscribe').send({ email: 'fan@example.com' });
    expect(sub.status).toBe(502);
    expect(sub.body.error).toBe('Stripe refused the payment: Something else');

    expect(stripeLib.stripeRefusal(new Error('FileMaker down'))).toBeNull();   // not Stripe: generic answer stays
  });

  it('the return trip makes one code; the webhook after it makes none', async () => {
    fake.sessions.set('cs_test_9abc', { id: 'cs_test_9abc', ...paidSession() });
    const res = await request(app).get('/api/payments/callback?reference=cs_test_9abc');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/\?payment=success&token=/);
    expect(tokenRows()).toHaveLength(1);
    expect(tokenRows()[0].fieldData.Notes).toMatch(/^Stripe purchase: 7-day \(fan@example\.com, ref: cs_test_9abc\)/);

    const w = await hook({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_9abc', ...paidSession() } } });
    expect(w.status).toBe(200);
    expect(tokenRows()).toHaveLength(1);
  });

  it('a buyer who never comes back still gets a code and an email from the webhook', async () => {
    const w = await hook({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_lost', ...paidSession() } } });
    expect(w.status).toBe(200);
    expect(tokenRows()).toHaveLength(1);
    expect(sent.tokens).toEqual([['fan@example.com', tokenRows()[0].fieldData.Token_Code, 7]]);
  });

  it('a payment still clearing shows "pending", and makes its code only once paid', async () => {
    fake.sessions.set('cs_test_slow', { id: 'cs_test_slow', ...paidSession({ payment_status: 'unpaid' }) });
    const res = await request(app).get('/api/payments/callback?reference=cs_test_slow');
    expect(res.headers.location).toMatch(/payment=pending/);
    await hook({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_slow', ...paidSession({ payment_status: 'unpaid' }) } } });
    expect(tokenRows()).toHaveLength(0);
    await hook({ type: 'checkout.session.async_payment_succeeded', data: { object: { id: 'cs_test_slow', ...paidSession() } } });
    expect(tokenRows()).toHaveLength(1);
  });

  it('refuses a webhook with a bad signature', async () => {
    const res = await request(app).post('/api/payments/stripe-webhook')
      .set('Content-Type', 'application/json').set('Stripe-Signature', 't=1,v1=deadbeef')
      .send(JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', data: { object: paidSession() } }));
    expect(res.status).toBe(400);
    expect(tokenRows()).toHaveLength(0);
  });
});

describe('Stripe subscriptions', () => {
  it('opens a monthly subscription checkout in rand, with the email on the subscription', async () => {
    const res = await request(app).post('/api/payments/subscribe').send({ email: 'fan@example.com' });
    expect(res.status).toBe(200);
    const p = fake.created[0];
    expect(p.mode).toBe('subscription');
    expect(p.line_items[0].price_data).toMatchObject({ currency: 'zar', unit_amount: 2999, recurring: { interval: 'month' } });
    expect(p.subscription_data.metadata).toMatchObject({ plan_code: 'stripe:mad-monthly', email: 'fan@example.com' });
    expect(p.success_url).toMatch(/type=subscription&reference=\{CHECKOUT_SESSION_ID\}$/);
  });

  it('first payment: webhook then return trip make ONE code, linked to the subscription', async () => {
    const s = { id: 'cs_test_sub1', ...subSession() };
    fake.sessions.set(s.id, s);
    await hook({ type: 'checkout.session.completed', data: { object: s } });
    const res = await request(app).get(`/api/payments/callback?reference=${s.id}&source=desktop&type=subscription`);
    expect(res.headers.location).toMatch(/payment=success&token=/);
    expect(tokenRows()).toHaveLength(1);
    const f = tokenRows()[0].fieldData;
    expect(f.Token_Type).toBe('subscription');
    expect(f.Notes).toMatch(/^Stripe subscription \(fan@example\.com, sub: sub_123, plan: stripe:mad-monthly\) \[ref cs_test_sub1\]/);
    expect(res.headers.location).toContain(encodeURIComponent(f.Token_Code));
    expect(sent.welcome).toHaveLength(1);
  });

  it('a monthly renewal extends the customer’s own code, once, and month one is left to the checkout', async () => {
    await hook({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_sub2', ...subSession() } } });
    const f = tokenRows()[0].fieldData;
    f.First_Used = '11/1/2026 10:01:00';
    f.Expiration_Date = '11/2/2026 10:01:00';     // as if it had lapsed

    const invoice = (id, reason) => ({ object: 'invoice', id, status: 'paid', billing_reason: reason, customer_email: 'fan@example.com',
      status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
      parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_123', metadata: { plan_code: 'stripe:mad-monthly', email: 'fan@example.com' } } } });

    await hook({ type: 'invoice.paid', data: { object: invoice('in_first', 'subscription_create') } });
    expect(f.Expiration_Date).toBe('11/2/2026 10:01:00');          // month one: nothing to do

    await hook({ type: 'invoice.paid', data: { object: invoice('in_dec', 'subscription_cycle') } });
    const renewed = f.Expiration_Date;
    expect(new Date(renewed).getTime()).toBeGreaterThan(Date.now() + 30 * 864e5);
    expect(f.Notes).toMatch(/\[renewed .* ref in_dec\]/);

    await hook({ type: 'invoice.paid', data: { object: invoice('in_dec', 'subscription_cycle') } });   // Stripe resends
    expect(f.Expiration_Date).toBe(renewed);
    expect(tokenRows()).toHaveLength(1);
  });

  it('a renewal on the older invoice shape (invoice.subscription) is read too', () => {
    const info = stripeLib.readInvoice({ id: 'in_old', status: 'paid', subscription: 'sub_old', customer_email: 'A@B.com', billing_reason: 'subscription_cycle', subscription_details: { metadata: { plan_code: 'stripe:mixer' } } });
    expect(info).toMatchObject({ subscriptionCode: 'sub_old', email: 'a@b.com', planCode: 'stripe:mixer', billingReason: 'subscription_cycle' });
  });

  it('cancelling notes it on the code; the code keeps what was paid for', async () => {
    await hook({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_sub3', ...subSession() } } });
    const f = tokenRows()[0].fieldData;
    const before = f.Expiration_Date;
    await hook({ type: 'customer.subscription.updated', data: { object: { id: 'sub_123', cancel_at_period_end: true, metadata: { email: 'fan@example.com', plan_code: 'stripe:mad-monthly' } }, previous_attributes: { cancel_at_period_end: false } } });
    expect(f.Notes).toMatch(/\[cancelled by customer \d{4}-\d\d-\d\d\]/);
    await hook({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_123', metadata: { email: 'fan@example.com', plan_code: 'stripe:mad-monthly' } } } });
    expect(f.Notes).toMatch(/\[subscription ended \d{4}-\d\d-\d\d\]/);
    expect(f.Expiration_Date).toBe(before);
    expect(f.Active).toBe(1);
  });

  it('a Mad Mixer subscription makes a mixer code and goes back to Mad Mixer signed in', async () => {
    const s = { id: 'cs_test_mix', ...subSession({ subscription: 'sub_mix', amount_total: 9900, metadata: { payment_type: 'subscription', plan_code: 'stripe:mixer', product: 'mixer', email: 'fan@example.com', source: 'mixer' } }) };
    fake.sessions.set(s.id, s);
    const res = await request(app).get(`/api/payments/callback?source=mixer&type=subscription&reference=${s.id}`);
    expect(res.headers.location).toMatch(/^https:\/\/mixer\.example\.test\/\?payment=success#code=/);
    expect(tokenRows()[0].fieldData.Token_Type).toBe('mixer');
    expect(sent.mixer).toHaveLength(1);
  });
});

describe('Stripe metadata', () => {
  it('a long basket survives the 500-character limit per value', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: String(1000 + i), n: 'A fairly long track name that goes on '.repeat(2).slice(0, 80), a: 'Artist name here', p: 12.99 }));
    const md = stripeLib.stringify({ payment_type: 'download_basket', count: 50, items });
    expect(Object.values(md).every((v) => v.length <= 500)).toBe(true);
    expect(Object.keys(md).length).toBeLessThanOrEqual(50);
    const back = stripeLib.readMetadata(md);
    expect(back.items).toEqual(items);
    expect(back.count).toBe(50);
  });
});

// Ian, 2026-11-20: "Can we have a choice of payment platforms" → "Pay in Rand and Pay in Your
// Choice of Currency". PAYMENT_GATEWAY=choice: the customer's button picks the gateway per payment.
describe('choice mode (Pay in Rand / Pay in Your Choice of Currency)', () => {
  beforeEach(() => { process.env.PAYMENT_GATEWAY = 'choice'; });

  it('no button named (older pages, links in inboxes) → Paystack; the Rand button → Paystack', async () => {
    for (const body of [{}, { gateway: 'paystack' }]) {
      const res = await request(app).post('/api/payments/initialize').send({ email: 'fan@example.com', plan: '1-day', ...body });
      expect(res.body.authorization_url).toBe('https://checkout.paystack.com/x');
    }
    expect(paystackCalls).toHaveLength(2);
    expect(fake.created).toHaveLength(0);
  });

  it('the currency button → Stripe, with Adaptive Pricing so visitors see their own currency', async () => {
    const res = await request(app).post('/api/payments/initialize').send({ email: 'fan@example.com', plan: '30-day', gateway: 'stripe' });
    expect(res.body.authorization_url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(fake.created[0].adaptive_pricing).toEqual({ enabled: true });
    expect(fake.created[0].line_items[0].price_data).toMatchObject({ currency: 'zar', unit_amount: 2999 });
    const sub = await request(app).post('/api/payments/subscribe').send({ email: 'fan@example.com', gateway: 'stripe' });
    expect(sub.body.reference).toMatch(/^cs_test_/);
    expect(fake.created[1].mode).toBe('subscription');
    expect(paystackCalls).toHaveLength(0);
  });

  it('a pass under the Stripe minimum is turned back before Stripe is asked, pointing to Pay in Rand', async () => {
    const res = await request(app).post('/api/payments/initialize').send({ email: 'fan@example.com', plan: '7-day', gateway: 'stripe' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/starts at R10\.00.*Pay in Rand/);
    expect(fake.created).toHaveLength(0);
    expect(paystackCalls).toHaveLength(0);
  });

  it('Mad Mixer stays on Paystack in choice mode (its checkout lives on its own site)', () => {
    expect(stripeLib.activeGateway()).toBe('paystack');
    expect(stripeLib.paymentMode()).toBe('choice');
  });

  it('the pages are told there is a choice, and the minimum', async () => {
    const res = await request(app).get('/mobile');
    expect(res.text).toContain('window.__PAY_CHOICE={"stripeMinCents":1000};');
    delete process.env.PAYMENT_GATEWAY;
    const off = await request(app).get('/mobile');
    expect(off.text).toContain('window.__PAY_CHOICE=false;');
  });

  it('an account Stripe will not do Adaptive Pricing for still gets a checkout (in rand)', async () => {
    let calls = 0;
    const picky = { ...fakeClient, checkout: { sessions: { ...fakeClient.checkout.sessions, create: async (params) => {
      calls += 1;
      if (params.adaptive_pricing) {
        throw new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', param: 'adaptive_pricing', message: 'Adaptive Pricing is not available for your account.' });
      }
      return fakeClient.checkout.sessions.create(params);
    } } } };
    stripeLib._setStripeClientForTests(picky);
    const res = await request(app).post('/api/payments/initialize').send({ email: 'fan@example.com', plan: '30-day', gateway: 'stripe' });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(fake.created[0].adaptive_pricing).toBeUndefined();
  });
});
