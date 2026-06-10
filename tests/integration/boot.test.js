import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

let app;

beforeAll(async () => {
  const mod = await import('../../server.js');
  app = mod.app;
});

describe('boot smoke', () => {
  it('returns 200 for GET /api/health', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toBeTypeOf('object');
  });

  it('refuses an /api/playlists request with no token (auth gate works)', async () => {
    const res = await request(app).get('/api/playlists');
    expect(res.status).toBe(403);
    expect(res.body.requiresAccessToken).toBe(true);
  });

  it('serves the homepage HTML', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('injects the editorial-hero flag so the hero can skip the dead round-trip', async () => {
    const res = await request(app).get('/');
    // Default config has EDITORIAL_HERO_ENABLED off → flag must be exactly false.
    expect(res.text).toMatch(/window\.__EDITORIAL_HERO=false/);
  });

  it('sets security headers (CSP, nosniff, frame, referrer)', async () => {
    const res = await request(app).get('/');
    expect(res.headers['content-security-policy']).toBeTruthy();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });
});
