import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

let app;

beforeAll(async () => {
  const mod = await import('../../server.js');
  app = mod.app;
});

describe('admin endpoint auth (constant-time)', () => {
  it('GET /api/health is public (no admin key required)', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });

  it('GET /api/cache/stats requires X-Admin-Key', async () => {
    const res = await request(app).get('/api/cache/stats');
    // Tokens-required middleware fires before admin, so the response could
    // be 401 (unauth) or 403 (missing access token) depending on mount order.
    expect([401, 403]).toContain(res.status);
  });

  it('POST /api/cache/flush rejects wrong key', async () => {
    const res = await request(app)
      .post('/api/cache/flush')
      .set('X-Admin-Key', 'totally-wrong-secret')
      .send({});
    expect([401, 403]).toContain(res.status);
  });

  it('POST /api/cache/flush rejects empty key', async () => {
    const res = await request(app)
      .post('/api/cache/flush')
      .set('X-Admin-Key', '')
      .send({});
    expect([401, 403]).toContain(res.status);
  });
});
