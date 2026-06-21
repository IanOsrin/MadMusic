import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

// Counts how many times the FileMaker token layout was queried. A cold-start
// burst of same-token requests must collapse to ONE lookup (the dedup added in
// server.js); without it, every concurrent request fired its own FM _find and
// flooded the FM request queue — the root cause of the multi-minute cold-start
// stalls before audio would play.
let tokenLayoutFindCount = 0;
const TOKENS_LAYOUT = process.env.FM_TOKENS_LAYOUT || 'API_Access_Tokens';

vi.mock('../../fm-client.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    // Don't hit the (invalid) FM host during boot warm-up.
    ensureToken: vi.fn(async () => 'test-fm-token'),
    closeFmPool: vi.fn(async () => {}),
    fmUpdateRecord: vi.fn(async () => ({})),
    fmGetRecordById: vi.fn(async () => null),
    fmFindRecords: vi.fn(async (layout) => {
      if (layout === TOKENS_LAYOUT) {
        tokenLayoutFindCount += 1;
        // Small delay so concurrent callers overlap before the first resolves,
        // which is exactly the window the dedup must cover.
        await new Promise((r) => setTimeout(r, 40));
        return {
          ok: true,
          total: 1,
          data: [{ recordId: '1', fieldData: { Token_Code: 'X', Active: 1, Token_Type: 'valid', First_Used: '01/01/2025 00:00:00' } }]
        };
      }
      return { ok: true, total: 0, data: [] };
    })
  };
});

let app;
beforeAll(async () => {
  const mod = await import('../../server.js');
  app = mod.app;
});

beforeEach(() => {
  tokenLayoutFindCount = 0;
});

describe('token validation — concurrent dedup', () => {
  it('collapses a burst of same-token requests into a single FM token lookup', async () => {
    // Unique, never-before-seen token so the per-process validation cache is cold
    // (this is the cold-start scenario).
    const TOKEN = 'MASS-DUP-001';
    const burst = Array.from({ length: 12 }, () =>
      request(app).get('/api/__dedup_probe__').set('x-access-token', TOKEN)
    );
    await Promise.all(burst);
    expect(tokenLayoutFindCount).toBe(1);
  });

  it('does two lookups for two distinct cold tokens', async () => {
    await Promise.all([
      request(app).get('/api/__dedup_probe__').set('x-access-token', 'MASS-DUP-AAA'),
      request(app).get('/api/__dedup_probe__').set('x-access-token', 'MASS-DUP-BBB')
    ]);
    expect(tokenLayoutFindCount).toBe(2);
  });

  it('serves the second same-token request from cache (no extra lookup)', async () => {
    const TOKEN = 'MASS-DUP-CACHED';
    await request(app).get('/api/__dedup_probe__').set('x-access-token', TOKEN);
    expect(tokenLayoutFindCount).toBe(1);
    await request(app).get('/api/__dedup_probe__').set('x-access-token', TOKEN);
    expect(tokenLayoutFindCount).toBe(1); // still 1 — second hit was cached
  });
});
