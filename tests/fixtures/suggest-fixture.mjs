/**
 * tests/fixtures/suggest-fixture.mjs — build a tiny deterministic suggest.db.
 *
 * Four albums with hand-crafted unit vectors whose nearest-neighbour ordering
 * is known, so the semantic-index lib can be tested without the 22 MB real
 * artifact. Schema matches scripts/semantic/build-suggest.mjs exactly.
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const DIM = 384;

// Build a normalised float[384] from { axisIndex: weight } spec.
function vecFrom(spec) {
  const v = new Float32Array(DIM);
  for (const [i, w] of Object.entries(spec)) v[Number(i)] = w;
  let n = 0;
  for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}

// Ordering by closeness to ALPHA (axis 0): BETA (0.95,0.1) > GAMMA (0.6,0.8) > DELTA (axis 5).
const ALBUMS = [
  { album: 'Alpha', artist: 'Artist One',   cat: 'CAT-A', vec: { 0: 1.0 } },
  { album: 'Beta',  artist: 'Artist Two',   cat: 'CAT-B', vec: { 0: 0.95, 1: 0.1 } },
  { album: 'Gamma', artist: 'Artist Three', cat: 'CAT-C', vec: { 0: 0.6, 1: 0.8 } },
  { album: 'Delta', artist: 'Artist Four',  cat: 'CAT-D', vec: { 5: 1.0 } }
];

const norm = (s) => String(s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');

export function buildSuggestFixture(dbPath) {
  fs.rmSync(dbPath, { force: true });
  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.exec(`
    CREATE TABLE albums (id INTEGER PRIMARY KEY, albumKey TEXT NOT NULL UNIQUE, meta TEXT NOT NULL);
    CREATE VIRTUAL TABLE vec_albums USING vec0(embedding float[${DIM}]);
    CREATE TABLE index_info (key TEXT PRIMARY KEY, value TEXT);
  `);
  const insA = db.prepare('INSERT INTO albums (id, albumKey, meta) VALUES (?, ?, ?)');
  const insV = db.prepare('INSERT INTO vec_albums (rowid, embedding) VALUES (?, ?)');
  ALBUMS.forEach((a, idx) => {
    const id = idx + 1;
    const key = `${norm(a.album)}|||${norm(a.artist)}`;
    const meta = {
      album: a.album, artist: a.artist, year: '1990', genre: 'Afro', localGenre: 'Afro Folk',
      language: 'zu', mood: 'Happy', recordId: String(id * 10), artworkUrl: '', catalogue: a.cat, trackCount: 8
    };
    insA.run(id, key, JSON.stringify(meta));
    insV.run(BigInt(id), Buffer.from(vecFrom(a.vec).buffer));
  });
  const info = db.prepare('INSERT INTO index_info (key, value) VALUES (?, ?)');
  info.run('model', 'test-fixture');
  info.run('dim', String(DIM));
  info.run('albums', String(ALBUMS.length));
  info.run('sourceBuiltAt', '2026-06-15T00:00:00.000Z');
  db.close();
  return dbPath;
}
