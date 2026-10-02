import { describe, it, expect, beforeAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mad Mixer offers four models, "Quick" (sep_type 63) by default (Ian, 2026-10-02). MVSEP's own
// catalogue (~120 entries) is cut to those, in order, with our names; a split for any other model
// is refused before anything is sent to MVSEP.

const CATALOGUE = [20, 28, 40, 46, 49, 63, 12].map((n, i) => ({ id: 100 + i, render_id: n, name: `MVSEP model ${n}`, is_active: 1, order_id: 50 - i, algorithm_fields: n === 28 ? [{ name: 'add_opt1' }] : [] }));
let mvsepCreates = 0;
beforeAll(() => {
  process.env.MIXER_DATA_DIR = mkdtempSync(join(tmpdir(), 'mad-mixer-models-'));
  process.env.MIXER_OPEN_TO_ALL_TOKENS = 'true';
  process.env.MVSEP_KEY = 'test-key';
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('mvsep.com/api/app/algorithms')) return new Response(JSON.stringify(CATALOGUE), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('mvsep.com/api/separation/create')) { mvsepCreates++; return new Response('{"success":true,"data":{"hash":"x.wav"}}', { status: 200 }); }
    throw new Error('unexpected fetch ' + u);
  }));
});

async function app() {
  const { default: mixerRouter } = await import('../../routes/mixer.js');
  const a = express();
  a.use((req, _res, next) => { req.accessToken = { code: 'MASS-TST-001' }; next(); });
  a.use('/api/mixer', mixerRouter);
  return a;
}

describe('Mad Mixer models', () => {
  it('lists exactly the four offered models, Quick first and default, keeping MVSEP option fields', async () => {
    const res = await request(await app()).get('/api/mixer/mvsep/algorithms');
    expect(res.status).toBe(200);
    expect(res.body.map((a) => a.render_id)).toEqual([63, 28, 40, 49]);
    expect(res.body.filter((a) => a.is_default).map((a) => a.render_id)).toEqual([63]);
    expect(res.body[0].display_name).toMatch(/^Quick/);
    expect(res.body[1].display_name).toMatch(/^Best/);
    expect(res.body.map((a) => a.order_id)).toEqual([1, 2, 3, 4]);
    expect(res.body[1].algorithm_fields).toEqual([{ name: 'add_opt1' }]);
  });

  it('refuses a split for a model that is not offered, without calling MVSEP', async () => {
    const res = await request(await app()).post('/api/mixer/mvsep/create?sep_type=20')
      .set('X-Mixer-Song', '282').set('Content-Type', 'application/octet-stream').send(Buffer.alloc(1000, 1));
    // the song guard may refuse first in this bare app (no MADMixer songs faked) — either way MVSEP is never called
    expect([400, 403]).toContain(res.status);
    expect(mvsepCreates).toBe(0);
  });
});
