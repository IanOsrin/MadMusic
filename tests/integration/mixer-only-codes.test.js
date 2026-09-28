import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mad Mixer-only codes (2026-09-28): a free-split / Mixer-plan code opens /api/mixer/* and
// never MAD streaming — refused by the /api token middleware on every other route, and by
// MAD's sign-in (/api/access/validate). MAD codes are untouched.

vi.mock('../../lib/auth.js', async (importOriginal) => {
  const mod = await importOriginal();
  const fake = async (code) => {
    const c = String(code || '').trim().toUpperCase();
    if (c === 'MASS-MIX-001') return { valid: true, type: 'mixer-trial', email: 'mixer@example.com', recordId: '9' };
    if (c === 'MASS-MAD-001') return { valid: true, type: 'valid', email: 'listener@example.com', recordId: '8' };
    return { valid: false, definitive: true, reason: 'Invalid token' };
  };
  return { ...mod, validateAccessToken: fake };
});

let app;
beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'mad-mixer-only-'));
  process.env.MAD_MIXER_ENABLED = 'true';
  ({ app } = await import('../../server.js'));
});

describe('Mad Mixer-only codes', () => {
  it('are refused on MAD routes (no streaming)', async () => {
    const res = await request(app).get('/api/playlists').set('X-Access-Token', 'MASS-MIX-001');
    expect(res.status).toBe(403);
    expect(res.body.mixerOnly).toBe(true);
  });

  it('are turned away by MAD’s sign-in with a pointer to Mad Mixer', async () => {
    const res = await request(app).post('/api/access/validate')
      .send({ token: 'MASS-MIX-001', sessionId: '123e4567-e89b-42d3-a456-426614174000' });
    expect(res.status).toBe(403);
    expect(res.body.mixerOnly).toBe(true);
    expect(res.body.reason).toMatch(/Mad Mixer/);
  });

  it('get past the token check on /api/mixer/*', async () => {
    const res = await request(app).get('/api/mixer/ping').set('X-Access-Token', 'MASS-MIX-001');
    expect(res.status).toBe(200);
    expect(res.body.entitled).toBe(true);
  });

  it('leave ordinary MAD codes alone', async () => {
    const res = await request(app).get('/api/mixer/ping').set('X-Access-Token', 'MASS-MAD-001');
    expect(res.status).toBe(200);
    const mad = await request(app).get('/api/playlists').set('X-Access-Token', 'MASS-MAD-001');
    expect(mad.body.mixerOnly).toBeUndefined();
  });
});
