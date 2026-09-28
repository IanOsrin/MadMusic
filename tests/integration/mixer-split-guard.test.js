import { describe, it, expect, beforeAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mad Mixer only splits its own songs (Ian, 2026-09-28): POST /api/mixer/mvsep/create needs
// X-Mixer-Song naming a MADMixer song that has audio, and the upload can't be longer than it.
// FileMaker (MADMixer) and MVSEP are faked here; no network.

const SONGS = [
  { recordId: '282', fieldData: { 'Track Name': 'After the Storm', 'Track Artist': 'Alec Khaoli', Duration: '0:03:25', ISRC: 'X1', Audio_S3_URL: 'https://mass-music-audio-files.s3.eu-north-1.amazonaws.com/a.mp3' } },
  { recordId: '16', fieldData: { 'Track Name': "Bhod L'Umlilo", 'Track Artist': 'AJP', Duration: '0:04:00', ISRC: 'X2', Audio_S3_URL: '' } },
];
let mvsepCalls = 0;

beforeAll(() => {
  process.env.MIXER_DATA_DIR = mkdtempSync(join(tmpdir(), 'mad-mixer-guard-'));
  process.env.MIXER_OPEN_TO_ALL_TOKENS = 'true';
  process.env.MVSEP_KEY = 'test-key';
  process.env.MADMIXER_FM_HOST = 'mm.test';
  process.env.MADMIXER_FM_USER = 'u';
  process.env.MADMIXER_FM_PASS = 'p';
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const u = String(url);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('mm.test') && u.endsWith('/sessions')) return json({ response: { token: 't' }, messages: [{ code: '0' }] });
    if (u.includes('mm.test') && u.includes('/records')) return json({ response: { data: SONGS }, messages: [{ code: '0' }] });
    if (u.includes('mvsep.com/api/separation/create')) {
      mvsepCalls++;
      for await (const _ of init.body) { /* drain the streamed upload */ }
      return json({ success: true, data: { hash: 'h1' } });
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
const wav = (bytes) => Buffer.alloc(bytes, 1);

describe('Mad Mixer split guard', () => {
  it('refuses a split that is not tagged with a Mad Mixer song', async () => {
    const res = await request(await app()).post('/api/mixer/mvsep/create?sep_type=28').send(wav(1000));
    expect(res.status).toBe(403);
    expect(mvsepCalls).toBe(0);
  });

  it('refuses a song that has no audio yet', async () => {
    const res = await request(await app()).post('/api/mixer/mvsep/create?sep_type=28').set('X-Mixer-Song', '16').send(wav(1000));
    expect(res.status).toBe(403);
  });

  it('refuses audio far longer than the song', async () => {
    const res = await request(await app()).post('/api/mixer/mvsep/create?sep_type=28')
      .set('X-Mixer-Song', '282').set('Content-Type', 'audio/wav').send(wav(205 * 400_000 + 6_000_000));
    expect(res.status).toBe(400);
    expect(mvsepCalls).toBe(0);
  });

  it('passes a tagged split of a Mad Mixer song through to the splitter', async () => {
    const res = await request(await app()).post('/api/mixer/mvsep/create?sep_type=28')
      .set('X-Mixer-Song', '282').set('Content-Type', 'audio/wav').send(wav(2_000_000));
    expect(res.status).toBe(200);
    expect(mvsepCalls).toBe(1);
  });
});
