// Feature guard: clicking the ringtone scissors (#upRingtoneBtn) must stop
// main-page playback so the track doesn't play over the ringtone editor, and
// then open the ringtone editor modal.
//
// We can't decode real audio in this headless harness, so rather than assert the
// final <audio>.paused state we spy on the actual stop entrypoint the feature
// calls (window.stopPlayback) and confirm the editor opens.

import { test, expect } from '@playwright/test';
import { primePage } from './harness.js';

test('clicking the ringtone scissors stops main-page playback and opens the editor', async ({ page }) => {
  await primePage(page);
  await page.goto('/');
  await page.waitForLoadState('load');
  await page.waitForTimeout(1500);

  await page.evaluate(() => {
    // Activate the scissors as updateRingtoneBtn would once a track is playing.
    const btn = document.getElementById('upRingtoneBtn');
    btn.href = '/ringtone?src=test&name=Test';
    btn.classList.add('visible');

    // Record every stop mechanism stopMainPlayback() reaches for.
    window.__stopCalls = [];
    const origStop = window.stopPlayback;
    window.stopPlayback = function () {
      window.__stopCalls.push('stopPlayback');
      return typeof origStop === 'function' ? origStop.apply(this, arguments) : undefined;
    };
    const p = document.getElementById('player');
    const origPause = p.pause.bind(p);
    p.pause = function () { window.__stopCalls.push('pause'); return origPause(); };
  });

  // The scissors lives in the unified-player bar (display:none without real
  // playback, so a pointer click can't land on it). Dispatch the DOM click
  // directly — we're exercising the click handler, not bar visibility.
  await page.evaluate(() => document.getElementById('upRingtoneBtn').click());
  await page.waitForTimeout(300);

  // The feature stopped playback via the player module's stop entrypoint...
  const stopCalls = await page.evaluate(() => window.__stopCalls);
  expect(stopCalls, 'stopMainPlayback invoked the player stop()').toContain('stopPlayback');
  // ...and opened the ringtone editor.
  await expect(page.locator('#ringtoneModalOverlay')).toBeVisible();
});
