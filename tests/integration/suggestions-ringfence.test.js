import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

// "Similar albums" ships dark: SUGGESTIONS_ENABLED defaults off, so every
// /api/suggestions request must 404 BEFORE the auth middleware — never the
// 403 token wall (a stale frontend probing it would otherwise pop the token
// gate). Mirrors the podcasts/telkom fence. See server.js SUGGESTIONS_ENABLED.
let app;

beforeAll(async () => {
  delete process.env.SUGGESTIONS_ENABLED; // ensure default-off
  const mod = await import('../../server.js');
  app = mod.app;
});

describe('Suggestions ring-fence (SUGGESTIONS_ENABLED off by default)', () => {
  it('GET /api/suggestions returns 404, not the 403 token wall', async () => {
    const res = await request(app).get('/api/suggestions?cat=CAT-A');
    expect(res.status).toBe(404);
    expect(res.body.requiresAccessToken).toBeUndefined();
  });

  it('any /api/suggestions* path 404s (case-insensitive)', async () => {
    for (const p of ['/api/suggestions', '/api/Suggestions?title=x', '/api/suggestions/anything']) {
      const res = await request(app).get(p);
      expect(res.status, p).toBe(404);
    }
  });
});
