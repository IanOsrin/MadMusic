// Behavior baseline for the PLAYBACK path, which the screenshot tests cannot
// exercise. This guards the diverged functions slated for reconciliation —
// getAudioUrl (S3 vs proxy branch), sendStreamEvent, and the play→UI wiring —
// so they can be deduped safely.
//
// The harness replays fixtures and blocks external network, so the audio never
// actually decodes; we assert the synchronous/observable effects of starting a
// track, not real audio output.

import { test, expect } from '@playwright/test';
import { primePage } from './harness.js';

test('starting a track resolves the audio URL, activates the player, and emits stream events', async ({ page }) => {
  const streamPosts = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/access/stream-events')) streamPosts.push(r.url());
  });

  await primePage(page);
  await page.goto('/');
  await page.waitForLoadState('load');
  await page.waitForTimeout(1500);

  // Drive the exact function the card's play button (.trending-play-btn) invokes.
  // It is hover-revealed, so we call it directly rather than fighting visibility.
  const recordId = await page.evaluate(() => {
    const store = window.itemsStore;
    return store && store.size ? [...store.keys()][0] : null;
  });
  expect(recordId, 'a playable track is loaded into the store').toBeTruthy();

  await page.evaluate((id) => window.playSong(id), recordId);
  await page.waitForTimeout(1500);

  const state = await page.evaluate(() => {
    const a = document.getElementById('player');
    const up = document.getElementById('unifiedPlayer');
    return {
      audioSrc: a ? (a.getAttribute('src') || a.src || '') : '',
      unifiedPlayerClass: up ? up.className : '',
    };
  });

  // getAudioUrl: this fixture track is an S3 URL, which must be returned DIRECTLY
  // (an .mp3), not wrapped in the /api/container proxy.
  expect(state.audioSrc, 'audio src resolved').toMatch(/^https?:\/\/\S+\.mp3(\?|$)/);
  expect(state.audioSrc, 'S3 audio is not proxied').not.toContain('/api/container');
  // play→UI wiring: the unified player ribbon activates.
  expect(state.unifiedPlayerClass).toContain('active');
  // sendStreamEvent fired at least once (PLAY/PROGRESS/ERROR all prove the wiring).
  await expect.poll(() => streamPosts.length, { timeout: 3000 }).toBeGreaterThan(0);
});
