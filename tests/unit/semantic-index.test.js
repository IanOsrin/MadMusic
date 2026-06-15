import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { buildSuggestFixture } from '../fixtures/suggest-fixture.mjs';

// Point the lib at a tiny deterministic fixture before importing it, so the
// singleton opens the fixture rather than the real 22 MB artifact.
const FIXTURE = path.join(os.tmpdir(), `suggest-fixture-${process.pid}.db`);
let lib;

beforeAll(async () => {
  buildSuggestFixture(FIXTURE);
  process.env.SUGGEST_DB_PATH = FIXTURE;
  lib = await import('../../lib/semantic-index.js');
  await lib.initSemanticIndex();
});

afterAll(() => {
  fs.rmSync(FIXTURE, { force: true });
});

describe('semantic-index: suggestAlbums', () => {
  it('loads the fixture index', () => {
    const s = lib.semanticIndexStatus();
    expect(s.ready).toBe(true);
    expect(s.albums).toBe(4);
  });

  it('returns nearest albums in distance order, excluding the seed', () => {
    const r = lib.suggestAlbums({ title: 'Alpha', artist: 'Artist One' }, 10);
    expect(r.ok).toBe(true);
    expect(r.seed.album).toBe('Alpha');
    const albums = r.items.map((i) => i.album);
    expect(albums).not.toContain('Alpha');          // seed dropped
    expect(albums).toEqual(['Beta', 'Gamma', 'Delta']); // known ordering
    // distances strictly increasing
    const d = r.items.map((i) => i.distance);
    expect(d[0]).toBeLessThan(d[1]);
    expect(d[1]).toBeLessThan(d[2]);
  });

  it('resolves a seed by catalogue', () => {
    const r = lib.suggestAlbums({ cat: 'CAT-A' }, 5);
    expect(r.seed.album).toBe('Alpha');
    expect(r.items[0].album).toBe('Beta');
  });

  it('resolution is case/whitespace-insensitive', () => {
    const r = lib.suggestAlbums({ title: '  alpha ', artist: 'ARTIST ONE' }, 5);
    expect(r.seed.album).toBe('Alpha');
  });

  it('honours the limit', () => {
    const r = lib.suggestAlbums({ title: 'Alpha', artist: 'Artist One' }, 2);
    expect(r.items).toHaveLength(2);
  });

  it('returns an empty list for an unknown seed (no throw)', () => {
    const r = lib.suggestAlbums({ title: 'Nope', artist: 'Nobody' }, 5);
    expect(r.ok).toBe(true);
    expect(r.seed).toBeNull();
    expect(r.items).toEqual([]);
  });

  it('exposes a stable card shape', () => {
    const card = lib.suggestAlbums({ cat: 'CAT-A' }, 1).items[0];
    expect(card).toMatchObject({
      album: expect.any(String), artist: expect.any(String),
      year: expect.any(String), genre: expect.any(String),
      recordId: expect.any(String), distance: expect.any(Number)
    });
    expect(card).toHaveProperty('artworkSrc');
  });
});
