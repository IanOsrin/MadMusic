// Guard: a public playlist must not appear until it has cover art.
// The cover is the publish switch (PLAYLISTS_REQUIRE_ART, default ON) — editors
// tag PublicPlaylist tracks in FM ahead of the art department, and the playlist
// stays invisible until its art exists (API_Playlist_Art or local file).
// Regression this prevents: 2026-07-09, nine artless "MAD-About …" playlists
// surfaced on the FM-mode service (madmusic.onrender.com) the moment tracks
// were tagged, because nothing gated on artwork.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const src = readFileSync(
  path.join(process.cwd(), 'routes', 'catalog', 'discovery.js'),
  'utf8'
);

describe('public playlists require artwork', () => {
  it('has the require-art flag, defaulting ON', () => {
    expect(src).toMatch(/PLAYLISTS_REQUIRE_ART\s*=\s*process\.env\.PLAYLISTS_REQUIRE_ART\s*!==\s*'false'/);
  });

  it('filters artless playlists out of the list payload', () => {
    expect(src).toMatch(/PLAYLISTS_REQUIRE_ART\s*\?\s*withArt\.filter\(pl\s*=>\s*pl\.imageUrl\)/);
  });

  it('logs what it hides so a missing playlist is diagnosable', () => {
    expect(src).toMatch(/hidden pending artwork/);
  });
});
