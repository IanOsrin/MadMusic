import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveKeys, signRequest, verifyRequest, mixerPublicUrl } from '../../lib/mixer-bridge.js';
// NB: nothing that loads lib/token-store.js is imported statically — it fixes its data folder at
// import time, so it is imported only after DATA_DIR points at a temp folder (below).

// Mad Mixer on its own home (Vercel) ↔ MAD (docs/mad-mixer-vercel-design.md §2c/§2d, as amended
// by the owner decisions of 2026-10-02):
//   · the shared signing vectors (docs/mixer-bridge-vectors.json — the Vercel repo tests against
//     the same file), signature + ±60 s clock skew, raw-body ordering, no-store;
//   · the signed internal API through the real server.js (entitlement BY PLAN incl. Mixer-only,
//     Combined and MAD-only codes — Audio_Lab_Enabled grants nothing —, songs, free-split
//     sign-up + dedupe + confirm, rate limits);
//   · MIXER_URL: plain links — /mixer and /mad-mixer.html go to MIXER_URL, /api/mixer/* is cut to
//     /mixable, the page carries window.__MAD_MIXER_URL; no hand-off;
//   · with MIXER_URL and MIXER_SHARED_SECRET unset nothing changes; with MAD_MIXER_ENABLED off the
//     internal API still serves the Mixer while MAD shows no Mixer surface.
// FileMaker (tokens + MADMixer), email and the clock are faked; no real code, key or service.

const VECTORS = JSON.parse(readFileSync(new URL('../../docs/mixer-bridge-vectors.json', import.meta.url), 'utf8'));
const SECRET = VECTORS.secret;
const MIXER_URL = 'https://mixer.test';

// ── fakes ─────────────────────────────────────────────────────────────────────
const fm = { rows: [], nextId: 100, down: false };
const row = (code, f) => fm.rows.push({ recordId: String(fm.nextId++), fieldData: { Token_Code: code, Active: 1, Notes: '', ...f } });
row('MASS-MIX-TRL', { Token_Type: 'mixer-trial', Email: 'trial@example.com', Token_Duration_Hours: String(30 * 86400) });
row('MASS-MIX-PLN', { Token_Type: 'mixer', Email: 'plan@example.com' });
row('MASS-CMB-001', { Token_Type: 'combined', Email: 'both@example.com' });
row('MASS-CMB-CAP', { Token_Type: 'Combined', Email: 'typed@example.com' });   // typed by hand in FileMaker
row('MASS-MIX-SPC', { Token_Type: ' Mixer ', Email: 'spaces@example.com' });
row('MASS-MAD-ONL', { Token_Type: 'valid', Email: 'listener@example.com', Audio_Lab_Enabled: 0 });
row('MASS-MAD-LAB', { Token_Type: 'valid', Email: 'lab@example.com', Audio_Lab_Enabled: 1 });
row('MASS-OFF-001', { Token_Type: 'mixer', Active: 0 });
row('MASS-END-001', { Token_Type: 'mixer-trial', Active: 0 });

vi.mock('../../fm-client.js', async (importOriginal) => {
  const mod = await importOriginal();
  const unescape = (v) => String(v).replace(/^==/, '').replace(/\\(.)/g, '$1');
  const matches = (r, q) => Object.entries(q).every(([k, v]) => String(r.fieldData[k] ?? '') === unescape(v));
  return {
    ...mod,
    fmCreateRecord: vi.fn(async (_layout, fieldData) => { fm.rows.push({ recordId: String(fm.nextId++), fieldData: { ...fieldData } }); return {}; }),
    fmFindRecords: vi.fn(async (_layout, queries) => {
      if (fm.down) throw new Error('FileMaker unreachable');
      const data = fm.rows.filter((r) => queries.some((q) => matches(r, q)));
      return data.length ? { ok: true, data, total: data.length } : { ok: false, code: '401', data: [], total: 0 };
    }),
    fmUpdateRecord: vi.fn(async (_layout, recordId, fields) => { const r = fm.rows.find((x) => x.recordId === recordId); if (r) Object.assign(r.fieldData, fields); }),
  };
});

const sent = [];
let emailFails = false;
vi.mock('../../lib/email.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    emailTransporter: { mocked: true },
    sendMixerTrialEmail: vi.fn(async (...a) => { if (emailFails) throw new Error('smtp down'); sent.push(a); }),
  };
});

const SONGS = [
  { recordId: '282', fieldData: { 'Track Name': 'After the Storm', 'Track Artist': 'A', Duration: '0:03:25', ISRC: 'X1', Audio_S3_URL: 'https://mass-music-audio-files.s3.eu-north-1.amazonaws.com/a.mp3' } },
  { recordId: '283', fieldData: { 'Track Name': 'No Audio Yet', 'Track Artist': 'B', ISRC: 'X2' } },
];

// Every token the tests mint goes to a temp folder, never the repo's data/; no real MVSEP key
// (a fake one also keeps routes/mixer.js away from the macOS Keychain).
let createMixerInternalRouter;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mad-mixer-internal-'));
  vi.stubEnv('DATA_DIR', dir);
  vi.stubEnv('MIXER_DATA_DIR', dir);
  vi.stubEnv('MVSEP_KEY', 'fake-test-key');
  ({ createMixerInternalRouter } = await import('../../routes/mixer-internal.js'));
});
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

// ── helpers ───────────────────────────────────────────────────────────────────
const nowS = () => Math.floor(Date.now() / 1000);
function signed(app, method, path, body, { ts = nowS(), secret = SECRET, sig, signBody } = {}) {
  const raw = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  const s = sig ?? signRequest({ ts, method, path, body: signBody ?? raw }, secret);
  let r = request(app)[method.toLowerCase()](path).set('X-MM-Ts', String(ts)).set('X-MM-Sig', s);
  if (raw) r = r.set('Content-Type', 'application/json').send(raw);
  return r;
}
const hkdf = (info) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(SECRET, 'utf8'), Buffer.alloc(0), Buffer.from(info, 'utf8'), 32));

// ── 1 · the shared vectors ───────────────────────────────────────────────────
describe('mixer bridge vectors (docs/mixer-bridge-vectors.json)', () => {
  it('derives K_sign with HKDF-SHA256, empty salt, trimmed UTF-8 secret', () => {
    expect(VECTORS.secret).toBe('mm-test-secret-0123456789abcdef');
    expect(VECTORS.algorithm.key.info).toBe('mm-sign-v1');
    expect(hkdf('mm-sign-v1').toString('hex')).toBe(VECTORS.derived.K_sign_hex);
    expect(deriveKeys(SECRET).sign.toString('hex')).toBe(VECTORS.derived.K_sign_hex);
    expect(deriveKeys(`  ${SECRET}\n`).sign.toString('hex')).toBe(VECTORS.derived.K_sign_hex);   // pasted with a newline
    expect(() => deriveKeys('   ')).toThrow(/not set/);
  });

  it('holds exactly three signing vectors and nothing about a hand-off', () => {
    expect(VECTORS.signatures).toHaveLength(3);
    expect(VECTORS.handoffs).toBeUndefined();
    expect(VECTORS.derived.K_handoff_hex).toBeUndefined();
  });

  it.each(VECTORS.signatures.map((v) => [v.name, v]))('signature vector: %s', (_name, v) => {
    // independent recomputation from the documented algorithm…
    const bodySha256 = crypto.createHash('sha256').update(Buffer.from(v.body, 'utf8')).digest('hex');
    expect(bodySha256).toBe(v.bodySha256);
    expect(`${v.ts}\n${v.method}\n${v.path}\n${bodySha256}`).toBe(v.canonical);
    expect(crypto.createHmac('sha256', hkdf('mm-sign-v1')).update(v.canonical).digest('base64url')).toBe(v.sig);
    // …and the library
    expect(signRequest(v, SECRET)).toBe(v.sig);
    expect(verifyRequest({ ...v, now: v.ts * 1000 }, SECRET)).toEqual({ ok: true });
    expect(verifyRequest({ ...v, body: v.body + ' ', now: v.ts * 1000 }, SECRET).ok).toBe(false);
  });

  it('accepts only an https MIXER_URL (http just for localhost)', () => {
    expect(mixerPublicUrl('https://mixer.musicafricadirect.com/')).toBe('https://mixer.musicafricadirect.com');
    expect(mixerPublicUrl('http://localhost:8790')).toBe('http://localhost:8790');
    expect(mixerPublicUrl('http://mixer.example.com')).toBe('');
    expect(mixerPublicUrl('javascript:alert(1)')).toBe('');
    expect(mixerPublicUrl('https://mixer.example.com/?x=1')).toBe('');
    expect(mixerPublicUrl('https://u:p@mixer.example.com')).toBe('');
    expect(mixerPublicUrl('')).toBe('');
  });
});

// ── 2 · the router on its own: signature, skew, raw body, backstop ──────────────
describe('internal router: signature, clock skew, raw-body ordering', () => {
  const NOW = VECTORS.signatures[0].ts * 1000;
  const resolveToken = vi.fn(async () => ({ valid: true, source: 'fm', data: { type: 'mixer', email: 'x@example.com', expirationDate: '2026-12-01T00:00:00.000Z' } }));
  const routerApp = (opts = {}) => {
    const a = express();
    a.use('/internal/mixer', express.raw({ type: () => true, limit: '16kb' }));   // server.js order: raw first…
    a.use(express.json());                                                        // …then JSON
    a.use('/internal/mixer', createMixerInternalRouter({ resolveToken, secret: () => SECRET, now: () => NOW, ...opts }));
    return a;
  };
  let app;
  beforeAll(() => { app = routerApp(); });
  const ENT = '/internal/mixer/entitlement';

  it('accepts the published vector request byte for byte', async () => {
    const v = VECTORS.signatures[0];
    const res = await request(app).post(v.path).set('X-MM-Ts', String(v.ts)).set('X-MM-Sig', v.sig)
      .set('Content-Type', 'application/json').send(v.body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: true, entitled: true, plan: 'mixer' });
    expect(resolveToken).toHaveBeenLastCalledWith('MASS-TST-001');
  });

  it('refuses missing, forged, re-pointed and re-bodied requests', async () => {
    const ts = NOW / 1000;
    const body = { code: 'MASS-TST-001' };
    expect((await request(app).post(ENT).send(body)).status).toBe(401);
    expect((await signed(app, 'POST', ENT, body, { ts, secret: 'not-the-shared-secret-at-all' })).status).toBe(401);
    // a signature for one path / method / body is no good for another
    const forSongs = signRequest({ ts, method: 'GET', path: '/internal/mixer/songs', body: '' }, SECRET);
    expect((await signed(app, 'POST', ENT, body, { ts, sig: forSongs })).status).toBe(401);
    expect((await signed(app, 'POST', ENT, body, { ts, signBody: JSON.stringify({ code: 'MASS-OTHER-1' }) })).status).toBe(401);
    expect((await signed(app, 'POST', `${ENT}?x=1`, body, { ts, sig: signRequest({ ts, method: 'POST', path: ENT, body: JSON.stringify(body) }, SECRET) })).status).toBe(401);
    // and an unsigned request never reaches a route, not even a 404
    expect((await request(app).get('/internal/mixer/nope')).status).toBe(401);
    expect((await signed(app, 'GET', '/internal/mixer/nope', undefined, { ts })).status).toBe(404);
  });

  it('allows ±60 s of clock skew and no more', async () => {
    const ts = NOW / 1000;
    const body = { code: 'MASS-TST-001' };
    for (const d of [-60, 0, 60]) expect((await signed(app, 'POST', ENT, body, { ts: ts + d })).status).toBe(200);
    for (const d of [-61, 61, -3600]) {
      const res = await signed(app, 'POST', ENT, body, { ts: ts + d });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/expired/i);
    }
  });

  it('verifies the raw bytes, not a re-serialisation (whitespace and key order are signed)', async () => {
    const ts = NOW / 1000;
    const odd = '{ "x": 1,\n  "code" : "MASS-TST-001" }';
    const res = await signed(app, 'POST', ENT, odd, { ts });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    // the same JSON, re-serialised, does not match that signature
    expect((await signed(app, 'POST', ENT, JSON.parse(odd), { ts, sig: signRequest({ ts, method: 'POST', path: ENT, body: odd }, SECRET) })).status).toBe(401);
  });

  it('fails closed when a JSON parser runs before it (raw body gone)', async () => {
    const wrong = express();
    wrong.use(express.json());
    wrong.use('/internal/mixer', createMixerInternalRouter({ resolveToken, secret: () => SECRET, now: () => NOW }));
    const res = await signed(wrong, 'POST', ENT, { code: 'MASS-TST-001' }, { ts: NOW / 1000 });
    expect(res.status).toBe(500);
    expect(res.body.valid).toBeUndefined();
  });

  it('refuses bodies over 16 KB and non-JSON bodies', async () => {
    const ts = NOW / 1000;
    expect((await signed(app, 'POST', ENT, JSON.stringify({ code: 'MASS-TST-001', pad: 'x'.repeat(17_000) }), { ts })).status).toBe(413);
    expect((await signed(app, 'POST', ENT, 'not json', { ts })).status).toBe(400);
    expect((await signed(app, 'POST', ENT, { code: 42 }, { ts })).status).toBe(400);
  });

  it('caps signed calls at the backstop; unsigned noise does not spend it', async () => {
    const small = routerApp({ limits: { callsPerMinute: 3 } });
    const ts = NOW / 1000;
    for (let i = 0; i < 5; i++) expect((await request(small).post(ENT).send({ code: 'MASS-TST-001' })).status).toBe(401);
    for (let i = 0; i < 3; i++) expect((await signed(small, 'POST', ENT, { code: 'MASS-TST-001' }, { ts })).status).toBe(200);
    expect((await signed(small, 'POST', ENT, { code: 'MASS-TST-001' }, { ts })).status).toBe(429);
  });

  it('answers 503 (not 401) when no secret is configured', async () => {
    const res = await signed(routerApp({ secret: () => '' }), 'POST', ENT, { code: 'MASS-TST-001' }, { ts: NOW / 1000 });
    expect(res.status).toBe(503);
  });

  it('marks every answer no-store, refusals included (they carry codes and emails)', async () => {
    expect((await request(app).post(ENT).send({ code: 'MASS-TST-001' })).headers['cache-control']).toBe('no-store');
    expect((await signed(app, 'POST', ENT, { code: 'MASS-TST-001' }, { ts: NOW / 1000 })).headers['cache-control']).toBe('no-store');
  });

  it('entitlement follows the plan, whatever else the code carries', async () => {
    const ts = NOW / 1000;
    const answer = async (data) => {
      resolveToken.mockResolvedValueOnce({ valid: true, source: 'fm', data });
      return (await signed(app, 'POST', ENT, { code: 'MASS-TST-001' }, { ts })).body;
    };
    expect(await answer({ type: 'valid', audioLabEnabled: true })).toMatchObject({ valid: true, entitled: false, plan: 'valid' });
    expect(await answer({ type: 'subscription', audioLabEnabled: true })).toMatchObject({ valid: true, entitled: false });
    expect(await answer({ type: 'combined' })).toMatchObject({ valid: true, entitled: true, trial: false, confirmed: true });
    expect(await answer({ type: 'mixer' })).toMatchObject({ valid: true, entitled: true, trial: false, confirmed: true });
  });

  it('free-split sign-up answers 503 while MIXER_URL is unset (the email links need it)', async () => {
    const res = await signed(routerApp({ mixerUrl: () => '' }), 'POST', '/internal/mixer/trial', { email: 'fan@example.com', ip: '203.0.113.9' }, { ts: NOW / 1000 });
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
  });
});

// ── 3 · through the real server.js, with MIXER_SHARED_SECRET + MIXER_URL set ────────────
// ── 2b · subscribe: Mad Mixer asks MAD for a Paystack checkout (2026-10-05) ─────────────────────
describe('POST /internal/mixer/subscribe', () => {
  const resolveToken = vi.fn();
  const checkout = vi.fn(async ({ email }) => ({ ok: true, url: `https://checkout.paystack.com/test-${email.length}` }));
  const appWith = (opts = {}) => {
    const a = express();
    a.use('/internal/mixer', express.raw({ type: () => true, limit: '16kb' }));
    a.use(express.json());
    a.use('/internal/mixer', createMixerInternalRouter({ resolveToken, secret: () => SECRET, mixerUrl: () => MIXER_URL, startCheckout: checkout, ...opts }));
    return a;
  };

  it('opens a checkout for a valid email (lower-cased) and returns its address', async () => {
    const res = await signed(appWith(), 'POST', '/internal/mixer/subscribe', { email: ' Fan@Example.com ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, url: 'https://checkout.paystack.com/test-15' });
    expect(checkout).toHaveBeenLastCalledWith(expect.objectContaining({ email: 'fan@example.com' }));
  });

  it('refuses a bad email, and answers 503 when MIXER_URL or the plan is missing', async () => {
    expect((await signed(appWith(), 'POST', '/internal/mixer/subscribe', { email: 'not-an-email' })).status).toBe(400);
    expect((await signed(appWith({ mixerUrl: () => '' }), 'POST', '/internal/mixer/subscribe', { email: 'fan@example.com' })).status).toBe(503);
    const closed = appWith({ startCheckout: async () => ({ ok: false, status: 503, error: 'Mad Mixer subscriptions aren’t open yet.' }) });
    const r = await signed(closed, 'POST', '/internal/mixer/subscribe', { email: 'fan@example.com' });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/aren’t open yet/);
  });

  it('is signed like every other bridge call', async () => {
    const res = await request(appWith()).post('/internal/mixer/subscribe').set('Content-Type', 'application/json').send({ email: 'fan@example.com' });
    expect(res.status).toBe(401);
  });
});

describe('Mad Mixer on its own home, through server.js', () => {
  let app, tokenValidationCache, tokenStore;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    vi.stubEnv('MAD_MIXER_ENABLED', 'true');
    vi.stubEnv('MIXER_SHARED_SECRET', `${SECRET}\n`);   // as pasted: the newline is trimmed
    vi.stubEnv('MIXER_URL', `${MIXER_URL}/`);
    vi.stubEnv('MADMIXER_FM_HOST', 'mm.test');
    vi.stubEnv('MADMIXER_FM_USER', 'u');
    vi.stubEnv('MADMIXER_FM_PASS', 'p');
    vi.stubEnv('MEDIA_CDN_HOST', '');
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url);
      const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (u.includes('mm.test') && u.endsWith('/sessions')) return json({ response: { token: 't' }, messages: [{ code: '0' }] });
      if (u.includes('mm.test')) return json({ response: { data: SONGS }, messages: [{ code: '0' }] });
      if (u.includes('mvsep.com')) throw new Error('MVSEP must not be called here');
      return realFetch(url, init);
    }));
    ({ app } = await import('../../server.js'));
    ({ tokenValidationCache } = await import('../../cache.js'));
    tokenStore = await import('../../lib/token-store.js');
  });

  const entitlement = (code) => signed(app, 'POST', '/internal/mixer/entitlement', { code });

  describe('POST /internal/mixer/entitlement', () => {
    it('a Mixer-only free-split code: entitled, trial, not yet confirmed', async () => {
      const res = await entitlement('mass-mix-trl');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true, valid: true, definitive: true, source: 'fm', entitled: true, plan: 'mixer-trial',
        trial: true, confirmed: false, email: 'trial@example.com', expiresAt: expect.any(String),
      });
    });

    it('Mixer plan and Combined codes are entitled; Combined is not a trial', async () => {
      expect((await entitlement('MASS-MIX-PLN')).body).toMatchObject({ valid: true, entitled: true, plan: 'mixer', trial: false, confirmed: true });
      expect((await entitlement('MASS-CMB-001')).body).toMatchObject({ valid: true, entitled: true, plan: 'combined', trial: false });
    });

    it('plan names typed by hand count whatever their capitals and spaces ("Combined", " Mixer ")', async () => {
      expect((await entitlement('MASS-CMB-CAP')).body).toMatchObject({ valid: true, entitled: true, plan: 'combined', trial: false });
      expect((await entitlement('MASS-MIX-SPC')).body).toMatchObject({ valid: true, entitled: true, plan: 'mixer', trial: false });
    });

    it('a MAD-only code is valid but NOT entitled (the Mixer offers the upgrade)', async () => {
      expect((await entitlement('MASS-MAD-ONL')).body).toMatchObject({ valid: true, entitled: false, plan: 'valid', trial: false, confirmed: true, email: 'listener@example.com' });
    });

    it('Audio_Lab_Enabled grants nothing: a flagged MAD-only code is not entitled', async () => {
      expect((await entitlement('MASS-MAD-LAB')).body).toMatchObject({ valid: true, entitled: false, plan: 'valid' });
    });

    it('disabled, unknown and malformed codes are a definitive no', async () => {
      const off = await entitlement('MASS-OFF-001');
      expect(off.body).toMatchObject({ ok: true, valid: false, definitive: true, entitled: false, plan: null, trial: false, confirmed: false, email: null, expiresAt: null });
      expect((await entitlement('MASS-NOT-HERE')).body).toMatchObject({ valid: false, definitive: true, entitled: false });
      expect((await entitlement('<script>')).body).toMatchObject({ valid: false, definitive: true, entitled: false });
      expect((await signed(app, 'POST', '/internal/mixer/entitlement', {})).status).toBe(400);
    });

    it('reports where the answer came from: cache, then stale or json when FileMaker is down', async () => {
      expect((await entitlement('MASS-MIX-PLN')).body.source).toBe('cache');   // cached by the call above
      // FileMaker down, last good answer expired but inside the 24 h grace → stale
      tokenValidationCache.set('MASS-STL-001', { data: { code: 'MASS-STL-001', type: 'mixer', expirationDate: null, email: 's@example.com', recordId: '77' }, expiresAt: Date.now() - 60_000 });
      // FileMaker down, only the local JSON copy knows the code → json
      const d = await tokenStore.loadAccessTokens();
      d.tokens.push({ code: 'MASS-JSN-001', type: 'mixer', email: 'j@example.com', expirationDate: new Date(Date.now() + 86_400_000).toISOString() });
      await tokenStore.saveAccessTokens(d);
      fm.down = true;
      try {
        expect((await entitlement('MASS-STL-001')).body).toMatchObject({ valid: true, source: 'stale', definitive: false, entitled: true });
        expect((await entitlement('MASS-JSN-001')).body).toMatchObject({ valid: true, source: 'json', definitive: false, entitled: true });
        expect((await entitlement('MASS-JSN-001')).body.source).toBe('json');   // still json from the cache
        expect((await entitlement('MASS-GONE-01')).body).toMatchObject({ valid: false, definitive: false });
      } finally { fm.down = false; }
    });
  });

  it('GET /internal/mixer/songs: playable songs only, each with its CDN MP3', async () => {
    const res = await signed(app, 'GET', '/internal/mixer/songs');
    expect(res.status).toBe(200);
    expect(res.body.builtAt).toEqual(expect.any(String));
    expect(res.body.count).toBe(1);
    expect(res.body.songs).toEqual([{
      id: '282', title: 'After the Storm', artist: 'A', album: '', duration: '0:03:25', genre: '', isrc: 'X1',
      playable: true, hasMaster: false, audioUrl: 'https://media.musicafricadirect.com/a.mp3',
    }]);
  });

  describe('free split via the Mixer', () => {
    let code, confirmUrl, openUrl;
    const trial = (email, ip = '203.0.113.7') => signed(app, 'POST', '/internal/mixer/trial', { email, ip });

    it('issues a Mixer-only code and emails links to MIXER_URL in the fragment (never a query string)', async () => {
      const res = await trial('Fan@Example.com');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, code: expect.stringMatching(/^MASS-/) });
      code = res.body.code;
      expect(fm.rows.find((r) => r.fieldData.Token_Code === code).fieldData).toMatchObject({ Token_Type: 'mixer-trial', Email: 'fan@example.com', Active: 1 });
      const [to, mailedCode, links] = sent.at(-1);
      expect([to, mailedCode]).toEqual(['fan@example.com', code]);
      ({ confirmUrl, openUrl } = links);
      expect(confirmUrl).toMatch(new RegExp(`^${MIXER_URL}/#confirm=${code}\\.[\\w-]{32}$`));
      expect(openUrl).toBe(`${MIXER_URL}/#code=${code}`);
      expect(confirmUrl).not.toContain('?');
      expect(openUrl).not.toContain('?');
    });

    it('allows one free split per email (canonical mailbox)', async () => {
      const res = await trial('fan+again@example.com', '198.51.100.1');
      expect(res.status).toBe(409);
      expect(res.body.ok).toBe(false);
    });

    it('a new code waits for its email to be confirmed (one FileMaker find for that, shared and kept 30 s)', async () => {
      const { fmFindRecords } = await import('../../fm-client.js');
      const [a, b] = await Promise.all([entitlement(code), entitlement(code)]);
      expect(a.body).toMatchObject({ valid: true, entitled: true, plan: 'mixer-trial', trial: true, confirmed: false });
      expect(b.body).toMatchObject({ trial: true, confirmed: false });
      const before = fmFindRecords.mock.calls.length;
      expect((await entitlement(code)).body).toMatchObject({ confirmed: false });
      expect(fmFindRecords.mock.calls.length).toBe(before);   // token cached + "not yet" kept 30 s
    });

    it('confirms with the code and signature from the link, once and idempotently', async () => {
      const [c, sig] = confirmUrl.split('#confirm=')[1].split('.');
      expect((await signed(app, 'POST', '/internal/mixer/trial/confirm', { code: c, sig: 'forged-forged-forged-forged-1234' })).body).toEqual({ ok: false, reason: 'bad-link' });
      const res = await signed(app, 'POST', '/internal/mixer/trial/confirm', { code: c, sig });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, confirmed: true });
      expect(fm.rows.find((r) => r.fieldData.Token_Code === code).fieldData.Notes).toMatch(/\[email confirmed/);
      expect((await signed(app, 'POST', '/internal/mixer/trial/confirm', { code: c.toLowerCase(), sig })).body).toEqual({ ok: true, confirmed: true });
      // the "not yet" kept from the test above is replaced at once, and a "yes" needs no more finds
      const { fmFindRecords } = await import('../../fm-client.js');
      const before = fmFindRecords.mock.calls.length;
      expect((await entitlement(code)).body).toMatchObject({ trial: true, confirmed: true });
      expect(fmFindRecords.mock.calls.length).toBe(before);
    });

    it('an ended free split cannot be confirmed', async () => {
      const { trialSig } = await import('../../lib/mixer-trial.js');
      const res = await signed(app, 'POST', '/internal/mixer/trial/confirm', { code: 'MASS-END-001', sig: trialSig('MASS-END-001') });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, reason: 'ended' });
    });

    it('a failed email revokes the new code (502)', async () => {
      emailFails = true;
      try {
        const res = await trial('bounce@example.com', '198.51.100.2');
        expect(res.status).toBe(502);
        const rec = fm.rows.find((r) => r.fieldData.Email === 'bounce@example.com');
        expect(String(rec.fieldData.Active)).toBe('0');
      } finally { emailFails = false; }
    });

    it('rejects a bad email or missing ip, and limits sign-ups to 5 an hour per signed ip', async () => {
      expect((await trial('not-an-email', '192.0.2.50')).status).toBe(400);
      expect((await signed(app, 'POST', '/internal/mixer/trial', { email: 'x@example.com' })).status).toBe(400);
      for (let i = 0; i < 4; i++) expect((await trial('not-an-email', '192.0.2.50')).status).toBe(400);
      expect((await trial('fresh@example.com', '192.0.2.50')).status).toBe(429);        // 6th from that ip
      expect((await trial('fresh@example.com', '192.0.2.51')).status).toBe(200);        // another listener
    });
  });

  describe('MAD browser side (MIXER_URL set): plain links, no hand-off', () => {
    it('the app page tells js/mad-mixer-links.js where Mad Mixer lives', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.text).toContain(`window.__MAD_MIXER_URL="${MIXER_URL}"`);
      expect(res.text).toContain('window.__MAD_MIXER=true');
      expect(res.text).toContain('/js/mad-mixer-links.js?v=');
    });

    it('/mixer and /mad-mixer.html go to MIXER_URL (song kept; an old email code moves into the fragment)', async () => {
      const loc = async (path) => {
        const res = await request(app).get(path);
        expect(res.status).toBe(302);
        return res.headers.location;
      };
      expect(await loc('/mixer')).toBe(`${MIXER_URL}/`);
      expect(await loc('/mixer?song=282')).toBe(`${MIXER_URL}/?song=282`);
      expect(await loc('/mixer?song=../x')).toBe(`${MIXER_URL}/`);
      expect(await loc('/mixer?code=mass-abc-def')).toBe(`${MIXER_URL}/#code=MASS-ABC-DEF`);
      expect(await loc('/mixer?song=282&code=MASS-ABC-DEF')).toBe(`${MIXER_URL}/?song=282#code=MASS-ABC-DEF`);
      expect(await loc('/mixer?code=<x>')).toBe(`${MIXER_URL}/`);
      expect(await loc('/mad-mixer.html')).toBe(`${MIXER_URL}/`);
    });

    it('/api/mixer/* is only /mixable: no splitting, songs, sign-up or hand-off routes in MAD', async () => {
      for (const [method, path] of [['get', '/api/mixer/songs'], ['get', '/api/mixer/songs/282'], ['get', '/api/mixer/ping'],
        ['post', '/api/mixer/auth'], ['get', '/api/mixer/usage'], ['get', '/api/mixer/mvsep/algorithms'],
        ['post', '/api/mixer/mvsep/create'], ['get', '/api/mixer/mvsep/get?hash=abcd.wav'],
        ['get', '/api/mixer/audio-proxy?url=https://mvsep.com/x.wav'], ['post', '/api/mixer/dcx/register'],
        ['post', '/api/mixer/handoff']]) {
        const res = await request(app)[method](path).set('X-Access-Token', 'MASS-MAD-ONL');
        expect(res.status, path).toBe(404);
        expect(res.body.movedTo, path).toBe(MIXER_URL);
      }
      expect((await request(app).post('/api/mixer/trial').send({ email: 'x@example.com' })).status).toBe(403);   // no token, no route
      const mixable = await request(app).get('/api/mixer/mixable').set('X-Access-Token', 'MASS-MAD-ONL');
      expect(mixable.status).toBe(200);
      expect(mixable.body.ok).toBe(true);
    });

    it('a Mixer-only code opens nothing in MAD, /api/mixer included', async () => {
      const res = await request(app).get('/api/mixer/mixable').set('X-Access-Token', 'MASS-MIX-PLN');
      expect(res.status).toBe(403);
      expect(res.body.mixerOnly).toBe(true);
      // " Mixer " typed by hand is still a Mixer-only code: no streaming.
      expect((await request(app).get('/api/playlists').set('X-Access-Token', 'MASS-MIX-SPC')).body.mixerOnly).toBe(true);
    });

    it('a Confirm link from an email sent before the move is forwarded to the Mixer', async () => {
      const res = await request(app).get('/api/mixer/trial/confirm?t=mass-abc-def&s=abcdefgh_-12345678');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`${MIXER_URL}/#confirm=MASS-ABC-DEF.abcdefgh_-12345678`);
    });

    it('a Mixer-only code is still kept out of MAD streaming, and pointed at MIXER_URL', async () => {
      const res = await request(app).post('/api/access/validate')
        .send({ token: 'MASS-MIX-PLN', sessionId: '123e4567-e89b-42d3-a456-426614174000' });
      expect(res.status).toBe(403);
      expect(res.body.mixerOnly).toBe(true);
      expect(res.body.reason).toContain('mixer.test');
      expect((await request(app).get('/api/playlists').set('X-Access-Token', 'MASS-MIX-PLN')).body.mixerOnly).toBe(true);
    });
  });
});

// ── 4 · MIXER_URL and MIXER_SHARED_SECRET unset: no Mad Mixer in MAD at all ─────────────────
// (The old in-MAD Mixer — its page, MVSEP relay and usage file — was removed 2026-10-03.)
describe('with MIXER_URL and MIXER_SHARED_SECRET unset there is no Mad Mixer in MAD', () => {
  let app;
  beforeAll(async () => {
    vi.resetModules();
    vi.stubEnv('MAD_MIXER_ENABLED', 'true');
    vi.stubEnv('MIXER_SHARED_SECRET', '');
    vi.stubEnv('MIXER_URL', '');
    ({ app } = await import('../../server.js'));
  });

  it('no /mixer page, no 🎚 buttons, no menu item', async () => {
    expect((await request(app).get('/mixer?song=282')).status).toBe(404);
    expect((await request(app).get('/mad-mixer.html')).status).toBe(404);
    const home = await request(app).get('/');
    expect(home.text).toContain('window.__MAD_MIXER=false');
    expect(home.text).toContain('window.__MAD_MIXER_URL=false');
  });

  it('the internal API is not mounted', async () => {
    expect((await signed(app, 'POST', '/internal/mixer/entitlement', { code: 'MASS-MIX-PLN' })).status).toBe(404);
    expect((await signed(app, 'GET', '/internal/mixer/songs')).status).toBe(404);
  });

  it('every old in-MAD Mad Mixer endpoint is gone', async () => {
    for (const path of ['/api/mixer/ping', '/api/mixer/songs', '/api/mixer/mixable', '/api/mixer/mvsep/algorithms', '/api/mixer/audio-proxy?url=https://mvsep.com/x.wav']) {
      expect((await request(app).get(path).set('X-Access-Token', 'MASS-MAD-ONL')).status, path).toBe(404);
    }
    expect((await request(app).post('/api/mixer/mvsep/create').set('X-Access-Token', 'MASS-MAD-ONL')).status).toBe(404);
    expect((await request(app).post('/api/mixer/trial').send({ email: 'x@example.com' })).status).toBe(404);
  });

  it('MAD sign-in still points a Mixer-only code at /mixer inside MAD', async () => {
    const res = await request(app).post('/api/access/validate')
      .send({ token: 'MASS-MIX-PLN', sessionId: '123e4567-e89b-42d3-a456-426614174000' });
    expect(res.status).toBe(403);
    expect(res.body.reason).toContain('musicafricadirect.com/mixer');
  });
});

// ── 5 · MAD_MIXER_ENABLED off, the bridge on: the Mixer works, MAD shows nothing of it ──────────
describe('MAD_MIXER_ENABLED off with MIXER_SHARED_SECRET + MIXER_URL set', () => {
  let app;
  beforeAll(async () => {
    vi.resetModules();
    vi.stubEnv('MAD_MIXER_ENABLED', 'false');
    vi.stubEnv('MIXER_SHARED_SECRET', SECRET);
    vi.stubEnv('MIXER_URL', MIXER_URL);
    ({ app } = await import('../../server.js'));
  });

  it('the signed internal API still answers Mad Mixer', async () => {
    expect((await signed(app, 'POST', '/internal/mixer/entitlement', { code: 'MASS-CMB-001' })).body).toMatchObject({ valid: true, entitled: true, plan: 'combined' });
    expect((await signed(app, 'GET', '/internal/mixer/songs')).status).toBe(200);
  });

  it('no 🎚 buttons, no menu item, no /mixer on MAD', async () => {
    const home = await request(app).get('/');
    expect(home.text).toContain('window.__MAD_MIXER=false');
    expect(home.text).toContain('window.__MAD_MIXER_URL=false');
    expect((await request(app).get('/mixer')).status).toBe(404);
    expect((await request(app).get('/api/mixer/mixable').set('X-Access-Token', 'MASS-MAD-ONL')).status).toBe(404);
  });
});
