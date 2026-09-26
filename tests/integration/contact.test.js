import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// POST /api/contact — the mobile "Contact us" form (2026-09-26). Public (no sign-in), so it
// must validate, ignore bots, and pass the customer's code/device along to support.

const sendContactEmailMock = vi.fn(async () => {});
vi.mock('../../lib/email.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, sendContactEmail: (...args) => sendContactEmailMock(...args) };
});

let app;
beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'mad-contact-test-'));
  ({ app } = await import('../../server.js'));
});

describe('POST /api/contact', () => {
  it('works without signing in and forwards the message with the details', async () => {
    const res = await request(app).post('/api/contact')
      .set('X-Access-Token', 'mass-abc-123')
      .set('User-Agent', 'TestPhone/1.0')
      .send({ email: 'Listener@Example.com', message: 'The trial loops', page: '/mobile' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const arg = sendContactEmailMock.mock.calls.at(-1)[0];
    expect(arg.email).toBe('listener@example.com');
    expect(arg.message).toBe('The trial loops');
    expect(arg.details['Access code']).toBe('MASS-ABC-123');
    expect(arg.details.Device).toBe('TestPhone/1.0');
  });

  it('needs a valid email and a message', async () => {
    expect((await request(app).post('/api/contact').send({ email: 'nope', message: 'help' })).status).toBe(400);
    expect((await request(app).post('/api/contact').send({ email: 'a@b.co', message: '' })).status).toBe(400);
  });

  it('quietly drops bot submissions (honeypot)', async () => {
    const before = sendContactEmailMock.mock.calls.length;
    const res = await request(app).post('/api/contact').send({ email: 'a@b.co', message: 'buy pills', website: 'spam.example' });
    expect(res.body.ok).toBe(true);
    expect(sendContactEmailMock.mock.calls.length).toBe(before);
  });
});
