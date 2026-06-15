// Guards cover-preference: a recommendations rail full of placeholders reads as
// broken, so suggestAlbums surfaces albums that HAVE a usable cover first and
// only tops up with art-less albums to fill the page. Also checks that blank
// "/artwork/.jpg" URLs yield no artworkSrc (card falls back to placeholder).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const DIM = 384;
const FIXTURE = path.join(os.tmpdir(), `suggest-artwork-${process.pid}.db`);
let lib;

function unitVec(spec) {
  const v = new Float32Array(DIM);
  for (const [i, w] of Object.entries(spec)) v[Number(i)] = w;
  let n = 0; for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1; for (let i = 0; i < DIM; i++) v[i] /= n;
  return Buffer.from(v.buffer);
}

const ART = 'https://s3.example.com/artwork/resized/COVER_300.webp';
const BLANK = 'https://s3.example.com/artwork/.jpg'; // empty filename → unusable

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
  // Seed at axis 0. The two CLOSEST neighbours have no cover; the next two have
  // covers. With cover-preference, the covered (farther) albums should win the
  // first slots over the closer art-less ones.
  const rows = [
    { key: 'seed',     artist: 'Seed',  art: ART,   vec: { 0: 1.0 } },
    { key: 'closeNo1', artist: 'A',     art: BLANK, vec: { 0: 0.99, 1: 0.02 } },
    { key: 'closeNo2', artist: 'B',     art: '',    vec: { 0: 0.98, 1: 0.03 } },
    { key: 'farYes1',  artist: 'C',     art: ART,   vec: { 0: 0.90, 1: 0.10 } },
    { key: 'farYes2',  artist: 'D',     art: ART,   vec: { 0: 0.85, 1: 0.15 } }
  ];
  const tx = db.transaction(() => {
    rows.forEach((r, idx) => {
      const id = idx + 1;
      const meta = { album: r.key, artist: r.artist, catalogue: `CAT-${id}`, recordId: String(id), artworkUrl: r.art };
      insA.run(id, r.key, JSON.stringify(meta));
      insV.run(BigInt(id), unitVec(r.vec));
    });
  });
  tx();
  db.prepare('INSERT INTO index_info (key, value) VALUES (?, ?)').run('dim', String(DIM));
  db.close();

  process.env.SUGGEST_DB_PATH = FIXTURE;
  lib = await import('../../lib/semantic-index.js');
  await lib.initSemanticIndex();
});

afterAll(() => fs.rmSync(FIXTURE, { force: true }));

describe('suggestAlbums cover-preference', () => {
  it('blank "/artwork/.jpg" produces no artworkSrc', () => {
    const r = lib.suggestAlbums({ cat: 'CAT-1' }, 10);
    const closeNo1 = r.items.find((i) => i.album === 'closeNo1');
    expect(closeNo1.artworkSrc).toBe('');
  });

  it('cover-having albums fill the first slots over closer art-less ones', () => {
    const r = lib.suggestAlbums({ cat: 'CAT-1' }, 2); // seed = album 1
    expect(r.items.map((i) => i.album)).toEqual(['farYes1', 'farYes2']);
    expect(r.items.every((i) => i.artworkSrc)).toBe(true);
  });

  it('still returns art-less albums to fill when covers run out', () => {
    const r = lib.suggestAlbums({ cat: 'CAT-1' }, 4);
    expect(r.items).toHaveLength(4); // 2 covered + 2 art-less
    expect(r.items.filter((i) => !i.artworkSrc).length).toBe(2);
  });
});
