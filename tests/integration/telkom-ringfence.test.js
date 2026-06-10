import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

// Telkom is ring-fenced (June 2026): TELKOM_ENABLED defaults to off, so every
// /api/telkom/* endpoint must 404 BEFORE auth/webhook logic runs. This guards
// against the open Telkom findings (unauthenticated token minting, FM find
// injection via msisdn, broken token disablement) being reachable while we
// wait on deliverables from Telkom. See the TELKOM_ENABLED block in server.js.

let app;

beforeAll(async () => {
  delete process.env.TELKOM_ENABLED; // ensure default-off behaviour
  const mod = await import('../../server.js');
  app = mod.app;
});

describe('Telkom ring-fence (TELKOM_ENABLED off by default)', () => {
  it('POST /api/telkom/subscription returns 404 (no token minting)', async () => {
    const res = await request(app)
      .post('/api/telkom/subscription')
      .send({ user_msisdn: '27820000000', subscription_id: 'x', status_name: 'ACTIVATED' });
    expect(res.status).toBe(404);
  });

  it('POST /api/telkom/billing returns 404', async () => {
    const res = await request(app)
      .post('/api/telkom/billing')
      .send({ user_msisdn: '27820000000', subscription_id: 'x' });
    expect(res.status).toBe(404);
  });

  it('any /api/telkom/* path returns 404 (case-insensitive)', async () => {
    for (const p of ['/api/telkom', '/api/Telkom/subscription', '/api/telkom/anything']) {
      const res = await request(app).get(p);
      expect(res.status, p).toBe(404);
    }
  });

  it('telkom webhook paths are not in the auth skip-list while fenced', async () => {
    // The 404 fires before the access-token middleware; a 401 here would mean
    // the fence moved behind auth, a 200 would mean the fence is gone.
    const res = await request(app).post('/api/telkom/subscription').send({});
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(401);
  });
});
