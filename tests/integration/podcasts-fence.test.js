// Guards the podcasts feature fence: with PODCASTS_ENABLED unset (the test
// default), the route must not exist — same discipline as the Telkom fence.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

let app;

beforeAll(async () => {
  const mod = await import('../../server.js');
  app = mod.app;
});

describe('podcasts ring-fence (PODCASTS_ENABLED off)', () => {
  it('404s /api/podcasts while the flag is off', async () => {
    const res = await request(app).get('/api/podcasts');
    expect(res.status).toBe(404);
  });

  it('keeps /podcasts OUT of the auth skip-list while off (no token leak path)', async () => {
    // Any unmounted /api path without a token should hit the auth wall or 404 —
    // never a 200. This catches someone adding the skip entry without the gate.
    const res = await request(app).get('/api/podcasts/anything');
    expect([403, 404]).toContain(res.status);
  });
});
