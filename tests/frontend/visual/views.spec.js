// Page-render + visual baseline for the three sprawling views.
//
// Each view is loaded with a seeded token and replayed API fixtures (see
// harness.js) so it renders deterministically and offline. We assert the key
// structural landmarks exist (behavior) and capture a screenshot (layout). After
// an intentional UI change, refresh screenshots with:
//   npx playwright test --update-snapshots

import { test, expect } from '@playwright/test';
import { primePage } from './harness.js';

// Let fixture-driven rails finish rendering before asserting / screenshotting.
async function settle(page) {
  await page.waitForLoadState('load');
  await page.waitForTimeout(1500);
}

test.describe('frontend views render', () => {
  test('desktop home (app.html) renders core chrome + rails', async ({ page }) => {
    await primePage(page);
    await page.goto('/');
    await settle(page);

    // Behavior: the player and a primary rail container must exist.
    await expect(page.locator('#player, #unifiedPlayer').first()).toBeAttached();
    await expect(page.locator('#trendingContainer')).toBeAttached();
    await expect(page.locator('#navAlbumsBtn')).toBeAttached();

    // Layout: viewport screenshot (stable across runs thanks to fixtures).
    await expect(page).toHaveScreenshot('home-desktop.png');
  });

  test('mobile view (mobile.html) renders player + content sections', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await primePage(page);
    await page.goto('/mobile');
    await settle(page);

    await expect(page.locator('#floating-player')).toBeAttached();
    await expect(page.locator('#newreleases-content')).toBeAttached();

    await expect(page).toHaveScreenshot('mobile.png');
  });
});
