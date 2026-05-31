// Smoke test for the mobile ES-module graph: visit every tab and assert no
// uncaught exception fires. Each tab's render path pulls in a different mobile
// module (nav/rails/search/playlists/cards/player/auth), so a broken import or
// an unresolved cross-module reference surfaces here as a pageerror — the exact
// failure mode the structural/visual nets do not otherwise catch. Network
// failures (dummy-cred backend) are NOT pageerrors, so they don't trip this.

import { test, expect } from '@playwright/test';
import { primePage } from './harness.js';

const TABS = ['newreleases', 'g100', 'discover', 'search', 'genres', 'decades', 'playlists', 'profile'];

test('mobile: switching through every tab raises no uncaught exceptions', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.setViewportSize({ width: 390, height: 844 });
  await primePage(page);
  await page.goto('/mobile');
  await page.waitForLoadState('load');
  await page.waitForTimeout(500);

  for (const tab of TABS) {
    const el = page.locator(`[data-tab="${tab}"]`);
    if (await el.count()) {
      await el.first().click();
      await page.waitForTimeout(250);
    }
  }

  // Exercise the search path (its own module) with a real query. Re-select the
  // search tab first so its input is visible/editable.
  await page.locator('[data-tab="search"]').first().click();
  const search = page.locator('#search-input');
  if (await search.count()) {
    await search.fill('love');
    await page.waitForTimeout(700);
  }

  expect(errors, `uncaught exceptions while navigating tabs:\n${errors.join('\n')}`).toEqual([]);
});
