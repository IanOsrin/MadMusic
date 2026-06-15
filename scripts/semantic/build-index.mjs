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
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { pipeline } from '@huggingface/transformers';
import { hasValidAudio } from '../../lib/track.js';

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
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'semantic.db');

const HOST = process.env.INGEST_FM_HOST;
const FMDB = process.env.INGEST_FM_DB;
const USER = process.env.INGEST_FM_USER;
const PASS = process.env.INGEST_FM_PASS;
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

// ── Main ──────────────────────────────────────────────────────────────────────

const t0 = Date.now();
console.log(`[ingest] source: ${HOST}/${FMDB} layout ${LAYOUT}`);

// Phase A — fetch + filter + compose
const token = await fmLogin();
const rows = [];
let offset = 1;
let scanned = 0;
const PAGE = 500;
try {
  while (scanned < argLimit) {
    const page = await fmPage(token, offset, Math.min(PAGE, argLimit - scanned));
    if (!page.length) break;
    for (const rec of page) {
      const f = rec.fieldData;
      scanned++;
      if (!isVisible(f)) continue;
      if (!hasValidAudio(f)) continue;
      const doc = buildDoc(f);
      if (!doc || doc.length < 20) continue;
      rows.push({ recordId: String(rec.recordId), doc, meta: buildMeta(f) });
    }
    offset += page.length;
    if (scanned % 5000 < PAGE) {
      console.log(`[ingest] scanned ${scanned}, kept ${rows.length} (visible+playable)`);
    }
  }
} finally {
  await fmLogout(token);
}
console.log(`[ingest] fetch done: scanned ${scanned}, kept ${rows.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

if (!rows.length) {
  console.error('[ingest] nothing to index — check filters/credentials');
  process.exit(1);
}

// Phase B — embed locally + write sqlite-vec index
console.log(`[ingest] loading embedding model ${MODEL_ID} (first run downloads ~120MB)…`);
const embed = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.rmSync(DB_PATH, { force: true }); // full rebuild — the index is disposable by design
const db = new Database(DB_PATH);
sqliteVec.load(db);
db.exec(`
  CREATE TABLE tracks (
    id INTEGER PRIMARY KEY,
    recordId TEXT NOT NULL UNIQUE,
    doc TEXT NOT NULL,
    meta TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE vec_tracks USING vec0(embedding float[${VEC_DIM}]);
  CREATE TABLE index_info (key TEXT PRIMARY KEY, value TEXT);
`);
const insTrack = db.prepare('INSERT INTO tracks (id, recordId, doc, meta) VALUES (?, ?, ?, ?)');
const insVec = db.prepare('INSERT INTO vec_tracks (rowid, embedding) VALUES (?, ?)');

let done = 0;
const tEmbed = Date.now();
for (let i = 0; i < rows.length; i += EMBED_BATCH) {
  const batch = rows.slice(i, i + EMBED_BATCH);
  // e5 models expect "passage: " on documents and "query: " on queries.
  const out = await embed(batch.map((r) => `passage: ${r.doc}`), { pooling: 'mean', normalize: true });
  const vecs = out.tolist();
  const tx = db.transaction(() => {
    batch.forEach((r, j) => {
      const id = i + j + 1;
      insTrack.run(id, r.recordId, r.doc, JSON.stringify(r.meta));
      insVec.run(BigInt(id), Buffer.from(new Float32Array(vecs[j]).buffer));
    });
  });
  tx();
  done += batch.length;
  if (done % 1600 < EMBED_BATCH) {
    const rate = done / ((Date.now() - tEmbed) / 1000);
    const eta = Math.round((rows.length - done) / rate);
    console.log(`[ingest] embedded ${done}/${rows.length} (${rate.toFixed(0)}/s, ~${eta}s left)`);
  }
}

db.prepare('INSERT INTO index_info (key, value) VALUES (?, ?)').run('model', MODEL_ID);
db.prepare('INSERT INTO index_info (key, value) VALUES (?, ?)').run('dim', String(VEC_DIM));
db.prepare('INSERT INTO index_info (key, value) VALUES (?, ?)').run('builtAt', new Date().toISOString());
db.prepare('INSERT INTO index_info (key, value) VALUES (?, ?)').run('tracks', String(rows.length));
db.close();

const mb = (fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(1);
console.log(`[ingest] DONE: ${rows.length} tracks → ${DB_PATH} (${mb} MB) in ${((Date.now() - t0) / 1000).toFixed(0)}s total`);
