import { describe, it, expect, beforeAll } from 'vitest';
import { createHmac } from 'node:crypto';

let verifyPaystackWebhook;
let PAYSTACK_PLANS;

beforeAll(async () => {
  // Module is loaded after setup.js has populated PAYSTACK_SECRET_KEY
  const mod = await import('../../lib/paystack.js');
  verifyPaystackWebhook = mod.verifyPaystackWebhook;
  PAYSTACK_PLANS = mod.PAYSTACK_PLANS;
});

function sign(raw, secret = process.env.PAYSTACK_SECRET_KEY) {
  return createHmac('sha512', secret).update(raw).digest('hex');
}

describe('verifyPaystackWebhook', () => {
  it('accepts a correctly-signed payload', () => {
    const raw = JSON.stringify({ event: 'charge.success', data: { reference: 'ref_1' } });
    const sig = sign(raw);
    expect(verifyPaystackWebhook(raw, sig)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const raw = JSON.stringify({ event: 'charge.success', data: { reference: 'ref_1' } });
    const sig = sign(raw);
    const tampered = JSON.stringify({ event: 'charge.success', data: { reference: 'ref_2' } });
    expect(verifyPaystackWebhook(tampered, sig)).toBe(false);
  });

  it('rejects on missing signature', () => {
    expect(verifyPaystackWebhook('{}', null)).toBe(false);
    expect(verifyPaystackWebhook('{}', '')).toBe(false);
    expect(verifyPaystackWebhook('{}', undefined)).toBe(false);
  });

  it('handles Buffer input (raw express body)', () => {
    const raw = Buffer.from(JSON.stringify({ a: 1 }), 'utf8');
    const sig = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(raw).digest('hex');
    expect(verifyPaystackWebhook(raw, sig)).toBe(true);
  });
});

describe('PAYSTACK_PLANS catalogue', () => {
  it('contains 1/7/30-day plans with kobo amounts', () => {
    expect(PAYSTACK_PLANS['1-day'].amount).toBe(250);
    expect(PAYSTACK_PLANS['7-day'].amount).toBe(750);
    expect(PAYSTACK_PLANS['30-day'].amount).toBe(3999);
  });
});
