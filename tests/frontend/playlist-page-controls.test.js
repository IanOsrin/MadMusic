// Ian, 2026-11-16, on a Themes playlist: "there is a blank bar that i think should have controls,
// also not intuitive making the theme playlist play". The blank bar was the empty artist-bio box
// and Delete showed on a read-only playlist: both had display rules that beat [hidden].
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const app = readFileSync(resolve(process.cwd(), 'public/app.html'), 'utf8');
const css = readFileSync(resolve(process.cwd(), 'public/css/app.css'), 'utf8');

describe('playlist page (Themes, MAD About, shared and own playlists)', () => {
  it('a hidden biography box and a hidden Delete button really are hidden', () => {
    expect(app).toMatch(/\.artist-bio\[hidden\] \{ display:none; \}/);
    expect(css).toMatch(/\.playlist-view-action-btn\[hidden\] \{ display: none; \}/);
  });

  it('has a Play button that plays the playlist, or pauses it while it plays', () => {
    expect(app).toMatch(/id="userPlaylistPlayBtn"/);
    expect(app).toMatch(/if \(playBtn\) playBtn\.onclick = playOrPause;/);
    expect(app).toMatch(/playTrackAtIndex\(Math\.max\(0, currentTrackIdx\)\);/);
  });

  it('Play playlist sits under the now-playing card, not in the header', () => {
    const header = app.slice(app.indexOf('id="userPlaylistActions"'), app.indexOf('<!-- Two Column Layout -->'));
    expect(header).not.toMatch(/userPlaylistPlayBtn/);
    expect(app).toMatch(/<div class="playlist-page-playbar">[\s\S]{0,200}id="userPlaylistPlayBtn"/);
    expect(app).toMatch(/textContent = on \? 'Pause' : 'Play playlist'/);
  });

  // Ian: "any other play command must also launch the playlist". The bar's play, a media key or a
  // headset button started the preloaded first song bare: no playlist after it, and for a guest
  // the whole song instead of the preview.
  it('starting the preloaded first song any other way starts the playlist', () => {
    expect(app).toMatch(/window\._playlistPendingStart = \{ src: audioEl\.src, start: \(\) => playTrackAtIndex\(0\) \};/);
    expect(app).toMatch(/if \(ps && audioEl\.src === ps\.src\) \{ audioEl\.pause\(\); ps\.start\(\); \}/);
    // a song clicked on the left, or the playlist moving on, cancels it
    expect(app.match(/window\._playlistPendingStart = null;/g).length).toBeGreaterThanOrEqual(3);
  });

  it('the selected song stays readable in dark mode (no fixed near-white background)', () => {
    expect(css).not.toMatch(/\.playlist-page-album-item\.selected \{ background: #F5F8FF; \}/);
  });
});
