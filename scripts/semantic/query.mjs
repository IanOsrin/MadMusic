/**
 * scripts/semantic/query.mjs — test harness for the semantic index.
 *
 * Usage: node scripts/semantic/query.mjs "upbeat zulu music from the early 90s"
 * Embeds the query with the SAME model as the index and prints the top matches.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { pipeline } from '@huggingface/transformers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'semantic.db');

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  console.error('usage: node scripts/semantic/query.mjs "<query text>"');
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });
sqliteVec.load(db);
const info = Object.fromEntries(db.prepare('SELECT key, value FROM index_info').all().map((r) => [r.key, r.value]));

const embed = await pipeline('feature-extraction', info.model, { dtype: 'q8' });
const out = await embed([`query: ${query}`], { pooling: 'mean', normalize: true });
const qvec = Buffer.from(new Float32Array(out.tolist()[0]).buffer);

const t0 = Date.now();
const hits = db.prepare(`
  SELECT t.recordId, t.meta, v.distance
  FROM vec_tracks v
  JOIN tracks t ON t.id = v.rowid
  WHERE v.embedding MATCH ? AND k = 10
  ORDER BY v.distance
`).all(qvec);
const ms = Date.now() - t0;

console.log(`\nindex: ${info.tracks} tracks (built ${info.builtAt})  |  query "${query}"  |  search ${ms}ms\n`);
for (const [i, h] of hits.entries()) {
  const m = JSON.parse(h.meta);
  const bits = [
    m.year, m.genre, m.localGenre && m.localGenre !== m.genre ? m.localGenre : null,
    m.language, m.mood, m.energy ? `energy ${Math.round(m.energy)}` : null
  ].filter(Boolean).join(' · ');
  console.log(`${String(i + 1).padStart(2)}. ${m.track} — ${m.artist}  [${m.album}]`);
  console.log(`     ${bits}  (dist ${h.distance.toFixed(3)}, recordId ${h.recordId})`);
}
db.close();
