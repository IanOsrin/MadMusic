// The public catalogue pages (SEO tier 2) ship DARK: with the flag off, none
// of the routes exist and the sitemap stays the static three-URL map.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

let app;

beforeAll(async () => {
  delete process.env.CATALOG_PAGES_ENABLED; // explicitly off
  const mod = await import('../../server.js');
  app = mod.app || mod.default;
});

describe('catalog pages ring-fence (CATALOG_PAGES_ENABLED off)', () => {
  it.each(['/browse', '/artist/lucky-dube', '/album/anything', '/genre/gospel'])(
    '%s does not exist while the flag is off', async (path) => {
      const res = await request(app).get(path);
      expect(res.status).toBe(404);
      // and must NOT be the styled catalogue 404 (which would mean the router mounted)
      expect(res.text).not.toContain('Not on these shelves');
    });

  it('sitemap.xml serves the static map (3 URLs, no catalogue entries)', async () => {
    const res = await request(app).get('/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('xml');
    expect((res.text.match(/<url>/g) || []).length).toBe(3);
    expect(res.text).not.toContain('/artist/');
  });

  it('robots.txt points at the sitemap', async () => {
    const res = await request(app).get('/robots.txt');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Sitemap: https://musicafricadirect.com/sitemap.xml');
  });
});
