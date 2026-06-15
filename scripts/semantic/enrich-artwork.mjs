/**
 * scripts/semantic/enrich-artwork.mjs — backfill album artwork into suggest.db.
 *
 * The slim suggestions index (data/suggest.db) is derived from a semantic.db
 * that predates artworkUrl capture, so its album cards have no sleeves. Rather
 * than wait for a full re-embed, this pulls master Artwork_S3_URLs from the M1
 * snapshot (same source build-index uses — NEVER fmcloud) and writes one onto
 * each album's meta.
 *
 * IMPORTANT: artwork is chosen PER ALBUM, across all the album's tracks — not
 * from a single representative track. Many tracks carry a blank artwork value
 * (".../artwork/.jpg", empty filename) even when the album has a real cover on
 * other tracks; picking the most common VALID cover avoids those blanks. The
 * album key matches scripts/semantic/build-suggest.mjs (catalogue number, with
 * title|||albumArtist fallback), so it lines up with suggest.db's albumKey.
 *
 *   node scripts/semantic/enrich-artwork.mjs
 *
 * Idempotent stopgap: once semantic.db is rebuilt with the updated build-index
 * (which stores artworkUrl), `npm run build:suggest` populates sleeves directly
 * and this script is no longer needed.
 *
 * Env (in .env): INGEST_FM_HOST, INGEST_FM_DB, INGEST_FM_USER, INGEST_FM_PASS
 */

import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { thumbArtworkUrl } from '../../lib/track.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const DB_PATH = process.env.SUGGEST_OUT_DB || path.join(ROOT, 'data', 'suggest.db');
const WRITE_SOURCE_PATH = process.env.SUGGEST_WRITE_SOURCE || path.join(ROOT, 'data', 'write-source.json');

const HOST = process.env.INGEST_FM_HOST;
const FMDB = process.env.INGEST_FM_DB;
const USER = process.env.INGEST_FM_USER;
const PASS = process.env.INGEST_FM_PASS;
const LAYOUT = 'API_Album_Songs';
const PAGE = 1000;

if (!fs.existsSync(DB_PATH)) {
  console.error(`[enrich] ${DB_PATH} not found — run: npm run build:suggest`);
  process.exit(1);
}

const norm = (s) => String(s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');

// A usable master artwork URL: an /artwork/<non-empty-name>.<ext>. Rejects the
// blank ".../artwork/.jpg" placeholders that pepper the catalogue.
function isValidArtwork(url) {
  if (!url) return false;
  const file = String(url).split('?')[0].split('/').pop() || '';
  return file.includes('.') && !file.startsWith('.') && file.replace(/\.[^.]+$/, '').length > 0;
}

// Album key — mirrors build-suggest.mjs (catalogue, else title|||albumArtist).
function albumKeyFor(ws) {
  const cat = norm(ws?.catalogue);
  if (cat) return cat;
  return `t:${norm(ws?.albumTitle)}|||${norm(ws?.albumArtist)}`;
}

// recordId → { catalogue, albumTitle, albumArtist } from write-source.json.
const wsByRec = new Map();
if (fs.existsSync(WRITE_SOURCE_PATH)) {
  const rows = JSON.parse(fs.readFileSync(WRITE_SOURCE_PATH, 'utf8'));
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r?.recordId) wsByRec.set(String(r.recordId), { catalogue: r.catalogue || '', albumTitle: r.albumTitle || '', albumArtist: r.albumArtist || '' });
  }
  console.log(`[enrich] write-source: ${wsByRec.size} recordIds`);
} else {
  console.warn('[enrich] write-source.json missing — album-key grouping will be weaker');
}

async function fmLogin() {
  const auth = Buffer.from(`${USER}:${PASS}`).toString('base64');
  const r = await fetch(`${HOST}/fmi/data/vLatest/databases/${FMDB}/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` }, body: '{}'
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
    const code = r.messages?.[0]?.code;
    if (code === '401' || code === '101') return [];
    throw new Error(`FM page failed at offset ${offset}: ${JSON.stringify(r.messages)}`);
  }
  return r.response.data;
}

const artOf = (f) => String(f['Artwork_S3_URL'] || f['Tape Files::Artwork_S3_URL'] || '').trim();

// ── Pull artwork per album from the M1 snapshot ─────────────────────────────
const t0 = Date.now();
console.log(`[enrich] source: ${HOST}/${FMDB}`);
const token = await fmLogin();
// albumKey → Map(artworkUrl → count) over VALID covers only
const votesByKey = new Map();
let offset = 1;
let validSeen = 0;
try {
  for (;;) {
    const page = await fmPage(token, offset, PAGE);
    if (!page.length) break;
    for (const rec of page) {
      const url = artOf(rec.fieldData || {});
      if (!isValidArtwork(url)) continue;
      validSeen++;
      const ws = wsByRec.get(String(rec.recordId));
      if (!ws) continue;
      const key = albumKeyFor(ws);
      let votes = votesByKey.get(key);
      if (!votes) { votes = new Map(); votesByKey.set(key, votes); }
      votes.set(url, (votes.get(url) || 0) + 1);
    }
    offset += page.length;
    if (offset % 10000 < PAGE) console.log(`[enrich] scanned ${offset}, albums with art ${votesByKey.size}`);
  }
} finally {
  await fmLogout(token);
}
// Reduce each album's votes → the most common valid master cover.
const bestByKey = new Map();
for (const [key, votes] of votesByKey) {
  let best = '', n = -1;
  for (const [url, c] of votes) if (c > n) { best = url; n = c; }
  bestByKey.set(key, best);
}
console.log(`[enrich] ${validSeen} valid covers → ${bestByKey.size} albums (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

// HEAD-verify each cover to the actual served URL. Many masters lack a WebP
// derivative (the resize job didn't run), so a blind _300 rewrite would 404 in
// the card. Prefer _300 → _800 → master (.jpg masters are public); keep the
// first that returns 200. Confirmed-missing (404/403) on every variant → ''.
async function headOk(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    return r.status === 200;
  } catch { return false; }
}
async function resolveServed(master) {
  for (const url of [thumbArtworkUrl(master, 300), thumbArtworkUrl(master, 800), master]) {
    if (await headOk(url)) return url;
  }
  return '';
}

const servedByKey = new Map();
const entries = [...bestByKey.entries()];
const tHead = Date.now();
let done = 0, live = 0;
const CONCURRENCY = 16;
let cursor = 0;
async function worker() {
  while (cursor < entries.length) {
    const [key, master] = entries[cursor++];
    const served = await resolveServed(master);
    servedByKey.set(key, served);
    if (served) live++;
    if (++done % 1000 === 0) console.log(`[enrich] verified ${done}/${entries.length} (${live} live)`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`[enrich] verified ${entries.length} covers → ${live} live served URLs (${((Date.now() - tHead) / 1000).toFixed(0)}s)`);

// ── Write onto suggest.db album meta (keyed by albumKey) ────────────────────
const db = new Database(DB_PATH);
sqliteVec.load(db);
const rows = db.prepare('SELECT id, albumKey, meta FROM albums').all();
const upd = db.prepare('UPDATE albums SET meta = ? WHERE id = ?');
let filled = 0, missing = 0;
const tx = db.transaction(() => {
  for (const row of rows) {
    const meta = JSON.parse(row.meta);
    const served = servedByKey.get(row.albumKey) || '';   // verified working URL, or ''
    if (served) filled++; else missing++;
    if (meta.artworkUrl !== served) { meta.artworkUrl = served; upd.run(JSON.stringify(meta), row.id); }
  }
});
tx();
const withArt = db.prepare("SELECT COUNT(*) c FROM albums WHERE json_extract(meta,'$.artworkUrl') <> ''").get().c;
db.close();

console.log(`[enrich] DONE: ${filled} albums with a verified live cover, ${missing} without`);
console.log(`[enrich] albums with a cover now: ${withArt}/${rows.length}`);
