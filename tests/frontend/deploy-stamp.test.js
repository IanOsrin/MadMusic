// Deploy-stamp cache busting — the rewrite in loadHtml() (server.js) that keeps
// returning visitors off stale JS/CSS.
//
// The landmine this covers: /app.min.js is the desktop bundle and it sits at the
// ROOT, not under /js/. The original rewrite only matched /js/ and /css/ paths,
// so the bundle was never stamped — while cacheControlFor() serves anything
// containing ".min." as `immutable` for a year. The ?v= in app.html had to be
// bumped by hand or a shipped desktop change simply never arrived (real bug,
// 2026-09-07: a picker change stayed invisible until the number was bumped).
//
// Served-HTML assertions, not a source scan: the point is what the browser gets.

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let app;
let html;

beforeAll(async () => {
  const mod = await import('../../server.js');
  app = mod.app;
  html = (await request(app).get('/')).text;
});

// Whatever loadHtml() stamped onto a known-good /js/ asset IS the boot stamp.
const bootStamp = () => html.match(/src="\/js\/helpers\.js\?v=([^"&]+)/)?.[1];

describe('deploy-stamp rewrite', () => {
  it('stamps the root-level /app.min.js bundle', () => {
    const stamp = bootStamp();
    expect(stamp).toBeTruthy();
    expect(html).toMatch(
      new RegExp(`src="/app\\.min\\.js\\?v=${stamp}(?:[&"])`)
    );
    // and the hand-written placeholder is gone from what we serve
    expect(html).not.toMatch(/src="\/app\.min\.js\?v=0/);
  });

  it('keeps extra query params after the stamped ?v=', () => {
    // The rewrite stops at the first `&`; app.min.js carries `&t=…`, and
    // swallowing it would drop a param the URL is authored with.
    expect(html).toMatch(/src="\/app\.min\.js\?v=[^"&]+&t=\d+"/);
  });

  it('still stamps /js/ and /css/ assets', () => {
    const stamp = bootStamp();
    expect(html).toMatch(new RegExp(`href="/css/app\\.css\\?v=${stamp}"`));
    for (const name of ['auth', 'player', 'catalog', 'discovery']) {
      expect(html).toMatch(new RegExp(`src="/js/${name}\\.js\\?v=${stamp}"`));
    }
  });

  it('leaves non-code assets alone', async () => {
    // The rewrite keys on the .js/.css extension precisely so authored image
    // versions survive — /img/g100-banner.png?v=2 is not a cache-bust target.
    const banner = readFileSync(join(root, 'public', 'app.html'), 'utf8')
      .match(/src="(\/img\/[^"]+\?v=[^"]+)"/)?.[1];
    expect(banner).toBeTruthy();
    expect(html).toContain(`src="${banner}"`);
  });

  it('stamps mobile.html too', async () => {
    const mobile = (await request(app).get('/mobile')).text;
    const stamp = mobile.match(/src="\/js\/helpers\.js\?v=([^"&]+)/)?.[1];
    expect(stamp).toBeTruthy();
    expect(mobile).toMatch(new RegExp(`href="/css/mobile\\.css\\?v=${stamp}"`));
    expect(mobile).toMatch(new RegExp(`src="/js/mobile/main\\.js\\?v=${stamp}"`));
  });
});

describe('app.html source', () => {
  it('keeps a ?v= placeholder on /app.min.js for the server to rewrite', () => {
    // Dropping the query string would silently switch cache busting off again:
    // there would be nothing for loadHtml() to replace, and the response is
    // `immutable, max-age=31536000`. The value itself is irrelevant.
    const appHtml = readFileSync(join(root, 'public', 'app.html'), 'utf8');
    expect(appHtml).toMatch(/src="\/app\.min\.js\?v=[^"&]+/);
  });
});
