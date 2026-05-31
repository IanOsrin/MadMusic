// Guards the module-scope global-exposure contract for mobile.
//
// mobile/main.js is an ES module, so top-level `function foo(){}` is NOT attached
// to window. mobile.html markup and dynamically-built template strings call these
// handlers by name via on*="…" attributes; if an exposure is dropped, the button
// silently no-ops (a failure the structural/visual nets do not otherwise catch).
// This asserts each inline handler resolves to a global function after the module
// boots. Keep in sync with the Object.assign(window, {…}) block + the window.X =
// self-assignments in main.js.

import { test, expect } from '@playwright/test';
import { primePage } from './harness.js';

// Functions reached by inline on*="name(" in markup or in JS template strings.
const INLINE_HANDLERS = [
  // Exposed via Object.assign(window, {…}) at the bottom of main.js:
  'loadNewReleases', 'loadG100', 'filterG100Albums', 'refreshDiscover',
  'buyAccess', 'setAccessToken', 'closeModal',
  // Self-assigned via window.X = function(…) in main.js:
  'selectGenre', 'clearGenreFilter', 'clearDecadeFilter', 'clearAllFilters',
];

test('mobile inline on*-handlers are exposed as globals after the module boots', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await primePage(page);
  await page.goto('/mobile');
  await page.waitForLoadState('load');
  await page.waitForTimeout(500);

  const missing = await page.evaluate(
    (names) => names.filter((n) => typeof window[n] !== 'function'),
    INLINE_HANDLERS,
  );
  expect(missing, 'inline handlers not exposed on window (button would silently no-op)').toEqual([]);
});
