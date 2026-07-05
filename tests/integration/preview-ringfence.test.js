import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

// GUEST_PREVIEW_ENABLED is unset → every /api/preview/* path must 404 BEFORE
// the auth middleware (no requiresAccessToken 403 that would pop the token
// gate on a stale frontend probing it). Same fence pattern as podcasts,
// suggestions, and telkom.
let app;

beforeAll(async () => {
  delete process.env.GUEST_PREVIEW_ENABLED;
  const mod = await import('../../server.js');
  app = mod.app;
});

describe('guest preview ringfence (flag off)', () => {
  it('404s /api/preview/:recordId before auth', async () => {
    const res = await request(app).get('/api/preview/12345');
    expect(res.status).toBe(404);
    expect(res.text).toBe('Not found');
  });

  it('does not leak a requiresAccessToken 403', async () => {
    const res = await request(app).get('/api/preview/12345');
    expect(res.body?.requiresAccessToken).toBeUndefined();
  });

  it('does not stamp the client flag on', async () => {
    const res = await request(app).get('/');
    expect(res.text).toContain('window.__GUEST_PREVIEW=false');
  });
});
