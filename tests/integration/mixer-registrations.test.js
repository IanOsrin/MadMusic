import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signRequest } from '../../lib/mixer-bridge.js';

// Song registrations from Mad Mixer (2026-10-23): the signed /internal/mixer/registrations* calls,
// MADMixer "Registrations" (faked FileMaker) and the private S3 bucket (faked; presigned links checked
// against AWS's own published example). No real FileMaker, bucket or key.

const VECTORS = JSON.parse(readFileSync(new URL('../../docs/mixer-bridge-vectors.json', import.meta.url), 'utf8'));
const SECRET = VECTORS.secret;
const ACCT = 'a'.repeat(64);
const REG = 'mmr_ABCDEFGHIJKLMNOPQRSTUV';

const fm = { rows: [], creates: [] };
const s3 = { objects: new Map(), heads: [] };

let reg, createMixerInternalRouter;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mad-mixer-reg-'));
  vi.stubEnv('DATA_DIR', dir);
  vi.stubEnv('MIXER_DATA_DIR', dir);
  vi.stubEnv('MVSEP_KEY', 'fake-test-key');
  vi.stubEnv('MADMIXER_FM_HOST', 'mm.test');
  vi.stubEnv('MADMIXER_FM_USER', 'u');
  vi.stubEnv('MADMIXER_FM_PASS', 'p');
  vi.stubEnv('MIXER_REG_S3_BUCKET', 'mad-mixer-registrations');
  vi.stubEnv('MIXER_REG_S3_ACCESS_KEY', 'AKIDEXAMPLE');
  vi.stubEnv('MIXER_REG_S3_SECRET_KEY', 'not-a-real-secret');
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const u = String(url);
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('mm.test') && u.endsWith('/sessions')) return json({ response: { token: 't' }, messages: [{ code: '0' }] });
    if (u.includes('mm.test') && u.endsWith('/layouts/Registrations/records') && init.method === 'POST') {
      const { fieldData } = JSON.parse(init.body);
      fm.creates.push(fieldData);
      fm.rows.push({ recordId: String(fm.rows.length + 1), fieldData });
      return json({ response: { recordId: String(fm.rows.length) }, messages: [{ code: '0' }] });
    }
    if (u.includes('mm.test') && u.endsWith('/layouts/Registrations/_find')) {
      const { query } = JSON.parse(init.body);
      const [[k, v]] = Object.entries(query[0]);
      const data = fm.rows.filter((r) => String(r.fieldData[k]) === v.replace(/^==/, ''));
      return data.length ? json({ response: { data }, messages: [{ code: '0' }] }) : json({ response: {}, messages: [{ code: '401', message: 'No records match the request' }] }, 500);
    }
    if (u.startsWith('https://mad-mixer-registrations.s3.eu-north-1.amazonaws.com/') && init.method === 'HEAD') {
      const key = decodeURIComponent(new URL(u).pathname.slice(1));
      s3.heads.push(key);
      return s3.objects.has(key) ? new Response(null, { status: 200, headers: { 'Content-Length': String(s3.objects.get(key)) } }) : new Response(null, { status: 404 });
    }
    throw new Error(`unexpected fetch ${u}`);
  }));
  reg = await import('../../lib/mixer-registrations.js');
  ({ createMixerInternalRouter } = await import('../../routes/mixer-internal.js'));
});
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });
beforeEach(() => { fm.rows.length = 0; fm.creates.length = 0; s3.objects.clear(); s3.heads.length = 0; });

const app = () => {
  const a = express();
  a.use('/internal/mixer', express.raw({ type: () => true, limit: '16kb' }));
  a.use(express.json());
  a.use('/internal/mixer', createMixerInternalRouter({ resolveToken: vi.fn(), secret: () => SECRET }));
  return a;
};
function signed(a, method, path, body) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  let r = request(a)[method.toLowerCase()](path).set('X-MM-Ts', String(ts)).set('X-MM-Sig', signRequest({ ts, method, path, body: raw }, SECRET));
  if (raw) r = r.set('Content-Type', 'application/json').send(raw);
  return r;
}

const FILE = 'My Song (Final mix).wav';
const KEY = `registrations/${REG}/My_Song_Final_mix_.wav`;
const form = (o = {}) => ({
  regId: REG, acct: ACCT, email: 'fan@example.com', plan: 'mixer',
  originalSongId: '282', originalTitle: 'Chiiko Chikonzero', originalArtist: 'Oliver Mtukudzi', originalIsrc: 'ZAC031800681',
  material: ['AI-split stems', 'Not a thing'], dcxIds: ['DCX-20261023-AB23CD', 'junk'], secondsUsed: 24.5,
  newTitle: 'Tuk Tuk', newArtist: 'Kwela K', newIsrc: 'za-abc-26-00001', distributor: 'DistroKid', releaseDate: '2026-12-01',
  writers: 'Kwela K 100%', notes: '', fileKey: KEY, fileName: FILE, fileBytes: 5000, licenceVersion: 'draft-2026-10-23', ...o,
});

describe('presigned S3 links (SigV4 query signing)', () => {
  it('reproduces AWS’s published presigned-URL example byte for byte', () => {
    // docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html — GET examplebucket/test.txt
    const url = reg.presignS3({ method: 'GET', host: 'examplebucket.s3.amazonaws.com', region: 'us-east-1', key: 'test.txt',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', expires: 86400, now: Date.UTC(2013, 4, 24) });
    expect(url).toBe('https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  });

  it('keeps only safe characters in the key', () => {
    expect(reg.uploadKey(REG, FILE)).toBe(KEY);
    expect(reg.uploadKey(REG, '../../etc/passwd')).toBe(`registrations/${REG}/etc_passwd`);
  });
});

describe('POST /internal/mixer/registrations/upload', () => {
  it('signs a 1-hour PUT link into the private bucket for a WAV, AIFF or FLAC under 1 GB', async () => {
    const res = await signed(app(), 'POST', '/internal/mixer/registrations/upload', { regId: REG, file: FILE, bytes: 5000 });
    expect(res.status).toBe(200);
    expect(res.body.key).toBe(KEY);
    expect(res.body.url).toMatch(/^https:\/\/mad-mixer-registrations\.s3\.eu-north-1\.amazonaws\.com\/registrations\/mmr_[^/]+\/My_Song_Final_mix_\.wav\?X-Amz-Algorithm=AWS4-HMAC-SHA256&.*X-Amz-Expires=3600&/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('refuses other files, sizes and ids, and answers 503 while the bucket isn’t set up', async () => {
    const up = (b) => signed(app(), 'POST', '/internal/mixer/registrations/upload', { regId: REG, file: FILE, bytes: 5000, ...b });
    expect((await up({ file: 'song.mp3' })).status).toBe(400);
    expect((await up({ bytes: 2 * 1024 ** 3 })).status).toBe(400);
    expect((await up({ regId: 'mmr_short' })).status).toBe(400);
    vi.stubEnv('MIXER_REG_S3_SECRET_KEY', '');
    try { expect((await up({})).status).toBe(503); } finally { vi.stubEnv('MIXER_REG_S3_SECRET_KEY', 'not-a-real-secret'); }
  });

  it('is signed like every other bridge call', async () => {
    const res = await request(app()).post('/internal/mixer/registrations/upload').set('Content-Type', 'application/json').send({ regId: REG, file: FILE, bytes: 5000 });
    expect(res.status).toBe(401);
  });
});

describe('POST /internal/mixer/registrations', () => {
  it('saves the record once the upload is there at the declared size, and lists it for that account', async () => {
    s3.objects.set(KEY, 5000);
    const res = await signed(app(), 'POST', '/internal/mixer/registrations', form());
    expect(res.status).toBe(200);
    expect(res.body.registration).toMatchObject({ regId: REG, status: 'Submitted', newTitle: 'Tuk Tuk', newIsrc: 'ZAABC2600001' });
    expect(fm.creates).toHaveLength(1);
    expect(fm.creates[0]).toMatchObject({
      Reg_ID: REG, Status: 'Submitted', Account: ACCT, Material: 'AI-split stems', DCX_IDs: 'DCX-20261023-AB23CD', Seconds_Used: '24.5',
      New_ISRC: 'ZAABC2600001', Original_ISRC: 'ZAC031800681', File_Key: KEY, File_Bytes: '5000', Licence_Version: 'draft-2026-10-23',
    });
    expect(fm.creates[0].Submitted_At).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
    expect(Object.keys(fm.creates[0])).not.toContain('Code');

    const list = await signed(app(), 'POST', '/internal/mixer/registrations/list', { acct: ACCT });
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ ok: true, ready: true });
    expect(list.body.registrations.map((r) => r.regId)).toEqual([REG]);
  });

  it('the same registration again (a retry) is answered from FileMaker, not saved twice', async () => {
    s3.objects.set(KEY, 5000);
    await signed(app(), 'POST', '/internal/mixer/registrations', form());
    const again = await signed(app(), 'POST', '/internal/mixer/registrations', form());
    expect(again.status).toBe(200);
    expect(again.body.again).toBe(true);
    expect(fm.creates).toHaveLength(1);
  });

  it('refuses a missing or half-finished upload, and bad details', async () => {
    const post = (o) => signed(app(), 'POST', '/internal/mixer/registrations', form(o));
    let r = await post();
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/couldn’t find your uploaded song/);
    s3.objects.set(KEY, 4000);
    r = await post();
    expect(r.body.error).toMatch(/didn’t finish/);
    s3.objects.set(KEY, 5000);
    for (const bad of [{ secondsUsed: 31 }, { secondsUsed: 0 }, { newIsrc: 'nope' }, { releaseDate: '1/12/2026' }, { material: ['Not a thing'] },
      { fileKey: `registrations/mmr_ZZZZZZZZZZZZZZZZZZZZZZ/My_Song_Final_mix_.wav` }, { newTitle: '' }, { acct: 'nope' }]) {
      expect((await post(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(fm.creates).toHaveLength(0);
  });

  it('an account with no registrations gets an empty list', async () => {
    const res = await signed(app(), 'POST', '/internal/mixer/registrations/list', { acct: 'b'.repeat(64) });
    expect(res.body).toEqual({ ok: true, ready: true, registrations: [] });
  });
});
