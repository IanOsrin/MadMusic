import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { buildSuggestFixture } from '../fixtures/suggest-fixture.mjs';

// Env must be set BEFORE importing server.js (flag + DB path are read at module
// load). The fixture stands in for the real artifact.
const FIXTURE = path.join(os.tmpdir(), `suggest-route-${process.pid}.db`);
let app;

beforeAll(async () => {
  buildSuggestFixture(FIXTURE);
  process.env.SUGGESTIONS_ENABLED = 'true';
  process.env.SUGGEST_DB_PATH = FIXTURE;
  const mod = await import('../../server.js');
  app = mod.app;
});

afterAll(() => {
  fs.rmSync(FIXTURE, { force: true });
  delete process.env.SUGGESTIONS_ENABLED;
});

describe('GET /api/suggestions (SUGGESTIONS_ENABLED)', () => {
  it('is public (no token) and returns similar albums for a title+artist seed', async () => {
    const res = await request(app).get('/api/suggestions?title=Alpha&artist=Artist%20One&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.seed.album).toBe('Alpha');
    // Shuffle is on by default → assert membership, not order.
    expect(new Set(res.body.items.map((i) => i.album))).toEqual(new Set(['Beta', 'Gamma', 'Delta']));
    expect(res.body.count).toBe(3);
  });

  it('does not cache when shuffling (fresh each visit)', async () => {
    await request(app).get('/api/suggestions?cat=CAT-B&limit=3');
    const res = await request(app).get('/api/suggestions?cat=CAT-B&limit=3');
    expect(res.headers['x-cache-hit']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('resolves by catalogue', async () => {
    const res = await request(app).get('/api/suggestions?cat=CAT-A&limit=2');
    expect(res.status).toBe(200);
    expect(res.body.seed.album).toBe('Alpha');
    expect(res.body.items).toHaveLength(2);
  });

  it('400s when neither cat nor title is given', async () => {
    const res = await request(app).get('/api/suggestions');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('returns an empty list (200) for an unknown album', async () => {
    const res = await request(app).get('/api/suggestions?title=Nope&artist=Nobody');
    expect(res.status).toBe(200);
    expect(res.body.seed).toBeNull();
    expect(res.body.count).toBe(0);
  });

  it('serves a cache hit on the second identical request (shuffle off)', async () => {
    process.env.SUGGEST_SHUFFLE = 'false';
    try {
      await request(app).get('/api/suggestions?cat=CAT-A&limit=3');
      const res = await request(app).get('/api/suggestions?cat=CAT-A&limit=3');
      expect(res.headers['x-cache-hit']).toBe('true');
    } finally {
      delete process.env.SUGGEST_SHUFFLE;
    }
  });
});
