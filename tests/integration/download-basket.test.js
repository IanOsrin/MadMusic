import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';

// The basket (Ian, 2026-09-21): one Paystack payment for several tracks, then
// ONE PURCHASE RECORD PER TRACK sharing the reference — so each track keeps its
// own link, its own three downloads and its own counter.
//
// FileMaker, Paystack and email are mocked: these tests are about the basket's
// own rules — pricing from the record and never from the browser, unavailable
// tracks being dropped rather than charged for, and fulfilment being idempotent
// when the callback and the webhook both land.

const created = [];
let existingPurchases = [];

vi.mock('../../fm-client.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    fmGetRecordById: vi.fn(async (_layout, id) => {
      const catalogue = {
        '101': { 'Track Name': 'Soul Feeling', 'Track Artist': 'Elite Swingsters', Download_Price: '3.50' },
        '102': { 'Track Name': 'Blessing', 'Track Artist': 'Elite Swingsters', Download_Price: '3.50' },
        '103': { 'Track Name': 'Free Track', 'Track Artist': 'Someone', Download_Price: '0' },
      };
      return catalogue[id] ? { recordId: id, fieldData: catalogue[id] } : null;
    }),
    fmCreateRecord: vi.fn(async (_layout, fieldData) => {
      created.push(fieldData);
      return { ok: true, recordId: String(created.length) };
    }),
    fmFindRecords: vi.fn(async () => ({
      ok: true,
      data: existingPurchases.map((fd, i) => ({ recordId: String(i + 1), fieldData: fd })),
    })),
  };
});

vi.mock('../../lib/paystack.js', () => ({
  paystackRequest: vi.fn(async (method, path, body) => {
    if (path === '/transaction/initialize') {
      return { data: { reference: 'BASKET_REF_1', authorization_url: 'https://paystack.test/pay/BASKET_REF_1', amount: body.amount } };
    }
    return {
      data: {
        status: 'success',
        customer: { email: 'buyer@example.com' },
        metadata: {
          payment_type: 'download_basket',
          count: 2,
          items: [
            { id: '101', n: 'Soul Feeling', a: 'Elite Swingsters', p: 3.5 },
            { id: '102', n: 'Blessing', a: 'Elite Swingsters', p: 3.5 },
          ],
        },
      },
    };
  }),
}));

const sentEmails = [];
vi.mock('../../lib/email.js', async (orig) => {
  const actual = await orig();
  return { ...actual, sendBasketLinksEmail: vi.fn(async (...args) => { sentEmails.push(args); }) };
});

let app;
beforeAll(async () => {
  app = (await import('../../server.js')).app;
});

describe('POST /api/download/basket/initiate', () => {
  it('prices the basket from the track records, not from the browser', async () => {
    const res = await request(app).post('/api/download/basket/initiate')
      .send({ items: ['101', '102'], email: 'buyer@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.total).toBe(7);                       // 3.50 + 3.50
    expect(res.body.items).toHaveLength(2);
    expect(res.body.authorization_url).toContain('paystack.test');
  });

  it('drops tracks that are not for sale instead of charging for them', async () => {
    const res = await request(app).post('/api/download/basket/initiate')
      .send({ items: ['101', '103', '999'], email: 'buyer@example.com' });
    expect(res.body.total).toBe(3.5);                     // only the sellable one
    expect(res.body.rejected.map(r => r.trackRecordId).sort()).toEqual(['103', '999']);
  });

  it('refuses an empty basket, a bad email, and an all-unavailable basket', async () => {
    expect((await request(app).post('/api/download/basket/initiate')
      .send({ items: [], email: 'buyer@example.com' })).status).toBe(400);
    expect((await request(app).post('/api/download/basket/initiate')
      .send({ items: ['101'], email: 'nope' })).status).toBe(400);
    const none = await request(app).post('/api/download/basket/initiate')
      .send({ items: ['103'], email: 'buyer@example.com' });
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/none of these tracks are available/i);
  });

  it('de-duplicates a track added twice', async () => {
    const res = await request(app).post('/api/download/basket/initiate')
      .send({ items: ['101', '101', '102'], email: 'buyer@example.com' });
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(7);
  });
});

describe('GET /api/download/callback — basket fulfilment', () => {
  it('writes one purchase per track, all sharing the reference, and emails the links', async () => {
    created.length = 0; existingPurchases = []; sentEmails.length = 0;
    const res = await request(app).get('/api/download/callback?reference=BASKET_REF_1');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('download=basket');
    expect(created).toHaveLength(2);
    expect(created.map(c => c.TrackRecordID).sort()).toEqual(['101', '102']);
    expect(created.every(c => c.Paystack_Reference === 'BASKET_REF_1')).toBe(true);
    expect(created.every(c => c.Status === 'complete')).toBe(true);
    expect(sentEmails).toHaveLength(1);
  });

  it('writes nothing the second time — the webhook and the callback both land', async () => {
    created.length = 0; sentEmails.length = 0;
    existingPurchases = [
      { TrackRecordID: '101', Paystack_Reference: 'BASKET_REF_1', Status: 'complete' },
      { TrackRecordID: '102', Paystack_Reference: 'BASKET_REF_1', Status: 'complete' },
    ];
    await request(app).get('/api/download/callback?reference=BASKET_REF_1');
    expect(created).toHaveLength(0);
    expect(sentEmails).toHaveLength(0);                   // no second email either
  });

  it('fills a gap if only part of the basket was written', async () => {
    created.length = 0; sentEmails.length = 0;
    existingPurchases = [{ TrackRecordID: '101', Paystack_Reference: 'BASKET_REF_1', Status: 'complete' }];
    await request(app).get('/api/download/callback?reference=BASKET_REF_1');
    expect(created.map(c => c.TrackRecordID)).toEqual(['102']);
  });
});
