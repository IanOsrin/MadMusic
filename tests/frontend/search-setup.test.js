import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Guard for the "Search button does nothing" bug (2026-07-31).
//
// The Search button's click handler is registered INSIDE setupSearchOverride().
// That function only runs once app.min.js has defined window.run. The original
// code polled for it and gave up after 2s:
//
//   setTimeout(() => clearInterval(checkInterval), 2000);
//
// app.min.js is deferred, ~300KB, and assigns window.run near its end, so a slow
// connection or cold origin blew that budget — the poll quit, setupSearchOverride
// never ran, and the button was left with NO click handler for the whole page
// load. A reload appeared to "fix" it because the bundle was then cached, which
// is what made the failure look intermittent.
//
// The fix relies on a guarantee rather than a race: deferred scripts always
// execute BEFORE DOMContentLoaded, so installing on DOMContentLoaded cannot miss
// window.run no matter how slow the bundle is. These are static assertions on the
// source because the setup is inline in app.html and can't be imported.

let html;

beforeAll(async () => {
  html = await readFile(path.resolve('public/app.html'), 'utf8');
});

describe('desktop search override installation', () => {
  it('never abandons installation on a timer', () => {
    // The exact regression: a timeout that kills the poll before the bundle lands.
    expect(html).not.toMatch(/setTimeout\(\s*\(\)\s*=>\s*clearInterval\(checkInterval\)\s*,\s*\d+\s*\)/);
  });

  it('installs on DOMContentLoaded, which is guaranteed to follow deferred scripts', () => {
    const setup = html.slice(html.indexOf('let searchSetupDone'), html.indexOf('let searchSetupDone') + 2000);
    expect(setup).toContain('trySetupSearch');
    expect(setup).toContain('DOMContentLoaded');
    // readyState guard so a late-parsed page still installs immediately.
    expect(setup).toContain("document.readyState === 'loading'");
  });

  it('is idempotent — the override must not be installed twice', () => {
    // Double-installing would re-wrap doSearch and double-bind the go button,
    // firing every search twice.
    const setup = html.slice(html.indexOf('let searchSetupDone'), html.indexOf('let searchSetupDone') + 2000);
    expect(setup).toMatch(/if\s*\(\s*searchSetupDone\s*\)\s*return/);
  });

  it('still keeps app.min.js deferred (the premise of the DOMContentLoaded fix)', () => {
    // If the bundle ever stops being deferred, the guarantee above changes and
    // this fix needs revisiting.
    expect(html).toMatch(/<script\s+defer\s+src="\/app\.min\.js/);
  });

  it('surfaces a clear error if the bundle never defines window.run', () => {
    expect(html).toContain('app.min.js did not define window.run');
  });
});
