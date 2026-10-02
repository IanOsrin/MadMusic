import { describe, it, expect, beforeAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mad Mixer free split (2026-09-28): one per email; a Mixer-only code at once; the split
// unlocks only after the emailed Confirm link; then exactly one split. FileMaker (tokens +
// MADMixer), email and MVSEP are faked in memory.

const fm = { rows: [], nextId: 1 };
vi.mock('../../fm-client.js', async (importOriginal) => {
  const mod = await importOriginal();
  const matches = (row, q) => Object.entries(q).every(([k, v]) => {
    const want = String(v).replace(/^==/, '');
    return String(row.fieldData[k] ?? '') === want;
  });
  return {
    ...mod,
    fmCreateRecord: vi.fn(async (_layout, fieldData) => { fm.rows.push({ recordId: String(fm.nextId++), fieldData: { ...fieldData } }); return {}; }),
    fmFindRecords: vi.fn(async (_layout, queries) => {
      const data = fm.rows.filter((r) => queries.some((q) => matches(r, q)));
      return data.length ? { ok: true, data, total: data.length } : { ok: false, code: '401', data: [], total: 0 };
    }),
    fmUpdateRecord: vi.fn(async (_layout, recordId, fields) => { Object.assign(fm.rows.find((r) => r.recordId === recordId).fieldData, fields); }),
  };
});

const sent = [];
vi.mock('../../lib/email.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, emailTransporter: { mocked: true }, sendMixerTrialEmail: vi.fn(async (...a) => { sent.push(a); }) };
});

const SONG = { recordId: '282', fieldData: { 'Track Name': 'After the Storm', Duration: '0:03:25', ISRC: 'X1', Audio_S3_URL: 'https://mass-music-audio-files.s3.eu-north-1.amazonaws.com/a.mp3' } };
let mvsepCalls = 0;

let app;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mad-free-split-'));
  process.env.DATA_DIR = dir;
  process.env.MIXER_DATA_DIR = dir;
  process.env.AUTH_SECRET = 'test-secret';
  process.env.MVSEP_KEY = 'k';
  process.env.MADMIXER_FM_HOST = 'mm.test'; process.env.MADMIXER_FM_USER = 'u'; process.env.MADMIXER_FM_PASS = 'p';
  delete process.env.MIXER_OPEN_TO_ALL_TOKENS;
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const u = String(url);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('mm.test') && u.endsWith('/sessions')) return json({ response: { token: 't' }, messages: [{ code: '0' }] });
    if (u.includes('mm.test')) return json({ response: { data: [SONG] }, messages: [{ code: '0' }] });
    if (u.includes('mvsep.com/api/separation/create')) { mvsepCalls++; for await (const _ of init.body) { /* drain */ } return json({ success: true, data: { hash: 'h' } }); }
    throw new Error('unexpected fetch ' + u);
  }));
  const { default: mixerRouter } = await import('../../routes/mixer.js');
  app = express();
  app.use(express.json());
  // Stand-in for server.js's token middleware: the free-split code is a 'mixer-trial' token.
  app.use((req, _res, next) => { const c = req.headers['x-access-token']; if (c) req.accessToken = { code: c, type: 'mixer-trial' }; next(); });
  app.use('/api/mixer', mixerRouter);
});

const split = (code) => request(app).post('/api/mixer/mvsep/create?sep_type=28')
  .set('X-Access-Token', code).set('X-Mixer-Song', '282').set('Content-Type', 'audio/wav').send(Buffer.alloc(1000, 1));

describe('Mad Mixer free split', () => {
  let code, confirmUrl;

  it('signs up with an email and hands back a Mixer-only code at once', async () => {
    const res = await request(app).post('/api/mixer/trial').send({ email: 'Fan@Example.com' });
    expect(res.status).toBe(200);
    code = res.body.token;
    expect(code).toMatch(/^MASS-/);
    expect(fm.rows[0].fieldData.Token_Type).toBe('mixer-trial');
    [, , { confirmUrl }] = sent[0];
    expect(sent[0][2].openUrl).toMatch(/\/mixer\?code=MASS-/);
    expect(confirmUrl).toMatch(/\/api\/mixer\/trial\/confirm\?t=MASS-[^&]+&s=[\w-]{32}$/);
  });

  it('allows one free split per email', async () => {
    const again = await request(app).post('/api/mixer/trial').send({ email: 'fan@example.com' });
    expect(again.status).toBe(409);
  });

  it('holds the split until the email is confirmed', async () => {
    const auth = await request(app).post('/api/mixer/auth').set('X-Access-Token', code);
    expect(auth.body).toMatchObject({ ok: true, trial: true, confirmed: false, quota: 1, remaining: 1 });
    const res = await split(code);
    expect(res.status).toBe(403);
    expect(res.body.needsConfirm).toBe(true);
    expect(mvsepCalls).toBe(0);
  });

  it('refuses a forged Confirm link', async () => {
    const res = await request(app).get(`/api/mixer/trial/confirm?t=${code}&s=forged-forged-forged-forged-1234`);
    expect(res.text).toMatch(/didn’t work/);
  });

  it('unlocks exactly one split after confirming', async () => {
    const u = new URL(confirmUrl);
    const res = await request(app).get(u.pathname + u.search);
    expect(res.text).toMatch(/free split is ready/);
    expect(fm.rows[0].fieldData.Notes).toMatch(/\[email confirmed/);
    expect((await split(code)).status).toBe(200);
    expect(mvsepCalls).toBe(1);
    const second = await split(code);
    expect(second.status).toBe(402);
    expect(second.body.error).toMatch(/used your free split/);
  });
});
