import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrecompressedStatic } from '../../lib/precompressed-static.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

// Mirrors server.js cacheControlFor for the assets exercised here.
function cacheControlFor(filePath) {
  if (filePath.includes('.min.')) return 'public, max-age=31536000, immutable';
  if (filePath.endsWith('.js') || filePath.endsWith('.css')) return 'public, max-age=3600, must-revalidate';
  return 'public, max-age=604800';
}

let app;
let mw;

beforeAll(() => {
  app = express();
  mw = createPrecompressedStatic(PUBLIC_DIR, cacheControlFor);
  app.use(mw);
  // Fallthrough sentinel: if the middleware calls next(), we land here.
  app.use((req, res) => res.status(204).set('X-Fellthrough', '1').end());
});

describe('precompressed-static', () => {
  it('precompresses the known text assets at boot', () => {
    expect(mw.stats.count).toBeGreaterThan(5);
    expect(mw.stats.brBytes).toBeLessThan(mw.stats.rawBytes); // compression actually happened
  });

  it('serves brotli for br-capable clients with correct headers', async () => {
    const res = await request(app).get('/app.min.js').set('Accept-Encoding', 'br, gzip');
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('br');
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.headers['vary']).toBe('Accept-Encoding');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['etag']).toBeTruthy();
    // Brotli q11 is dramatically smaller than the ~297KB raw source.
    const len = Number(res.headers['content-length']);
    expect(len).toBeGreaterThan(0);
    expect(len).toBeLessThan(120000);
  });

  it('serves gzip when br is not accepted', async () => {
    const res = await request(app).get('/css/app.css').set('Accept-Encoding', 'gzip');
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['content-type']).toMatch(/css/);
  });

  it('falls through to next() when no compression is accepted', async () => {
    const res = await request(app).get('/css/app.css').set('Accept-Encoding', 'identity');
    expect(res.status).toBe(204);
    expect(res.headers['x-fellthrough']).toBe('1');
  });

  it('answers If-None-Match with 304', async () => {
    const first = await request(app).get('/app.min.js').set('Accept-Encoding', 'br');
    const etag = first.headers['etag'];
    const second = await request(app).get('/app.min.js').set('Accept-Encoding', 'br').set('If-None-Match', etag);
    expect(second.status).toBe(304);
  });

  it('falls through on X-No-Compression so express.static can serve raw', async () => {
    const res = await request(app).get('/app.min.js').set('Accept-Encoding', 'br').set('X-No-Compression', '1');
    expect(res.status).toBe(204);
    expect(res.headers['x-fellthrough']).toBe('1');
  });

  it('falls through for unknown paths', async () => {
    const res = await request(app).get('/does-not-exist.js').set('Accept-Encoding', 'br');
    expect(res.status).toBe(204);
  });
});
