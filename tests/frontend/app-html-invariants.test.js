// Desktop app.html invariants — landmines that have each caused a real bug.
// Static source scans, same discipline as mobile-invariants.test.js.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appHtml = readFileSync(join(root, 'public', 'app.html'), 'utf8');

describe('app.html invariants', () => {
  it('no element reuses id="themeToggle" (claimed by app.min.js legacy view switcher)', () => {
    // app.min.js holds `const themeToggle = getElementById('themeToggle')` for a
    // long-removed classic/modern button. Any new element with that id gets
    // hijacked — its content overwritten with "Classic View"/"Modern View"
    // (real bug, 2026-06-11, dark-mode toggle).
    expect(appHtml).not.toMatch(/id="themeToggle"/);
  });

  it('discovery.js owns NO theme logic (the duplicate "Modern Dark Mode" system)', () => {
    // discovery.js once had a second dark-mode implementation (key
    // 'madmusic.darkMode', emoji icons) that double-bound #darkModeToggle and
    // re-applied its own preference after app.html's init — every click
    // toggled on then instantly off (real bug, 2026-06-12). app.html is the
    // single owner of dark mode.
    const discovery = readFileSync(join(root, 'public', 'js', 'discovery.js'), 'utf8');
    const code = discovery.replace(/\/\/[^\n]*/g, ''); // comments may mention it
    expect(code).not.toMatch(/getElementById\(['"]darkModeToggle['"]\)/);
    expect(code).not.toMatch(/madmusic\.darkMode/);
    expect(code).not.toMatch(/function applyDarkMode/);
  });

  it('dark-mode toggle exists in the bottom profile row and is wired up', () => {
    expect(appHtml).toMatch(/id="darkModeToggle"/);
    expect(appHtml).toMatch(/getElementById\('darkModeToggle'\)/);
    // Click must not bubble into the account-popup row handler.
    const wiring = appHtml.slice(appHtml.indexOf("getElementById('darkModeToggle')"));
    expect(wiring.slice(0, 300)).toMatch(/stopPropagation/);
  });
});
