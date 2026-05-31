// Feature guard: clicking the ringtone scissors (#upRingtoneBtn) must
//  (a) stop main-page playback so the track doesn't play over the editor, and
//  (b) open the modal on the RINGTONE editor URL — not the homepage.
//
// Regression note: stopMainPlayback() resets the scissors (hideRingtoneBtn sets
// href='#'), so the handler must capture the ringtone URL BEFORE stopping. We run
// the REAL window.stopPlayback (no spy) so that reset actually happens — then the
// iframe must still load /ringtone, proving the capture-before-stop ordering.

import { test, expect } from '@playwright/test';
import { primePage } from './harness.js';

test('ringtone scissors stops playback and opens the ringtone editor (not the homepage)', async ({ page }) => {
  await primePage(page);
  await page.goto('/');
  await page.waitForLoadState('load');
  await page.waitForTimeout(1500);

  // Activate the scissors as updateRingtoneBtn would once a track is playing.
  await page.evaluate(() => {
    const btn = document.getElementById('upRingtoneBtn');
    btn.href = '/ringtone?src=test&name=Test';
    btn.classList.add('visible');
  });

  // The scissors lives in the unified-player bar (display:none without real
  // playback), so dispatch the DOM click directly rather than a pointer click.
  await page.evaluate(() => document.getElementById('upRingtoneBtn').click());
  await page.waitForTimeout(300);

  const state = await page.evaluate(() => ({
    modalDisplay: document.getElementById('ringtoneModalOverlay')?.style.display || '',
    frameSrc: document.getElementById('ringtoneModalFrame')?.getAttribute('src') || '',
    scissorsHrefAfter: document.getElementById('upRingtoneBtn').getAttribute('href'),
  }));

  // The editor modal opened...
  expect(state.modalDisplay, 'ringtone modal is shown').toBe('flex');
  // ...on the ringtone editor URL, NOT the homepage (the bug this guards).
  expect(state.frameSrc, 'modal iframe loads the ringtone editor').toContain('/ringtone');
  // ...and playback was actually stopped: the real stopPlayback runs hideRingtoneBtn,
  // which resets the scissors href to '#'.
  expect(state.scissorsHrefAfter, 'stopMainPlayback ran (scissors reset)').toBe('#');
});
