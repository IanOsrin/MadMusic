/**
 * lib/semantic-shelves.js — zero-cost natural-language catalogue search.
 *
 * Serves queries against the phase-1 semantic index (data/semantic.db,
 * sqlite-vec) built by scripts/semantic/build-index.mjs. The query is
 * embedded IN-PROCESS with the same local model used at index time
 * (Xenova/multilingual-e5-small via transformers.js) — no external AI
 * service, no per-query cost. First query lazy-loads the model (~a few
 * seconds); after that lookups run in tens of milliseconds.
 *
 * Returns null when the index file is absent so callers can treat the
 * whole feature as unavailable rather than erroring.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.SEMANTIC_DB_PATH
  || path.join(__dirname, '..', 'data', 'semantic.db');

let _ready = null; // memoized {db, embed, model} or null when unavailable

// On hosts without the index on disk (Render's ephemeral filesystem), fetch
// it once at first use from SEMANTIC_DB_URL (the S3 copy). ~140 MB from
// same-region S3 lands in seconds; downloads to a temp name then renames so
// a half-written file never gets opened.
async function ensureIndexFile() {
  if (fs.existsSync(DB_PATH)) return true;
  const url = (process.env.SEMANTIC_DB_URL || '').trim();
  if (!url) return false;
  try {
    console.log(`[semantic-shelves] downloading index from ${url} …`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const tmp = `${DB_PATH}.downloading`;
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, DB_PATH);
    console.log(`[semantic-shelves] index downloaded (${(buf.length / 1048576).toFixed(0)} MB)`);
    return true;
  } catch (err) {
    console.error(`[semantic-shelves] index download failed: ${err.message}`);
    return false;
  }
}

async function load() {
  if (_ready !== null) return _ready;
  if (!(await ensureIndexFile())) { _ready = false; return false; }
  // Dynamic imports keep boot fast and make these deps optional at runtime.
  const [{ default: Database }, sqliteVec, { pipeline }] = await Promise.all([
    import('better-sqlite3'),
    import('sqlite-vec'),
    import('@huggingface/transformers'),
  ]);
  const db = new Database(DB_PATH, { readonly: true });
  sqliteVec.load(db);
  const info = Object.fromEntries(
    db.prepare('SELECT key, value FROM index_info').all().map((r) => [r.key, r.value])
  );
  const embed = await pipeline('feature-extraction', info.model, { dtype: 'q8' });
  console.log(`[semantic-shelves] index ready: ${info.tracks} tracks (built ${info.builtAt}), model ${info.model}`);
  _ready = { db, embed };
  return _ready;
}

export function semanticShelvesAvailable() {
  return fs.existsSync(DB_PATH);
}

/**
 * Natural-language search over the catalogue.
 * @returns array of {recordId, title, artist, album, year, genre, mood,
 *          artworkUrl, distance} ordered by similarity, or null if the
 *          index is unavailable.
 */
export async function searchShelves(query, k = 10) {
  const ctx = await load();
  if (!ctx) return null;
  const q = String(query || '').trim().slice(0, 300);
  if (!q) return [];

  const out = await ctx.embed([`query: ${q}`], { pooling: 'mean', normalize: true });
  const qvec = Buffer.from(new Float32Array(out.tolist()[0]).buffer);

  const rows = ctx.db.prepare(`
    SELECT t.recordId, t.meta, v.distance
    FROM vec_tracks v
    JOIN tracks t ON t.id = v.rowid
    WHERE v.embedding MATCH ? AND k = ?
    ORDER BY v.distance
  `).all(qvec, k);

  return rows.map((r) => {
    const m = JSON.parse(r.meta);
    return {
      recordId: String(r.recordId),
      title: m.track || '',
      artist: m.artist || m.albumArtist || '',
      album: m.album || '',
      year: m.year || '',
      genre: m.genre || m.localGenre || '',
      mood: m.mood || '',
      artworkUrl: m.artworkUrl || '',
      distance: r.distance,
    };
  }).filter((t) => t.title && t.artist);
}
