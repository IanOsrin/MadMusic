// Critical desktop UI (the search override, the album detail view) must NOT be
// gated on window 'load'. app.min.js is deferred — it has always executed by
// DOMContentLoaded — whereas 'load' also waits for every image on the page.
// With slow artwork that left doSearch/showAlbumDetailView undefined for 20+
// seconds while the page looked ready: clicks and searches silently did
// nothing (2026-07-31, found while chasing the G100 Global Favourites rail).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appHtml = readFileSync(join(root, 'public', 'app.html'), 'utf8');

describe('desktop interactivity is not gated on window load', () => {
  it("app.html registers no window 'load' listeners", () => {
    const offenders = appHtml
      .split('\n')
      .map((l, i) => ({ n: i + 1, l }))
      .filter(({ l }) => /window\.addEventListener\(\s*['"]load['"]/.test(l));
    expect(offenders.map((o) => `app.html:${o.n}`), 'use DOMContentLoaded (deferred scripts run before it), not load').toEqual([]);
  });

  it('both critical blocks use a readyState/DOMContentLoaded gate', () => {
    const gates = appHtml.match(/document\.readyState === 'loading'\s*\)\s*document\.addEventListener\('DOMContentLoaded'/g) || [];
    expect(gates.length, 'search override + album detail view each need the gate').toBeGreaterThanOrEqual(2);
  });
});
