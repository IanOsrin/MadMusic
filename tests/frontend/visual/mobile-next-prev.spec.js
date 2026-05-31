// Guards mobile now-playing Next/Previous over the Discover feed.
//
// Bug: playing from Discover set playlistContext to the (often single-track)
// album, so Next/Prev no-op'd. Now playing from Discover sets the whole feed as
// the queue, so Next advances through it and Prev goes back.
//
// The prev/next buttons live in the player modal (hidden until tapped open), so
// we dispatch their DOM click directly — we're exercising the handlers.

import { test, expect } from '@playwright/test';
import { primePage } from './harness.js';

test('mobile now-playing Next/Prev navigate the Discover feed', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await primePage(page);
  await page.goto('/mobile');
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);

  // Open Discover and wait for the feed to render.
  await page.locator('[data-tab="discover"]').click();
  await page.locator('#discover-content .play-btn').first().waitFor({ timeout: 8000 });

  const title = () => page.evaluate(() => (document.getElementById('player-title') || {}).textContent || '');

  await page.locator('#discover-content .play-btn').first().click();
  await page.waitForTimeout(400);
  const t0 = await title();
  expect(t0, 'a track is playing').not.toBe('');

  // Next advances the feed.
  await page.evaluate(() => document.getElementById('next-btn').click());
  await page.waitForTimeout(400);
  const t1 = await title();
  expect(t1, 'Next moved to a different track').not.toBe(t0);

  // Prev returns to the first track.
  await page.evaluate(() => document.getElementById('prev-btn').click());
  await page.waitForTimeout(400);
  const t2 = await title();
  expect(t2, 'Prev returned to the first track').toBe(t0);
});
