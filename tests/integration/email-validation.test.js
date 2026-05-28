import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

let app;

beforeAll(async () => {
  const mod = await import('../../server.js');
  app = mod.app;
});

describe('strict email validation at money/auth entry points', () => {
  // Each of these endpoints used to accept anything-with-an-@.
  // Phase 2 hardens them to isStrictEmail.
  const cases = [
    { method: 'post', path: '/api/payments/initialize', extra: { plan: '1-day' } },
    { method: 'post', path: '/api/payments/trial',      extra: {} },
    { method: 'post', path: '/api/payments/subscribe',  extra: {} },
    { method: 'post', path: '/api/ringtone/initiate',   extra: { src: 'https://x/y.mp3', durationSec: 5 } },
    // download/initiate also needs trackId + trackRecordId so we send dummies
    { method: 'post', path: '/api/download/initiate',   extra: { trackId: 'T', trackRecordId: '1' } },
  ];

  for (const c of cases) {
    it(`${c.path}: rejects 'a@b' (no TLD)`, async () => {
      const res = await request(app)[c.method](c.path).send({ email: 'a@b', ...c.extra });
      expect(res.status).toBe(400);
    });

    it(`${c.path}: rejects 'a@b.c' (TLD too short)`, async () => {
      const res = await request(app)[c.method](c.path).send({ email: 'a@b.c', ...c.extra });
      expect(res.status).toBe(400);
    });

    it(`${c.path}: rejects empty body`, async () => {
      const res = await request(app)[c.method](c.path).send({});
      expect(res.status).toBe(400);
    });

    it(`${c.path}: rejects numeric TLD 'user@example.123'`, async () => {
      const res = await request(app)[c.method](c.path).send({ email: 'user@example.123', ...c.extra });
      expect(res.status).toBe(400);
    });
  }
});

describe('strict email validation on /email/start', () => {
  it('rejects malformed email even with a token', async () => {
    const res = await request(app)
      .post('/api/access/email/start')
      .send({ token: 'MASS-XXXX-XXXX', email: 'not-an-email' });
    expect(res.status).toBe(400);
  });
});
