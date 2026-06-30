/**
 * scripts/semantic/build-index.mjs — Phase-1 semantic search ingest.
 *
 * Reads the track catalogue from the LOCAL FileMaker snapshot (mad-ingest-worker
 * on the M1 mini — never fmcloud), composes a one-paragraph "track document"
 * per visible+playable track, embeds it locally with a small multilingual
 * model (no external AI service — the model runs in-process on this machine),
 * and writes vectors + metadata to data/semantic.db (sqlite-vec).
 *
 * Privacy: catalogue text never leaves this machine. The only network calls
 * are to the local FM server and (first run only) downloading the open-source
 * model weights from Hugging Face.
 *
 * Usage:
 *   node scripts/semantic/build-index.mjs              # full catalogue
 *   node scripts/semantic/build-index.mjs --limit 1500 # sample run
 *
 * Env (in .env): INGEST_FM_HOST, INGEST_FM_DB, INGEST_FM_USER, INGEST_FM_PASS
 */

import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { pipeline } from '@huggingface/transformers';
import { hasValidAudio } from '../../lib/track.js';
import { isPgEnabled, query as pgQuery, closePgPool } from '../../lib/pg.js';

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

// Visibility is enforced explicitly here rather than via lib/fm-fields'
// recordIsVisible(), which silently passes everything when FM_VISIBILITY_FIELD
// is unset in the local env. Semantics match the production intent
// (FM_VISIBILITY_VALUE=show): empty or "show" → visible; anything else
// ("Hide") → excluded from the index.
function isVisible(f) {
  const raw = f['Visibility'] ?? f['Tape Files::Visibility'] ?? '';
  const v = String(raw).trim().toLowerCase();
  return !v || v === 'show';
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.SEMANTIC_DB_PATH || path.join(__dirname, '..', '..', 'data', 'semantic.db');

// Data source: fmcloud (FM_*, the live DB) by default so the index reflects
// daily edits without a snapshot-sync step. Embedding still runs LOCALLY below
// (no external AI). Override with SUGGEST_FM_* to point at a snapshot/copy
// (e.g. the M1 mad-ingest-worker) instead.
const HOST = process.env.SUGGEST_FM_HOST || process.env.FM_HOST;
const FMDB = process.env.SUGGEST_FM_DB   || process.env.FM_DB;
const USER = process.env.SUGGEST_FM_USER || process.env.FM_USER;
const PASS = process.env.SUGGEST_FM_PASS || process.env.FM_PASS;
const LAYOUT = 'API_Album_Songs';

// Must match the query-time model in the app exactly — see docs/semantic-search-proposal.md §8.
const MODEL_ID = 'Xenova/multilingual-e5-small';
const VEC_DIM = 384;
const EMBED_BATCH = 32;

const argLimit = (() => {
  const i = process.argv.indexOf('--limit');
  return i > -1 ? Number(process.argv[i + 1]) : Infinity;
})();

// ── FM Data API (plain fetch — the app's fm-client is wired to prod env vars) ──

async function fmLogin() {
  const auth = Buffer.from(`${USER}:${PASS}`).toString('base64');
  const r = await fetch(`${HOST}/fmi/data/vLatest/databases/${FMDB}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: '{}'
  }).then((x) => x.json());
  if (!r.response?.token) throw new Error(`FM login failed: ${JSON.stringify(r.messages)}`);
  return r.response.token;
}

async function fmLogout(token) {
  await fetch(`${HOST}/fmi/data/vLatest/databases/${FMDB}/sessions/${token}`, { method: 'DELETE' }).catch(() => {});
}

async function fmPage(token, offset, limit) {
  const r = await fetch(
    `${HOST}/fmi/data/vLatest/databases/${FMDB}/layouts/${LAYOUT}/records?_offset=${offset}&_limit=${limit}`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).then((x) => x.json());
  if (!r.response?.data) {
    // 401 = no records match; 101 = offset past the last record — both mean "end of data"
    const code = r.messages?.[0]?.code;
    if (code === '401' || code === '101') return [];
    throw new Error(`FM page failed at offset ${offset}: ${JSON.stringify(r.messages)}`);
  }
  return r.response.data;
}

// ── Track document composition ────────────────────────────────────────────────

const LANG_NAMES = {
  zu: 'Zulu', xh: 'Xhosa', st: 'Sesotho', tn: 'Setswana', ts: 'Tsonga',
  ve: 'Venda', nr: 'Ndebele', ss: 'Swati', af: 'Afrikaans', en: 'English',
  nso: 'Sepedi', sn: 'Shona'
};

function decadeText(year) {
  const y = Number(year);
  if (!y || y < 1900) return '';
  const decade = Math.floor(y / 10) * 10;
  const part = y % 10 <= 3 ? 'early' : y % 10 >= 7 ? 'late' : 'mid';
  return `${part} ${decade}s`;
}

function energyText(energy) {
  const e = Number(energy);
  if (!Number.isFinite(e)) return '';
  if (e >= 75) return 'high-energy';
  if (e >= 50) return 'upbeat';
  if (e >= 30) return 'laid-back';
  return 'mellow';
}

const val = (f, k) => String(f[k] ?? '').trim();

function buildDoc(f) {
  const parts = [];
  const track = val(f, 'Track Name');
  const artist = val(f, 'Track Artist') || val(f, 'Album Artist');
  const album = val(f, 'Album Title') || val(f, 'Tape Files::Album Title');
  const year = val(f, 'Year of Release');
  parts.push(`${track} — ${artist}.`);
  if (album && album !== track) parts.push(`Album: ${album}${year ? ` (${year})` : ''}.`);
  else if (year) parts.push(`Released ${year}.`);

  const era = decadeText(year);
  if (era) parts.push(`Era: ${era}.`);

  const genres = [val(f, 'Genre'), val(f, 'Local Genre')].filter(Boolean);
  if (genres.length) parts.push(`Genre: ${[...new Set(genres)].join(' / ')}.`);

  const lang = LANG_NAMES[val(f, 'Language Code').toLowerCase()] || val(f, 'Language');
  if (lang) parts.push(`Language: ${lang}.`);

  const mood = val(f, 'AI_Mood');
  const energy = energyText(val(f, 'AI_Energy'));
  const bpm = val(f, 'AI_BPM');
  const key = val(f, 'AI_Key');
  const feel = [mood, energy].filter(Boolean).join(', ');
  if (feel || bpm) {
    parts.push(`Mood: ${feel || 'unknown'}${bpm ? ` (${Math.round(Number(bpm))} BPM${key ? `, ${key}` : ''})` : ''}.`);
  }

  const producer = val(f, 'Producer');
  if (producer) parts.push(`Produced by ${producer}.`);
  const composer = val(f, 'Composer');
  if (composer) parts.push(`Composed by ${composer}.`);
  const label = val(f, 'Label');
  if (label) parts.push(`Label: ${label}.`);

  return parts.join(' ');
}

function buildMeta(f) {
  return {
    track: val(f, 'Track Name'),
    artist: val(f, 'Track Artist') || val(f, 'Album Artist'),
    album: val(f, 'Album Title') || val(f, 'Tape Files::Album Title'),
    year: val(f, 'Year of Release'),
    genre: val(f, 'Genre'),
    localGenre: val(f, 'Local Genre'),
    mood: val(f, 'AI_Mood'),
    energy: val(f, 'AI_Energy'),
    bpm: val(f, 'AI_BPM'),
    key: val(f, 'AI_Key'),   // carried for the album-level musical re-rank (build-suggest)
    language: val(f, 'Language Code'),
    // Carried so the derived suggest.db can group/render albums + resolve seeds
    // with zero FileMaker calls at runtime (see scripts/semantic/build-suggest.mjs).
    // NOTE: `artist` above is the TRACK artist (for embedding richness); album
    // identity/display must use `albumArtist` (CLAUDE invariant #1) + `catalogue`.
    albumArtist: val(f, 'Album Artist') || val(f, 'Tape Files::Album Artist'),
    artworkUrl: val(f, 'Artwork_S3_URL') || val(f, 'Tape Files::Artwork_S3_URL'),
    catalogue: val(f, 'Reference Catalogue Number') || val(f, 'Album Catalogue Number')
  };
}

// ── Source loaders (Postgres mirror by default; FileMaker fallback) ──────────

function keepRow(recordId, f) {
  if (!isVisible(f)) return null;
  if (!hasValidAudio(f)) return null;
  const doc = buildDoc(f);
  if (!doc || doc.length < 20) return null;
  return { recordId: String(recordId), doc, meta: buildMeta(f), hash: sha1(doc) };
}

async function loadRowsFromPg() {
  const lim = Number.isFinite(argLimit) ? ` LIMIT ${Math.max(1, argLimit)}` : '';
  console.log('[ingest] source: Postgres mirror (tracks)');
  const { rows: recs } = await pgQuery(`SELECT fm_record_id AS "recordId", raw FROM tracks ORDER BY fm_record_id${lim}`);
  const rows = [];
  for (const rec of recs) {
    const row = keepRow(rec.recordId, rec.raw || {});
    if (row) rows.push(row);
  }
  console.log(`[ingest] PG scanned ${recs.length}, kept ${rows.length} (visible+playable)`);
  return rows;
}

async function loadRowsFromFM() {
  console.log(`[ingest] source: FileMaker ${HOST}/${FMDB} layout ${LAYOUT}`);
  const token = await fmLogin();
  const rows = [];
  let offset = 1, scanned = 0;
  const PAGE = 500;
  try {
    while (scanned < argLimit) {
      const page = await fmPage(token, offset, Math.min(PAGE, argLimit - scanned));
      if (!page.length) break;
      for (const rec of page) {
        scanned++;
        const row = keepRow(rec.recordId, rec.fieldData);
        if (row) rows.push(row);
      }
      offset += page.length;
      if (scanned % 5000 < PAGE) console.log(`[ingest] scanned ${scanned}, kept ${rows.length}`);
    }
  } finally { await fmLogout(token); }
  console.log(`[ingest] FM fetch done: scanned ${scanned}, kept ${rows.length}`);
  return rows;
}

// Read the prior index so unchanged docs reuse their vector (incremental).
// Returns Map recordId → { hash, embedding(Buffer) }. Empty if no prior or the
// prior predates the hash column (→ one full rebuild establishes hashes).
function loadPriorVectors(dbPath) {
  const prior = new Map();
  if (!fs.existsSync(dbPath)) return prior;
  let pdb;
  try {
    pdb = new Database(dbPath, { readonly: true });
    sqliteVec.load(pdb);
    const cols = pdb.prepare('PRAGMA table_info(tracks)').all().map((c) => c.name);
    if (!cols.includes('hash')) return prior;
    const stmt = pdb.prepare('SELECT t.recordId AS recordId, t.hash AS hash, v.embedding AS embedding FROM tracks t JOIN vec_tracks v ON v.rowid = t.id');
    for (const r of stmt.iterate()) prior.set(r.recordId, { hash: r.hash, embedding: r.embedding });
  } catch (e) {
    console.warn('[ingest] prior index unreadable — full rebuild:', e.message);
    prior.clear();
  } finally { if (pdb) { try { pdb.close(); } catch { /* noop */ } } }
  return prior;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const t0 = Date.now();
const usePg = process.env.SUGGEST_SOURCE === 'postgres'
  || (isPgEnabled() && !process.env.SUGGEST_FM_HOST && process.env.SUGGEST_SOURCE !== 'filemaker');
const rows = usePg ? await loadRowsFromPg() : await loadRowsFromFM();
if (usePg) await closePgPool();

if (!rows.length) {
  console.error('[ingest] nothing to index — check filters/source');
  process.exit(1);
}

// Incremental: reuse the prior vector for any doc whose hash is unchanged.
const prior = loadPriorVectors(DB_PATH);
const toEmbed = rows.filter((r) => { const p = prior.get(r.recordId); return !p || p.hash !== r.hash; });
console.log(`[ingest] ${rows.length} tracks · reuse ${rows.length - toEmbed.length} · (re)embed ${toEmbed.length}`);

if (toEmbed.length) {
  console.log(`[ingest] loading embedding model ${MODEL_ID} (first run downloads ~120MB)…`);
  const embed = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
  const tEmbed = Date.now();
  let done = 0;
  for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) {
    const batch = toEmbed.slice(i, i + EMBED_BATCH);
    // e5 models expect "passage: " on documents and "query: " on queries.
    const out = await embed(batch.map((r) => `passage: ${r.doc}`), { pooling: 'mean', normalize: true });
    const vecs = out.tolist();
    batch.forEach((r, j) => { r.embedding = Buffer.from(new Float32Array(vecs[j]).buffer); });
    done += batch.length;
    if (done % 1600 < EMBED_BATCH) {
      const rate = done / ((Date.now() - tEmbed) / 1000);
      console.log(`[ingest] embedded ${done}/${toEmbed.length} (${rate.toFixed(0)}/s, ~${Math.round((toEmbed.length - done) / rate)}s left)`);
    }
  }
}
// Reused rows inherit their prior vector.
for (const r of rows) if (!r.embedding) r.embedding = prior.get(r.recordId).embedding;

// Write a fresh DB to a temp path, then atomic-rename (a crash can't corrupt it).
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const tmp = `${DB_PATH}.tmp`;
fs.rmSync(tmp, { force: true });
const db = new Database(tmp);
sqliteVec.load(db);
db.exec(`
  CREATE TABLE tracks (
    id INTEGER PRIMARY KEY,
    recordId TEXT NOT NULL UNIQUE,
    doc TEXT NOT NULL,
    meta TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE vec_tracks USING vec0(embedding float[${VEC_DIM}]);
  CREATE TABLE index_info (key TEXT PRIMARY KEY, value TEXT);
`);
const insTrack = db.prepare('INSERT INTO tracks (id, recordId, doc, meta, hash) VALUES (?, ?, ?, ?, ?)');
const insVec = db.prepare('INSERT INTO vec_tracks (rowid, embedding) VALUES (?, ?)');
db.transaction(() => {
  rows.forEach((r, i) => {
    const id = i + 1;
    insTrack.run(id, r.recordId, r.doc, JSON.stringify(r.meta), r.hash);
    insVec.run(BigInt(id), r.embedding);
  });
})();

const setInfo = db.prepare('INSERT INTO index_info (key, value) VALUES (?, ?)');
setInfo.run('model', MODEL_ID);
setInfo.run('dim', String(VEC_DIM));
setInfo.run('builtAt', new Date().toISOString());
setInfo.run('tracks', String(rows.length));
db.close();
fs.renameSync(tmp, DB_PATH);

const mb = (fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(1);
console.log(`[ingest] DONE: ${rows.length} tracks (${toEmbed.length} embedded, ${rows.length - toEmbed.length} reused) → ${DB_PATH} (${mb} MB) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
