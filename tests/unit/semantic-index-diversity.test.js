// Guards the diversity caps in suggestAlbums: semantic similarity clusters an
// artist's own catalogue, so without a cap a single artist can fill the rail.
// Fixture: 4 albums by "Repeat Artist" + 4 distinct artists + 2 "Various Artists"
// compilations, all near the seed. Compilations share no artist so the per-artist
// cap never bites them — they get their own separate cap (default 1).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const DIM = 384;
const FIXTURE = path.join(os.tmpdir(), `suggest-diversity-${process.pid}.db`);
let lib;

function unitVec(spec) {
  const v = new Float32Array(DIM);
  for (const [i, w] of Object.entries(spec)) v[Number(i)] = w;
  let n = 0; for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1; for (let i = 0; i < DIM; i++) v[i] /= n;
  return Buffer.from(v.buffer);
}

beforeAll(async () => {
  const db = new Database(FIXTURE);
  sqliteVec.load(db);
  db.exec(`
    CREATE TABLE albums (id INTEGER PRIMARY KEY, albumKey TEXT NOT NULL UNIQUE, meta TEXT NOT NULL);
    CREATE VIRTUAL TABLE vec_albums USING vec0(embedding float[${DIM}]);
    CREATE TABLE index_info (key TEXT PRIMARY KEY, value TEXT);
  `);
  const insA = db.prepare('INSERT INTO albums (id, albumKey, meta) VALUES (?, ?, ?)');
  const insV = db.prepare('INSERT INTO vec_albums (rowid, embedding) VALUES (?, ?)');
  // Seed at axis 0. Repeat Artist albums sit closest; distinct artists slightly further;
  // two Various Artists compilations also close (must NOT be capped).
  const rows = [
    { key: 'seed',   artist: 'Seed Artist',   vec: { 0: 1.0 } },
    // Closest album of all is by the SEED's artist (as a billing variant) — the
    // rail must never echo the artist the visitor is already looking at.
    { key: 'seed2',  artist: 'Seed Artist & Friends', vec: { 0: 0.995, 1: 0.01 } },
    { key: 'rep1',   artist: 'Repeat Artist', vec: { 0: 0.99, 1: 0.02 } },
    // A billing variant of Repeat Artist — must count toward the same cap.
    { key: 'repvar', artist: 'Repeat Artist feat. Guest', vec: { 0: 0.985, 1: 0.025 } },
    { key: 'rep2',   artist: 'Repeat Artist', vec: { 0: 0.98, 1: 0.03 } },
    { key: 'rep3',   artist: 'Repeat Artist', vec: { 0: 0.97, 1: 0.04 } },
    { key: 'rep4',   artist: 'Repeat Artist', vec: { 0: 0.96, 1: 0.05 } },
    { key: 'comp1',  artist: 'Various Artists', vec: { 0: 0.95, 1: 0.06 } },
    { key: 'comp2',  artist: 'Various Artists', vec: { 0: 0.94, 1: 0.07 } },
    { key: 'other1', artist: 'Artist X', vec: { 0: 0.9, 1: 0.1 } },
    { key: 'other2', artist: 'Artist Y', vec: { 0: 0.85, 1: 0.15 } },
    { key: 'other3', artist: 'Artist Z', vec: { 0: 0.8, 1: 0.2 } }
  ];
  const tx = db.transaction(() => {
    rows.forEach((r, idx) => {
      const id = idx + 1;
      const meta = { album: r.key, artist: r.artist, catalogue: `CAT-${id}`, year: '1990', genre: 'Afro', recordId: String(id), artworkUrl: '' };
      insA.run(id, r.key, JSON.stringify(meta));
      insV.run(BigInt(id), unitVec(r.vec));
    });
  });
  tx();
  const info = db.prepare('INSERT INTO index_info (key, value) VALUES (?, ?)');
  info.run('model', 'test'); info.run('dim', String(DIM));
  db.close();

  process.env.SUGGEST_DB_PATH = FIXTURE;
  lib = await import('../../lib/semantic-index.js');
  await lib.initSemanticIndex();
});

afterAll(() => fs.rmSync(FIXTURE, { force: true }));

const countByArtist = (items, artist) => items.filter((i) => i.artist === artist).length;
// Fuzzy count: albums whose artist collapses to the same core identity.
const countByCore = (items, core) => items.filter((i) => lib.artistCoreKey(i.artist) === core).length;

describe('suggestAlbums per-artist diversity cap', () => {
  it('default cap = 1 limits a single artist to one album, billing variants included', () => {
    const r = lib.suggestAlbums({ cat: 'CAT-1' }, 8); // seed = the "seed" album
    expect(countByCore(r.items, 'repeat artist')).toBe(1);
    // The one slot goes to the CLOSEST of the family (rep1, exact name).
    expect(countByArtist(r.items, 'Repeat Artist')).toBe(1);
    expect(countByArtist(r.items, 'Repeat Artist feat. Guest')).toBe(0);
  });

  it('maxPerArtist: 2 shares the two slots across billing variants', () => {
    const r = lib.suggestAlbums({ cat: 'CAT-1' }, 10, { maxPerArtist: 2 });
    expect(countByCore(r.items, 'repeat artist')).toBe(2);
  });

  it('cap = 1 allows only one album per artist', () => {
    const r = lib.suggestAlbums({ cat: 'CAT-1' }, 8, { maxPerArtist: 1 });
    expect(countByArtist(r.items, 'Repeat Artist')).toBe(1);
  });

  it("never suggests the seed's own artist — even as a billing variant", () => {
    // seed2 ("Seed Artist & Friends") is the closest album in the whole index;
    // without the exclusion it would be the #1 suggestion.
    const r = lib.suggestAlbums({ cat: 'CAT-1' }, 10);
    expect(r.items.map((i) => i.album)).not.toContain('seed2');
    expect(countByCore(r.items, 'seed artist')).toBe(0);
  });

  it('default cap allows only one Various Artists compilation', () => {
    const r = lib.suggestAlbums({ cat: 'CAT-1' }, 8, { maxPerArtist: 1 });
    expect(countByArtist(r.items, 'Various Artists')).toBe(1);
  });

  it('maxCompilations is tunable per call', () => {
    const r = lib.suggestAlbums({ cat: 'CAT-1' }, 8, { maxPerArtist: 1, maxCompilations: 2 });
    expect(countByArtist(r.items, 'Various Artists')).toBe(2);
  });

  it('maxCompilations: 0 excludes compilations entirely', () => {
    const r = lib.suggestAlbums({ cat: 'CAT-1' }, 8, { maxPerArtist: 1, maxCompilations: 0 });
    expect(countByArtist(r.items, 'Various Artists')).toBe(0);
  });

  it('still returns distinct-artist albums to fill the page', () => {
    const r = lib.suggestAlbums({ cat: 'CAT-1' }, 8, { maxPerArtist: 1 });
    const artists = new Set(r.items.map((i) => i.artist));
    expect(artists.size).toBeGreaterThanOrEqual(5);
  });
});

describe('suggestAlbums shuffle (fresh set each visit)', () => {
  it('still honours the caps when shuffling', () => {
    for (let i = 0; i < 20; i++) {
      const r = lib.suggestAlbums({ cat: 'CAT-1' }, 8, { shuffle: true });
      expect(countByArtist(r.items, 'Repeat Artist')).toBeLessThanOrEqual(2);
      expect(countByArtist(r.items, 'Various Artists')).toBeLessThanOrEqual(1);
    }
  });

  it('varies the selection across repeated calls', () => {
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const r = lib.suggestAlbums({ cat: 'CAT-1' }, 5, { shuffle: true });
      seen.add(r.items.map((x) => x.album).join(','));
    }
    expect(seen.size).toBeGreaterThan(1); // not frozen to one fixed ordering
  });

  it('is deterministic when shuffle is off (default)', () => {
    const a = lib.suggestAlbums({ cat: 'CAT-1' }, 5).items.map((x) => x.album);
    const b = lib.suggestAlbums({ cat: 'CAT-1' }, 5).items.map((x) => x.album);
    expect(a).toEqual(b);
  });

  it('keeps the top matches (lock) fixed while shuffling the rest', () => {
    const heads = new Set();
    for (let i = 0; i < 15; i++) {
      const albums = lib.suggestAlbums({ cat: 'CAT-1' }, 6, { shuffle: true }).items.map((x) => x.album);
      heads.add(albums.slice(0, 3).join(',')); // default SHUFFLE_LOCK = 3
    }
    expect(heads.size).toBe(1); // closest 3 never change — variety doesn't cost relevance
  });
});
