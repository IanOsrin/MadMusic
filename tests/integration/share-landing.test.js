import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

// Social share landing: /?t=<recordId> must carry server-rendered OG tags
// (crawlers don't run JS) + a window.__SHARE_TRACK bootstrap for the app.
// trackRecordCache is pre-seeded so no FileMaker call is attempted.
let app;
let FM_LAYOUT;

const RID = '555001';

beforeAll(async () => {
  process.env.GUEST_PREVIEW_ENABLED = 'true'; // og:audio should point at the public preview
  const mod = await import('../../server.js');
  app = mod.app;

  const { trackRecordCache } = await import('../../cache.js');
  ({ FM_LAYOUT } = await import('../../lib/fm-fields.js'));
  trackRecordCache.set(`${FM_LAYOUT}::${RID}`, {
    recordId: RID,
    fieldData: {
      'Track Name': 'Great <Song> & "Quotes"',
      'Track Artist': 'Artist </script> One',
      'Album Title': 'Album Y',
      'Album Catalogue Number': 'CAT123',
      'Artwork_S3_URL': 'https://s3.example.com/artwork/resized/CAT123_800.webp'
    }
  });
});

describe('GET /?t=<recordId> (track share landing)', () => {
  it('injects escaped OG tags with art, title, and the preview as og:audio', async () => {
    const res = await request(app).get(`/?t=${RID}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('og:site_name');
    expect(res.text).toContain('Great &lt;Song&gt; &amp; &quot;Quotes&quot;');
    expect(res.text).toContain('https://s3.example.com/artwork/resized/CAT123_800.webp');
    expect(res.text).toContain(`/api/preview/${RID}`);
    expect(res.text).toContain('music.song');
    // Raw unescaped title must never appear in a meta attribute
    expect(res.text).not.toContain('content="Great <Song>');
  });

  it('inlines a script-safe __SHARE_TRACK bootstrap with the catalogue', async () => {
    const res = await request(app).get(`/?t=${RID}`);
    expect(res.text).toContain('window.__SHARE_TRACK=');
    expect(res.text).toContain('"catalogue":"CAT123"');
    // "</script>" inside field data must be <-escaped or it would
    // terminate the inline script tag (XSS).
    expect(res.text).not.toContain('Artist </script> One');
    expect(res.text).toContain('Artist \\u003c/script> One');
  });

  it('serves the plain app when the record cannot be resolved (never breaks)', async () => {
    const res = await request(app).get('/?t=999999');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('window.__SHARE_TRACK=');
  });

  it('redirects phone user-agents to the mobile app with the deep link intact', async () => {
    const res = await request(app)
      .get(`/?t=${RID}`)
      .set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/mobile?t=${RID}`);
  });

  it('does NOT redirect crawler user-agents (they must read the OG tags here)', async () => {
    const res = await request(app)
      .get(`/?t=${RID}`)
      .set('User-Agent', 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)');
    expect(res.status).toBe(200);
    expect(res.text).toContain('og:site_name');
  });

  it('serves OG tags on /mobile?t= too', async () => {
    const res = await request(app).get(`/mobile?t=${RID}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('og:site_name');
    expect(res.text).toContain('window.__SHARE_TRACK=');
  });

  it('leaves the plain / route untouched (no OG block, no bootstrap)', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('og:site_name');
    expect(res.text).not.toContain('window.__SHARE_TRACK=');
  });
});
