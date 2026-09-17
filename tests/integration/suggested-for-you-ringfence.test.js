import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

// "Suggested for You" ships dark: PERSONAL_RAIL_ENABLED defaults off, so
// /api/suggested-for-you must 404 BEFORE the auth middleware — never the 403
// token wall. Mirrors the suggestions/podcasts fence. See server.js.
let app;

beforeAll(async () => {
  delete process.env.PERSONAL_RAIL_ENABLED;
  const mod = await import('../../server.js');
  app = mod.app;
});

describe('Suggested for You ring-fence (PERSONAL_RAIL_ENABLED off by default)', () => {
  it('GET /api/suggested-for-you returns 404, not the 403 token wall', async () => {
    for (const p of ['/api/suggested-for-you', '/api/Suggested-For-You']) {
      const res = await request(app).get(p);
      expect(res.status, p).toBe(404);
      expect(res.body.requiresAccessToken).toBeUndefined();
    }
  });
});
