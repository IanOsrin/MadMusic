import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import http from 'node:http';

// GET /api/preview/:recordId — public, server-clipped ~30 s stream.
// A local fixture server plays the S3 role (Range-supporting MP3 origin);
// containerUrlCache is pre-seeded so no FileMaker call is attempted.
//
// Fixture: CBR 128 kbps MPEG1 Layer III → 16 000 B/s → 30 s cap = 480 000 B.
const PREVIEW_CAP = 16000 * 30;
const FILE_SIZE = 600 * 1024; // comfortably larger than the cap

let app;
let fixtureServer;
let fixtureUrl;
let mp3;

function buildMp3(size) {
  const buf = Buffer.alloc(size);
  // 0xFF 0xFB = MPEG1 Layer III; 0x90 = 128 kbps @ 44100; stereo
  buf[0] = 0xff; buf[1] = 0xfb; buf[2] = 0x90; buf[3] = 0x00;
  return buf;
}

beforeAll(async () => {
  mp3 = buildMp3(FILE_SIZE);
  fixtureServer = http.createServer((req, res) => {
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      const start = parseInt(m[1], 10);
      const end = Math.min(m[2] ? parseInt(m[2], 10) : mp3.length - 1, mp3.length - 1);
      res.writeHead(206, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${mp3.length}`,
        'Accept-Ranges': 'bytes'
      });
      res.end(mp3.subarray(start, end + 1));
    } else {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': mp3.length });
      res.end(mp3);
    }
  });
  await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
  fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/track.mp3`;

  process.env.GUEST_PREVIEW_ENABLED = 'true';
  const mod = await import('../../server.js');
  app = mod.app;

  // Seed the resolution cache: recordId → fixture audio URL (no FM round-trip)
  const { containerUrlCache } = await import('../../cache.js');
  const { FM_LAYOUT } = await import('../../lib/fm-fields.js');
  containerUrlCache.set(`${FM_LAYOUT}::777001`, { url: fixtureUrl, field: 'S3_URL', artworkUrl: '' });
});

afterAll(async () => {
  delete process.env.GUEST_PREVIEW_ENABLED;
  await new Promise((resolve) => fixtureServer.close(resolve));
});

describe('GET /api/preview/:recordId (GUEST_PREVIEW_ENABLED)', () => {
  it('is public and serves exactly the 30 s byte cap, no more', async () => {
    const res = await request(app)
      .get('/api/preview/777001')
      .buffer(true)
      .parse((res2, cb) => {
        const chunks = [];
        res2.on('data', (c) => chunks.push(c));
        res2.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('audio/mpeg');
    expect(Number(res.headers['content-length'])).toBe(PREVIEW_CAP);
    expect(res.body.length).toBe(PREVIEW_CAP);
    expect(res.headers['x-preview-seconds']).toBe('30');
  });

  it('serves in-window Range requests as 206 with the preview as total size', async () => {
    const res = await request(app)
      .get('/api/preview/777001')
      .set('Range', 'bytes=100000-100999')
      .buffer(true)
      .parse((res2, cb) => {
        const chunks = [];
        res2.on('data', (c) => chunks.push(c));
        res2.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 100000-100999/${PREVIEW_CAP}`);
    expect(res.body.length).toBe(1000);
  });

  it('416s any Range starting at/after the preview boundary — no byte escapes the cap', async () => {
    const res = await request(app)
      .get('/api/preview/777001')
      .set('Range', `bytes=${PREVIEW_CAP}-`);
    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${PREVIEW_CAP}`);
  });

  it('clamps an open-ended Range to the cap', async () => {
    const res = await request(app)
      .get('/api/preview/777001')
      .set('Range', 'bytes=470000-')
      .buffer(true)
      .parse((res2, cb) => {
        const chunks = [];
        res2.on('data', (c) => chunks.push(c));
        res2.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(206);
    expect(res.body.length).toBe(PREVIEW_CAP - 470000);
  });

  it('errors cleanly on an unknown recordId (no audio bytes leak)', async () => {
    // Not seeded → falls through to FM. With dummy test creds FM is
    // unreachable → 502; against real FM a missing record is a 404.
    const res = await request(app).get('/api/preview/999999');
    expect([404, 502]).toContain(res.status);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('400s an invalid recordId', async () => {
    const res = await request(app).get('/api/preview/not-a-record;drop');
    expect(res.status).toBe(400);
  });

  it('stamps the client flag on', async () => {
    const res = await request(app).get('/');
    expect(res.text).toContain('window.__GUEST_PREVIEW=true');
  });
});
