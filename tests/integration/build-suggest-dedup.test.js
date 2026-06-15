// Regression test for the album-dedup bug: build-suggest.mjs must group album
// centroids by CATALOGUE NUMBER, not track artist. Grouping by track artist
// split compilations into one entry per performer (CLAUDE invariant #1) and
// inflated the album count. Here we build a tiny track-level semantic.db
// fixture (a normal 2-track album + a 2-track compilation under one catalogue
// with two different album artists) and run the real derivation script.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const execFileP = promisify(execFile);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIM = 384;

const tmp = path.join(os.tmpdir(), `suggest-dedup-${process.pid}`);
const SRC = `${tmp}-src.db`;
const OUT = `${tmp}-out.db`;

function vec(seed) { // deterministic non-degenerate unit vector
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.sin(seed * (i + 1));
  let n = 0; for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1; for (let i = 0; i < DIM; i++) v[i] /= n;
  return Buffer.from(v.buffer);
}

beforeAll(async () => {
  // Build a track-level semantic.db fixture with album-artist + catalogue in meta.
  const db = new Database(SRC);
  sqliteVec.load(db);
  db.exec(`
    CREATE TABLE tracks (id INTEGER PRIMARY KEY, recordId TEXT NOT NULL UNIQUE, doc TEXT NOT NULL, meta TEXT NOT NULL);
    CREATE VIRTUAL TABLE vec_tracks USING vec0(embedding float[${DIM}]);
    CREATE TABLE index_info (key TEXT PRIMARY KEY, value TEXT);
  `);
  const insT = db.prepare('INSERT INTO tracks (id, recordId, doc, meta) VALUES (?, ?, ?, ?)');
  const insV = db.prepare('INSERT INTO vec_tracks (rowid, embedding) VALUES (?, ?)');
  const rows = [
    // Normal album — one catalogue, one album artist, 2 tracks
    { id: 1, rec: '101', meta: { album: 'Solo Album', albumArtist: 'Real Artist', artist: 'Real Artist', catalogue: 'CAT-1', year: '1990', genre: 'Afro' } },
    { id: 2, rec: '102', meta: { album: 'Solo Album', albumArtist: 'Real Artist', artist: 'Real Artist', catalogue: 'CAT-1', year: '1990', genre: 'Afro' } },
    // Compilation — ONE catalogue, TWO different album artists (must collapse to 1 album = Various Artists)
    { id: 3, rec: '201', meta: { album: 'Comp Album', albumArtist: 'Artist A', artist: 'Performer A', catalogue: 'CAT-2', year: '1985', genre: 'Pop' } },
    { id: 4, rec: '202', meta: { album: 'Comp Album', albumArtist: 'Artist B', artist: 'Performer B', catalogue: 'CAT-2', year: '1985', genre: 'Pop' } }
  ];
  const tx = db.transaction(() => {
    for (const r of rows) { insT.run(r.id, r.rec, 'doc', JSON.stringify(r.meta)); insV.run(BigInt(r.id), vec(r.id)); }
  });
  tx();
  db.prepare('INSERT INTO index_info (key, value) VALUES (?, ?)').run('model', 'test');
  db.prepare('INSERT INTO index_info (key, value) VALUES (?, ?)').run('dim', String(DIM));
  db.prepare('INSERT INTO index_info (key, value) VALUES (?, ?)').run('tracks', String(rows.length));
  db.close();

  await execFileP('node', ['scripts/semantic/build-suggest.mjs'], {
    cwd: root,
    env: { ...process.env, SUGGEST_SRC_DB: SRC, SUGGEST_OUT_DB: OUT, SUGGEST_WRITE_SOURCE: '/nonexistent.json' }
  });
});

afterAll(() => {
  for (const f of [SRC, OUT]) fs.rmSync(f, { force: true });
});

describe('build-suggest dedup (group by catalogue, not track artist)', () => {
  it('collapses 4 tracks across 2 catalogues into exactly 2 albums', () => {
    const db = new Database(OUT, { readonly: true });
    const n = db.prepare('SELECT COUNT(*) c FROM albums').get().c;
    db.close();
    expect(n).toBe(2); // NOT 4 (would be 4 if keyed on track artist)
  });

  it('labels the multi-artist catalogue as "Various Artists"', () => {
    const db = new Database(OUT, { readonly: true });
    const metas = db.prepare('SELECT meta FROM albums').all().map((r) => JSON.parse(r.meta));
    db.close();
    const comp = metas.find((m) => m.catalogue === 'CAT-2');
    const solo = metas.find((m) => m.catalogue === 'CAT-1');
    expect(comp.artist).toBe('Various Artists');
    expect(comp.trackCount).toBe(2);
    expect(solo.artist).toBe('Real Artist'); // single-artist album keeps its album artist
  });
});
