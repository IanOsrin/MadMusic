/**
 * scripts/semantic/build-suggest.mjs — derive the slim "Similar albums" index.
 *
 * Reads the per-track vectors already computed in data/semantic.db, collapses
 * them to one centroid per ALBUM, and writes a small data/suggest.db that the
 * live app loads at boot for item-to-item album suggestions.
 *
 * This is pure derivation — NO embedding model, NO FileMaker. It runs in
 * seconds and is safe to re-run after every full `build-index.mjs` rebuild.
 *
 *   node scripts/semantic/build-suggest.mjs
 *
 * Album identity = CATALOGUE NUMBER (one per physical release). This is the
 * correct album key for this catalogue: grouping by track-artist splits a
 * compilation into one entry per performer (CLAUDE invariant #1), and grouping
 * by title+artist text fragments on spelling/punctuation variants. A catalogue
 * that spans multiple album-artists is a compilation → displayed as
 * "Various Artists". Falls back to title|||albumArtist only when a track has no
 * catalogue number.
 *
 * Field sources (prefer the index meta; backfill from write-source.json for
 * older semantic.db builds that predate albumArtist/catalogue/artworkUrl in
 * track meta):
 *   - catalogue / albumTitle / albumArtist  ← meta.catalogue/album/albumArtist
 *                                              else data/write-source.json by recordId
 *   - year/genre/language/mood/artworkUrl   ← meta (semantic.db)
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { thumbArtworkUrl } from '../../lib/track.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
// Paths are env-overridable so tests can run the real derivation on a fixture.
const SRC_PATH = process.env.SUGGEST_SRC_DB || path.join(ROOT, 'data', 'semantic.db');
const OUT_PATH = process.env.SUGGEST_OUT_DB || path.join(ROOT, 'data', 'suggest.db');
const WRITE_SOURCE_PATH = process.env.SUGGEST_WRITE_SOURCE || path.join(ROOT, 'data', 'write-source.json');

const VEC_DIM = 384;

if (!fs.existsSync(SRC_PATH)) {
  console.error(`[suggest] source index not found: ${SRC_PATH}\n  build it first: node scripts/semantic/build-index.mjs`);
  process.exit(1);
}

const norm = (s) => String(s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');

// ── Musical-feature helpers (album-level, for the re-rank in semantic-index) ──
const PITCH = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6,
  G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11
};
// Essentia AI_Key ("A minor" / "F# major" / "Bb minor") → Camelot { num 1-12, major }.
// Camelot follows the circle of fifths: C major = 8B, A minor = 8A, etc.
function parseCamelot(s) {
  const m = String(s ?? '').trim().match(/^([A-Ga-g])([#b]?)\s+(major|minor)$/);
  if (!m) return null;
  const pc = PITCH[m[1].toUpperCase() + (m[2] || '')];
  if (pc == null) return null;
  const major = /major/i.test(m[3]);
  // major number from circle-of-fifths index; minor uses its relative-major pc.
  const cof = (rootPc) => (rootPc * 7) % 12;
  const num = major
    ? ((cof(pc) + 7) % 12) + 1
    : ((cof((pc + 3) % 12) + 7) % 12) + 1;
  return { num, major };
}
const numOrNull = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const median = (arr) => {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  const i = a.length >> 1;
  return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
};
const mean = (arr) => (arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : null);

// ── Backfill map (recordId → {catalogue, albumTitle, albumArtist}) ──────────
const wsByRec = new Map();
if (fs.existsSync(WRITE_SOURCE_PATH)) {
  try {
    const rows = JSON.parse(fs.readFileSync(WRITE_SOURCE_PATH, 'utf8'));
    for (const r of Array.isArray(rows) ? rows : []) {
      if (r?.recordId) {
        wsByRec.set(String(r.recordId), {
          catalogue: String(r.catalogue ?? '').trim(),
          albumTitle: String(r.albumTitle ?? '').trim(),
          albumArtist: String(r.albumArtist ?? '').trim()
        });
      }
    }
    console.log(`[suggest] backfill source: ${wsByRec.size} recordIds from write-source.json`);
  } catch (err) {
    console.warn(`[suggest] could not read write-source.json (backfill skipped): ${err.message}`);
  }
}

// ── Read source index ───────────────────────────────────────────────────────
const t0 = Date.now();
const src = new Database(SRC_PATH, { readonly: true });
sqliteVec.load(src);
const info = Object.fromEntries(src.prepare('SELECT key, value FROM index_info').all().map((r) => [r.key, r.value]));
const model = info.model || 'unknown';
const dim = Number(info.dim) || VEC_DIM;
if (dim !== VEC_DIM) {
  console.error(`[suggest] index dim ${dim} != expected ${VEC_DIM} — aborting`);
  process.exit(1);
}
console.log(`[suggest] source: ${info.tracks} tracks, model ${model}, built ${info.builtAt}`);

// Accumulate per-album: groupKey → centroid sum + facets + artist/title tallies.
const acc = new Map();
const tallyInc = (map, k) => { if (k) map.set(k, (map.get(k) || 0) + 1); };
const tallyTop = (map) => {
  let best = '', n = -1;
  for (const [k, c] of map) if (c > n) { best = k; n = c; }
  return best;
};

const rowIter = src.prepare(`
  SELECT t.recordId AS recordId, t.meta AS meta, v.embedding AS embedding
  FROM tracks t JOIN vec_tracks v ON v.rowid = t.id
  ORDER BY t.id
`).iterate();

let scanned = 0;
for (const row of rowIter) {
  scanned++;
  const m = JSON.parse(row.meta);
  const ws = wsByRec.get(String(row.recordId)) || {};

  const catalogue = (m.catalogue || ws.catalogue || '').trim();
  const albumTitle = (m.album || ws.albumTitle || '').trim();
  const albumArtist = (m.albumArtist || ws.albumArtist || '').trim();

  // Album identity: catalogue number; fall back to title|||albumArtist.
  const groupKey = norm(catalogue) || `t:${norm(albumTitle)}|||${norm(albumArtist)}`;
  if (!groupKey || groupKey === 't:|||') continue;

  const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, dim);
  let entry = acc.get(groupKey);
  if (!entry) {
    entry = {
      sum: new Float64Array(dim),
      count: 0,
      catalogue,                         // original (un-normalised) representative
      titles: new Map(),                 // albumTitle → count
      artists: new Map(),                // albumArtist → count
      facets: { year: m.year || '', genre: m.genre || '', localGenre: m.localGenre || '', language: m.language || '', mood: m.mood || '' },
      recordId: String(row.recordId || ''),
      artworkUrl: m.artworkUrl || '',
      // Musical features, accumulated only from ANALYSED tracks (valid AI_BPM).
      bpms: [],
      keys: new Map(),   // Camelot code → count
      energies: []
    };
    acc.set(groupKey, entry);
  }
  for (let i = 0; i < dim; i++) entry.sum[i] += vec[i];
  entry.count++;
  tallyInc(entry.titles, albumTitle);
  tallyInc(entry.artists, albumArtist);
  // Musical features: only from analysed tracks (AI_BPM is a positive number; the
  // analyzer writes -1/empty for un-analysable/pending). Key + energy ride along.
  const bpm = numOrNull(m.bpm);
  if (bpm != null && bpm > 0) {
    entry.bpms.push(bpm);
    const en = numOrNull(m.energy);
    if (en != null) entry.energies.push(en);
    const cam = parseCamelot(m.key);
    if (cam) tallyInc(entry.keys, `${cam.num}${cam.major ? 'B' : 'A'}`);
  }
  // First track that carries facets / artwork wins as representative.
  if (!entry.facets.year && m.year) entry.facets.year = m.year;
  if (!entry.facets.genre && m.genre) entry.facets.genre = m.genre;
  if (!entry.facets.localGenre && m.localGenre) entry.facets.localGenre = m.localGenre;
  if (!entry.facets.language && m.language) entry.facets.language = m.language;
  if (!entry.facets.mood && m.mood) entry.facets.mood = m.mood;
  if (!entry.artworkUrl && m.artworkUrl) { entry.artworkUrl = m.artworkUrl; entry.recordId = String(row.recordId || entry.recordId); }
}
src.close();
console.log(`[suggest] collapsed ${scanned} tracks → ${acc.size} albums by catalogue (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

if (!acc.size) {
  console.error('[suggest] no albums derived — nothing to write');
  process.exit(1);
}

// ── Write slim index ────────────────────────────────────────────────────────
fs.rmSync(OUT_PATH, { force: true });
const out = new Database(OUT_PATH);
sqliteVec.load(out);
out.exec(`
  CREATE TABLE albums (
    id INTEGER PRIMARY KEY,
    albumKey TEXT NOT NULL UNIQUE,
    meta TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE vec_albums USING vec0(embedding float[${VEC_DIM}]);
  CREATE TABLE index_info (key TEXT PRIMARY KEY, value TEXT);
`);

const insAlbum = out.prepare('INSERT INTO albums (id, albumKey, meta) VALUES (?, ?, ?)');
const insVec = out.prepare('INSERT INTO vec_albums (rowid, embedding) VALUES (?, ?)');

let id = 0, withArt = 0, withCat = 0, compilations = 0;
const tx = out.transaction(() => {
  for (const [key, entry] of acc) {
    id++;
    const cen = new Float32Array(dim);
    let nrm = 0;
    for (let i = 0; i < dim; i++) { const v = entry.sum[i] / entry.count; cen[i] = v; nrm += v * v; }
    nrm = Math.sqrt(nrm) || 1;
    for (let i = 0; i < dim; i++) cen[i] /= nrm;

    const distinctArtists = [...entry.artists.keys()].filter(Boolean);
    const isCompilation = distinctArtists.length > 1;
    if (isCompilation) compilations++;
    const albumArtist = isCompilation ? 'Various Artists' : (distinctArtists[0] || tallyTop(entry.artists) || '');
    const albumTitle = tallyTop(entry.titles) || '';

    // Album musical features (empty/null when no track was analysed).
    const medBpm = median(entry.bpms);
    const avgEnergy = mean(entry.energies);
    const domKey = tallyTop(entry.keys);            // "8A" / "8B" / ''
    const keyNum = domKey ? parseInt(domKey, 10) : null;
    const keyMajor = domKey ? domKey.endsWith('B') : null;

    const meta = {
      album: albumTitle,
      artist: albumArtist,
      year: entry.facets.year,
      genre: entry.facets.genre,
      localGenre: entry.facets.localGenre,
      language: entry.facets.language,
      mood: entry.facets.mood,
      // Musical features for the album-level re-rank (semantic-index.js).
      bpm: medBpm != null ? Math.round(medBpm) : null,
      energy: avgEnergy != null ? Math.round(avgEnergy) : null,
      key: domKey || '',          // display Camelot code
      keyNum,                     // 1-12, or null
      keyMajor,                   // true = major (B), false = minor (A), or null
      analysedTracks: entry.bpms.length,
      recordId: entry.recordId,
      // Store the ready-to-serve _300 derivative (no runtime rewrite). Empty for
      // the current index (predates artwork capture) → run enrich-artwork.mjs.
      artworkUrl: entry.artworkUrl ? thumbArtworkUrl(entry.artworkUrl, 300) : '',
      catalogue: entry.catalogue,
      trackCount: entry.count
    };
    if (entry.artworkUrl) withArt++;
    if (entry.catalogue) withCat++;

    insAlbum.run(id, key, JSON.stringify(meta));
    insVec.run(BigInt(id), Buffer.from(cen.buffer));
  }
});
tx();

const setInfo = out.prepare('INSERT INTO index_info (key, value) VALUES (?, ?)');
setInfo.run('model', model);
setInfo.run('dim', String(VEC_DIM));
setInfo.run('albums', String(id));
setInfo.run('albumKey', 'catalogue');
setInfo.run('sourceTracks', String(info.tracks || scanned));
setInfo.run('sourceBuiltAt', String(info.builtAt || ''));
out.close();

const mb = (fs.statSync(OUT_PATH).size / 1024 / 1024).toFixed(1);
console.log(`[suggest] DONE: ${id} albums → ${OUT_PATH} (${mb} MB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`[suggest]   compilations (Various Artists): ${compilations}  |  artwork: ${withArt}/${id}  |  catalogue: ${withCat}/${id}`);
if (withArt === 0) {
  console.log('[suggest]   note: 0 albums have artwork — this index predates artworkUrl capture.');
  console.log('[suggest]   re-run build-index.mjs (updated buildMeta) then build-suggest.mjs to populate it.');
}
