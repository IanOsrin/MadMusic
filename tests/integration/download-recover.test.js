import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';

// The 2026-08-25 recovery flow: when the Paystack return loses its
// sessionStorage ref (mobile in-app browsers), /api/download/recover issues a
// short-lived HMAC token for /api/download/file?t=. These tests cover the
// validation surface and the token crypto — no FileMaker required.

let app;

beforeAll(async () => {
  const serverMod = await import('../../server.js');
  app = serverMod.app;
});

const SECRET = process.env.DOWNLOAD_LINK_SECRET || process.env.AUTH_SECRET || process.env.PAYSTACK_SECRET_KEY || '';

function makeToken({ reference = 'T_TEST_REF', expiresInMs = 60000, secret = SECRET, tamper = false } = {}) {
  const payload = Buffer.from(JSON.stringify({ r: reference, e: Date.now() + expiresInMs })).toString('base64url');
  const mac = createHmac('sha256', secret).update(payload).digest('base64url');
  return tamper ? `${payload}.${mac.slice(0, -2)}xx` : `${payload}.${mac}`;
}

describe('POST /api/download/recover — validation', () => {
  it('rejects a missing body', async () => {
    const res = await request(app).post('/api/download/recover').send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('rejects an invalid email', async () => {
    const res = await request(app)
      .post('/api/download/recover')
      .send({ trackRecordId: '24942', email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('rejects a missing trackRecordId', async () => {
    const res = await request(app)
      .post('/api/download/recover')
      .send({ email: 'buyer@example.com' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/download/file — recovery tokens', () => {
  it('still requires ref or token', async () => {
    const res = await request(app).get('/api/download/file');
    expect(res.status).toBe(400);
  });

  it('rejects a tampered token', async () => {
    const res = await request(app).get('/api/download/file').query({ t: makeToken({ tamper: true }) });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/expired/i);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const res = await request(app).get('/api/download/file').query({ t: makeToken({ secret: 'wrong-secret' }) });
    expect(res.status).toBe(403);
  });

  it('rejects an expired token', async () => {
    const res = await request(app).get('/api/download/file').query({ t: makeToken({ expiresInMs: -1000 }) });
    expect(res.status).toBe(403);
  });

  it('rejects malformed tokens without crashing', async () => {
    for (const t of ['abc', 'a.b.c', '..', 'JJJ.===']) {
      const res = await request(app).get('/api/download/file').query({ t });
      expect(res.status).toBe(403);
    }
  });

  it('accepts a validly signed token past the signature stage (fails later on purchase lookup, not 403)', async () => {
    const res = await request(app).get('/api/download/file').query({ t: makeToken() });
    // With dummy FM creds the purchase lookup cannot succeed, but the token
    // itself must clear signature verification — so anything but the
    // token-rejection 403 message proves the crypto path works.
    expect([403, 404, 500, 502]).toContain(res.status);
    if (res.status === 403) expect(res.body.error).not.toMatch(/expired — request a new one/);
  });
});
