import { describe, it, expect, beforeAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Polling a split (2026-10-02): MVSEP job ids end in the uploaded file's name, e.g.
// "20261002125247-b15a4d8ded-audio.wav". /api/mixer/mvsep/get refused every one ("Bad job id" —
// no dot allowed), so the page polled for 20 min and reported "Timed out waiting for MVSEP" while
// MVSEP had finished in ~4. The earlier tests used ids like 'h1' and never saw it.

const seen = [];
beforeAll(() => {
  process.env.MIXER_DATA_DIR = mkdtempSync(join(tmpdir(), 'mad-mixer-poll-'));
  process.env.MIXER_OPEN_TO_ALL_TOKENS = 'true';
  process.env.MVSEP_KEY = 'test-key';
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('mvsep.com/api/separation/get')) {
      seen.push(u);
      return new Response(JSON.stringify({ success: true, status: 'done', data: { files: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
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

describe('Mad Mixer split polling', () => {
  it('passes a real MVSEP job id (with its .wav ending) through to MVSEP', async () => {
    const hash = '20261002125247-b15a4d8ded-audio.wav';
    const res = await request(await app()).get('/api/mixer/mvsep/get').query({ hash });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('done');
    expect(seen.at(-1)).toContain('hash=' + encodeURIComponent(hash));
  });

  it('still refuses ids that are not MVSEP-shaped', async () => {
    for (const hash of ['../etc/passwd', 'a/b.wav', 'x', 'id with space.wav']) {
      const res = await request(await app()).get('/api/mixer/mvsep/get').query({ hash });
      expect(res.status).toBe(400);
      // the page stops on 'failed' and shows the message — it must not read a refusal as "processing"
      expect(res.body.status).toBe('failed');
      expect(res.body.message).toBeTruthy();
    }
  });
});
