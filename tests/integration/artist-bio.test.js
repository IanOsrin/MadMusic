import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

// Artist bios ship dark: ARTIST_BIO_ENABLED defaults off. The route is public
// (skip-listed like /featured-editorial), so when off it returns a graceful
// { enabled:false, found:false } — never the 403 token wall, never a 404.
// It reads the FM `API_Artist_Bio` layout via SWR when enabled. See routes/artist-bio.js.

let app, normalizeName, mapRecord, buildIndex;

beforeAll(async () => {
  delete process.env.ARTIST_BIO_ENABLED; // ensure default-off for the route test
  const mod = await import('../../routes/artist-bio.js');
  ({ normalizeName, mapRecord, buildIndex } = mod);
  app = (await import('../../server.js')).app;
});

const rec = (fieldData) => ({ fieldData });

describe('artist-bio pure helpers', () => {
  it('normalizeName lowercases, trims, and collapses inner whitespace', () => {
    expect(normalizeName('  Brenda   Fassie ')).toBe('brenda fassie');
    expect(normalizeName(null)).toBe('');
  });

  it('mapRecord shapes the payload and nulls empty optional fields', () => {
    const a = mapRecord(rec({
      Artist_Name: 'Brenda Fassie', Bio: 'MaBrrr.', Image_S3_URL: '', Country: 'ZA',
    }));
    expect(a.name).toBe('Brenda Fassie');
    expect(a.imageUrl).toBeNull();
    expect(a.country).toBe('ZA');
    expect(a.links).toBeUndefined(); // links deferred from v1
  });

  it('buildIndex keys by name + aliases and skips records missing name or bio', () => {
    const index = buildIndex([
      rec({ Artist_Name: 'Brenda Fassie', Bio: 'MaBrrr.', Aliases: 'MaBrrr | Brenda' }),
      rec({ Artist_Name: 'No Bio Here', Bio: '' }),          // skipped: no bio
      rec({ Artist_Name: '', Bio: 'orphan' }),               // skipped: no name
    ]);
    expect(index.get('brenda fassie')?.name).toBe('Brenda Fassie');
    expect(index.get('mabrrr')?.name).toBe('Brenda Fassie'); // alias resolves
    expect(index.get('brenda')?.name).toBe('Brenda Fassie'); // alias resolves
    expect(index.has('no bio here')).toBe(false);
    expect(index.has('')).toBe(false);
  });

  it('first record wins on a duplicate key (stable curation)', () => {
    const index = buildIndex([
      rec({ Artist_Name: 'Sipho', Bio: 'first' }),
      rec({ Artist_Name: 'Sipho', Bio: 'second' }),
    ]);
    expect(index.get('sipho').bio).toBe('first');
  });
});

describe('artist-bio route (ARTIST_BIO_ENABLED off by default)', () => {
  it('is public and returns a graceful disabled payload, not the token wall or a 404', async () => {
    const res = await request(app).get('/api/artist-bio?name=Brenda%20Fassie');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, enabled: false, found: false });
    expect(res.body.requiresAccessToken).toBeUndefined();
  });
});
