// Static guards for the playlist icon picker (desktop + mobile).
//
// Regression this prevents: the picker shipped pointing at `artwork/Playlist_Jazz.jpg`
// — a filename convention that never existed in the bucket (real masters are
// `artwork/playlist-<slug>.jpg`) — behind an onerror fallback that swallowed the
// 404s. The grid rendered eight empty boxes and looked "unpopulated" rather than
// broken, so nothing surfaced it. These checks encode the two things that made
// it wrong: a hardcoded file list, and pointing at masters instead of the
// pre-generated _300 derivatives.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

const appJs      = read('public', 'app.min.js');
const mobileJs   = read('public', 'js', 'mobile', 'playlists.js');
const mobileMain = read('public', 'js', 'mobile', 'main.js');
const manifest   = JSON.parse(read('public', 'data', 'playlist-icons.json'));
const routes     = read('routes', 'playlists.js');

describe('icon manifest', () => {
  it('declares the artwork base and at least one icon', () => {
    expect(manifest.base).toMatch(/^https:\/\/mass-music-audio-files\.s3\..*\/artwork\/$/);
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThan(0);
  });

  it('gives every icon a file and a display name', () => {
    for (const icon of manifest.icons) {
      expect(icon.file, `icon ${icon.id} needs a file`).toBeTruthy();
      expect(icon.name || icon.id, `icon ${icon.file} needs a name`).toBeTruthy();
    }
  });

  it('uses master extensions the resizer actually picks up (jpg/jpeg/png)', () => {
    // resize-artwork.mjs matches /\.(jpe?g|png)$/i — a .webp or .heic master is
    // silently skipped and would never get a _300 derivative.
    for (const icon of manifest.icons) {
      expect(icon.file, `${icon.file} won't be resized`).toMatch(/\.(jpe?g|png)$/i);
    }
  });

  it('has no duplicate files or ids', () => {
    const files = manifest.icons.map(i => i.file);
    const ids   = manifest.icons.map(i => i.id);
    expect(new Set(files).size).toBe(files.length);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('desktop picker', () => {
  it('reads the manifest instead of a hardcoded list', () => {
    expect(appJs).toMatch(/fetch\('\/data\/playlist-icons\.json'\)/);
  });

  it('no longer references the filenames that never existed', () => {
    expect(appJs).not.toMatch(/Playlist_Jazz|Playlist_Marabi|Playlist_Kwela/);
  });

  it('displays the _300 derivative rather than the master', () => {
    expect(appJs).toMatch(/function playlistIconThumb/);
    expect(appJs).toMatch(/playlistIconThumb\(url, 300\)/);
  });

  it('shows the chosen icon on the playlist pill', () => {
    expect(appJs).toMatch(/playlistIconThumb\(pl\.artwork, 300\)/);
  });

  it('offers an artwork edit control that PATCHes', () => {
    expect(appJs).toMatch(/massPickPlaylistIcon/);
    expect(appJs).toMatch(/method: 'PATCH'/);
  });
});

describe('mobile picker', () => {
  it('reads the same manifest', () => {
    expect(mobileJs).toMatch(/fetch\('\/data\/playlist-icons\.json'\)/);
  });

  it('displays the _300 derivative rather than the master', () => {
    expect(mobileJs).toMatch(/export function playlistIconThumb/);
    expect(mobileJs).toMatch(/playlistIconThumb\(url, 300\)/);
  });

  it('offers the picker when creating', () => {
    expect(mobileJs).toMatch(/export async function createPlaylistFlow/);
    expect(mobileMain).toMatch(/createPlaylistFlow\(\)/);
    // The bare prompt()-only path is what the picker replaced.
    expect(mobileMain).not.toMatch(/createPlaylist\(name\)/);
  });

  it('prefers the owner-chosen icon over the first track cover', () => {
    expect(mobileJs).toMatch(/chosen \|\| firstArt \|\| '\/img\/default-album\.svg'/);
  });

  it('offers an artwork edit path', () => {
    expect(mobileJs).toMatch(/export async function editPlaylistArtwork/);
    expect(mobileJs).toMatch(/method: 'PATCH'/);
  });
});

describe('server accepts the edit', () => {
  it('exposes PATCH /:playlistId', () => {
    expect(routes).toMatch(/router\.patch\('\/:playlistId'/);
  });

  it('validates artwork through the shared whitelist, not an inline prefix check', () => {
    expect(routes).toMatch(/normalizePlaylistArtwork/);
    expect(routes).not.toMatch(/const S3_ARTWORK_BASE\s*=/);
  });

  it('rejects an unrecognised image instead of silently blanking it', () => {
    expect(routes).toMatch(/Unrecognised artwork image/);
  });
});
