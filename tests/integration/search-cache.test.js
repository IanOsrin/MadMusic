import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

let app;
beforeAll(async () => {
  const mod = await import('../../server.js');
  app = mod.app;
});

// These exercise the SWR migration of /api/search + /api/explore. FM is a dummy
// host in tests, so /search throws (500) but /explore swallows FM errors to an
// empty result — which lets us assert the success path's caching contract.
describe('search/explore SWR caching', () => {
  it('explore sets SWR Cache-Control + X-Cache-State on the success path', async () => {
    const res = await request(app).get('/api/explore?start=1990');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=300');
    expect(['miss', 'fresh', 'stale']).toContain(res.headers['x-cache-state']);
  });

  it('explore second identical request reports a cached state (fresh/stale)', async () => {
    await request(app).get('/api/explore?start=1991');
    const res = await request(app).get('/api/explore?start=1991');
    expect(res.status).toBe(200);
    expect(['fresh', 'stale']).toContain(res.headers['x-cache-state']);
    expect(res.headers['x-cache-hit']).toBe('true');
  });

  it('explore rejects an out-of-range year before hitting FM', async () => {
    const res = await request(app).get('/api/explore?start=99');
    expect(res.status).toBe(400);
  });

  it('search rejects FM find-operator characters with 400 (no cache header)', async () => {
    const res = await request(app).get('/api/search').query({ q: '===bad@@' });
    expect(res.status).toBe(400);
    expect(res.headers['cache-control']).not.toMatch(/max-age=30/);
  });

  it('search does not cache an FM error response', async () => {
    const res = await request(app).get('/api/search').query({ q: 'anything' });
    expect(res.status).toBeGreaterThanOrEqual(500); // FM dummy fails
    expect(res.headers['cache-control'] || '').not.toMatch(/stale-while-revalidate/);
  });
});
