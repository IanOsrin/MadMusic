// Feature guard (mobile): tapping the ringtone scissors (#mobileRingtoneBtn) must
//  (a) stop main playback so the track doesn't play over the editor, and
//  (b) open the ringtone modal on the /ringtone editor URL.
//
// Mobile has its own <audio id="audio"> and no window.stopPlayback, so the
// handler pauses the element directly. We spy on audio.pause rather than rely on
// real decode (the harness blocks audio), mirroring the desktop guard's intent.

import { test, expect } from '@playwright/test';
import { primePage } from './harness.js';

test('mobile ringtone scissors pauses playback and opens the editor', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await primePage(page);
  await page.goto('/mobile');
  await page.waitForLoadState('load');
  await page.waitForTimeout(500);

  // Arm the scissors (normally updateRingtoneBtn sets href on play) and spy on pause.
  await page.evaluate(() => {
    const audio = document.getElementById('audio');
    window.__pauseCalled = false;
    const orig = audio.pause.bind(audio);
    audio.pause = () => { window.__pauseCalled = true; return orig(); };
    document.getElementById('mobileRingtoneBtn').href = '/ringtone?src=test&name=Test&artist=X';
  });

  await page.evaluate(() => document.getElementById('mobileRingtoneBtn').click());
  await page.waitForTimeout(200);

  const r = await page.evaluate(() => ({
    pauseCalled: window.__pauseCalled,
    modal: document.getElementById('ringtoneModalOverlay')?.style.display || '',
    frame: document.getElementById('ringtoneModalFrame')?.getAttribute('src') || '',
  }));

  expect(r.pauseCalled, 'scissors paused main playback').toBe(true);
  expect(r.modal, 'ringtone modal is shown').toBe('flex');
  expect(r.frame, 'modal iframe loads the ringtone editor').toContain('/ringtone');
});
