/**
 * lib/semantic-index.js — runtime loader for the slim album-suggestion index.
 *
 * Loads data/suggest.db (built offline by scripts/semantic/build-suggest.mjs)
 * once at boot and answers item-to-item "Similar albums" queries entirely from
 * precomputed album centroids — NO embedding model, NO FileMaker on the request
 * path (preserves the 10k-concurrent rule; FM is never touched here).
 *
 * Degrade-gracefully contract: if the DB file is absent or unreadable, the index
 * stays `ready=false`, suggestAlbums() returns [] and the app still boots. The
 * suggestions route is feature-flagged on top of this, so a missing artifact is
 * never fatal.
 *
 * Optional boot-time fetch: if SUGGEST_DB_URL is set and the local file is
 * missing, the artifact is downloaded once (Render's disk is ephemeral across
 * deploys — same pattern the proposal describes for semantic.db).
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveArtworkSrc } from './track.js';
import { createLogger } from './logger.js';

// better-sqlite3 / sqlite-vec are native modules and are imported LAZILY (inside
// initSemanticIndex) on purpose: server.js imports this module at boot even when
// SUGGESTIONS_ENABLED is off, and a static import would couple whole-app boot to
// those native binaries loading. Lazy import keeps a binary problem contained to
// the (flag-gated, degrade-gracefully) suggestions feature.

const log = createLogger('semantic-index');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.SUGGEST_DB_PATH || path.join(__dirname, '..', 'data', 'suggest.db');
const VEC_DIM = 384;

// album|||artist — MUST match scripts/semantic/build-suggest.mjs albumKeyOf().
const norm = (s) => String(s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
export const albumKeyOf = (album, artist) => `${norm(album)}|||${norm(artist)}`;

// ── module state ────────────────────────────────────────────────────────────
let db = null;
let ready = false;
let info = {};
// albumKey is the catalogue number (normalised); resolution therefore needs
// separate text indices for title+albumArtist and title-only lookups.
let byKey = new Map();          // albumKey → { id, meta }
let byCat = new Map();          // norm(catalogue) → albumKey
let byTitleArtist = new Map();  // norm(title)|||norm(albumArtist) → albumKey
let byTitle = new Map();        // norm(title) → albumKey (first wins; fallback)

export function semanticIndexStatus() {
  return {
    ready,
    albums: ready ? byKey.size : 0,
    model: info.model || null,
    sourceBuiltAt: info.sourceBuiltAt || null,
    path: DB_PATH
  };
}

// Remote version marker (ETag/Last-Modified) of the index we last loaded — used
// by the auto-refresh to skip re-downloading an unchanged file.
let lastVersion = null;
let refreshing = false;
let refreshTimer = null;

// Download the index URL to `dest` atomically. Returns the version marker.
async function downloadIndex(url, dest) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.download`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest); // atomic — a half-written file is never opened
  log.info(`downloaded index (${(buf.length / 1024 / 1024).toFixed(1)} MB) from ${url}`);
  return res.headers.get('etag') || res.headers.get('last-modified') || String(buf.length);
}

// Open a suggest.db at `srcPath` and build the in-memory resolution maps.
// Returns a self-contained state object (does NOT touch module globals), so the
// caller can swap it in atomically. Throws on any problem.
async function openAndBuild(srcPath) {
  const { default: Database } = await import('better-sqlite3');
  const sqliteVec = await import('sqlite-vec');
  const handle = new Database(srcPath, { readonly: true, fileMustExist: true });
  sqliteVec.load(handle);

  const inf = Object.fromEntries(handle.prepare('SELECT key, value FROM index_info').all().map((r) => [r.key, r.value]));
  if (Number(inf.dim) !== VEC_DIM) {
    handle.close();
    throw new Error(`index dim ${inf.dim} != expected ${VEC_DIM}`);
  }

  const k = new Map(), c = new Map(), ta = new Map(), t = new Map();
  for (const row of handle.prepare('SELECT id, albumKey, meta FROM albums').iterate()) {
    const meta = JSON.parse(row.meta);
    k.set(row.albumKey, { id: row.id, meta });
    const cat = norm(meta.catalogue);
    if (cat && !c.has(cat)) c.set(cat, row.albumKey);
    const title = norm(meta.album);
    if (title) {
      const taKey = `${title}|||${norm(meta.artist)}`;
      if (!ta.has(taKey)) ta.set(taKey, row.albumKey);
      if (!t.has(title)) t.set(title, row.albumKey);
    }
  }
  if (!k.size) { handle.close(); throw new Error('index has 0 albums'); }
  return { handle, info: inf, byKey: k, byCat: c, byTitleArtist: ta, byTitle: t };
}

// Atomically replace the live index with a freshly-built state, closing the old
// handle. Synchronous — never interleaves with a sync suggestAlbums() call.
function swapIn(state) {
  const old = db;
  db = state.handle;
  info = state.info;
  byKey = state.byKey;
  byCat = state.byCat;
  byTitleArtist = state.byTitleArtist;
  byTitle = state.byTitle;
  ready = true;
  if (old && old !== state.handle) { try { old.close(); } catch {} }
}

/**
 * Open the index and load resolution maps into memory (~11k small rows).
 * Idempotent; safe to call once at boot. Never throws — failures leave the
 * index in the not-ready state and are logged. Starts the auto-refresh timer.
 */
export async function initSemanticIndex() {
  if (ready) return true;
  try {
    if (!fs.existsSync(DB_PATH) && process.env.SUGGEST_DB_URL) {
      lastVersion = await downloadIndex(process.env.SUGGEST_DB_URL, DB_PATH);
    }
    if (!fs.existsSync(DB_PATH)) {
      log.warn(`index not found at ${DB_PATH} — "Similar albums" disabled until an artifact is present`);
      return false;
    }
    swapIn(await openAndBuild(DB_PATH));
    log.info(`loaded ${byKey.size} album centroids (model ${info.model}, source built ${info.sourceBuiltAt || 'unknown'})`);
    startAutoRefresh();
    return true;
  } catch (err) {
    log.error('init failed (suggestions will be unavailable):', err?.message || err);
    ready = false;
    return false;
  }
}

// Periodic hot-swap: when a newer index is published to SUGGEST_DB_URL, download
// and swap it in WITHOUT a restart. A HEAD request checks the version marker
// first so an unchanged file isn't re-downloaded. Default 60 min; set
// SUGGEST_REFRESH_MINUTES=0 to disable. Each cluster worker refreshes its own.
function startAutoRefresh() {
  if (refreshTimer) return;
  const url = process.env.SUGGEST_DB_URL;
  const minutes = Number(process.env.SUGGEST_REFRESH_MINUTES ?? 60);
  if (!url || !(minutes > 0)) return;
  refreshTimer = setInterval(() => { refreshIndex().catch(() => {}); }, minutes * 60 * 1000);
  refreshTimer.unref?.(); // don't keep the process alive for the timer
  log.info(`auto-refresh every ${minutes} min from ${url}`);
}

export async function refreshIndex() {
  const url = process.env.SUGGEST_DB_URL;
  if (!url || refreshing) return false;
  refreshing = true;
  try {
    // Cheap change check first.
    try {
      const head = await fetch(url, { method: 'HEAD' });
      const ver = head.ok ? (head.headers.get('etag') || head.headers.get('last-modified')) : null;
      if (ver && lastVersion && ver === lastVersion) return false; // unchanged
    } catch { /* HEAD failed — fall through and try a full download */ }

    const tmp = `${DB_PATH}.refresh`;
    const ver = await downloadIndex(url, tmp);
    const state = await openAndBuild(tmp);     // validate before swapping
    fs.renameSync(tmp, DB_PATH);               // promote to the canonical path
    swapIn(state);
    lastVersion = ver;
    log.info(`index refreshed → ${byKey.size} albums (built ${info.sourceBuiltAt || 'unknown'})`);
    return true;
  } catch (err) {
    log.warn('index refresh failed (keeping current):', err?.message || err);
    try { fs.rmSync(`${DB_PATH}.refresh`, { force: true }); } catch {}
    return false;
  } finally {
    refreshing = false;
  }
}

// Resolve a seed request to an albumKey + row. Strongest signal first:
// catalogue → title+albumArtist → title-only.
function resolveSeed({ cat, title, artist } = {}) {
  if (cat) {
    const key = byCat.get(norm(cat));
    if (key) return { key, row: byKey.get(key) };
  }
  if (title && artist) {
    const key = byTitleArtist.get(`${norm(title)}|||${norm(artist)}`);
    if (key) return { key, row: byKey.get(key) };
  }
  if (title) {
    const key = byTitle.get(norm(title));
    if (key) return { key, row: byKey.get(key) };
  }
  return null;
}

// A usable master artwork URL has a non-empty filename. Blank values like
// ".../artwork/.jpg" point at a private master that 403s — emit no artworkSrc
// so the card falls back to its placeholder instead of a broken image.
function hasUsableArtwork(url) {
  if (!url) return false;
  const file = String(url).split('?')[0].split('/').pop() || '';
  return file.includes('.') && !file.startsWith('.') && file.replace(/\.[^.]+$/, '').length > 0;
}

function toCard(meta) {
  // meta.artworkUrl is the final, ready-to-serve URL (build-suggest stores the
  // _300 derivative; enrich-artwork stores a HEAD-verified working URL). We do
  // NOT blindly rewrite to _300 here — some albums have a master but no
  // derivative, and that rewrite would 404.
  const url = meta.artworkUrl || '';
  const artworkSrc = hasUsableArtwork(url) ? resolveArtworkSrc(url) : '';
  return {
    album: meta.album || '',
    artist: meta.artist || '',
    year: meta.year || '',
    genre: meta.localGenre || meta.genre || '',
    language: meta.language || '',
    mood: meta.mood || '',
    catalogue: meta.catalogue || '',
    recordId: meta.recordId || '',
    trackCount: meta.trackCount || 0,
    artworkSrc
  };
}

// Default cap on how many albums by the same artist may appear in one result
// set — semantic similarity otherwise clusters an artist's own catalogue (and
// family acts), crowding out variety. Tunable via env.
const DEFAULT_MAX_PER_ARTIST = Math.max(1, parseInt(process.env.SUGGEST_MAX_PER_ARTIST || '2', 10) || 2);

// Separate cap on how many "Various Artists" compilations may appear. They share
// no single artist so the per-artist cap never bites them, and semantically they
// match a little of everything — left unchecked they crowd out single-artist
// albums and a rail reads as "all compilations". Default 1 per result set.
const DEFAULT_MAX_COMPILATIONS = Math.max(0, parseInt(process.env.SUGGEST_MAX_COMPILATIONS || '1', 10) || 0);

// When shuffling (opts.shuffle), draw the result from a relevance window of the
// closest candidates rather than the strict top-N — so re-opening an album shows
// a different but still-similar set. Window = limit × this factor. Larger = more
// variety but looser matches.
const SHUFFLE_POOL_FACTOR = Math.max(1, parseInt(process.env.SUGGEST_SHUFFLE_POOL || '3', 10) || 3);

// The closest N matches are ALWAYS shown first, in distance order — only the
// lower slots are shuffled. Keeps the strongest matches present every time
// (variety shouldn't cost relevance) while the rest of the rail still varies.
const SHUFFLE_LOCK = Math.max(0, parseInt(process.env.SUGGEST_SHUFFLE_LOCK || '3', 10) || 0);

// Fisher-Yates; returns a shuffled copy (does not mutate the input).
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Top-N albums similar to a seed album, with a per-artist diversity cap.
 * @param {{cat?:string, title?:string, artist?:string}} seed
 * @param {number} n
 * @param {{maxPerArtist?:number}} [opts]
 * @returns {{ ok:boolean, seed:?object, items:object[] }}
 */
export function suggestAlbums(seed = {}, n = 10, opts = {}) {
  if (!ready || !db) return { ok: false, seed: null, items: [] };
  const limit = Math.max(1, Math.min(50, Number(n) || 10));
  const maxPerArtist = Math.max(1, Number(opts.maxPerArtist) || DEFAULT_MAX_PER_ARTIST);
  const maxCompilations = Math.max(0, opts.maxCompilations != null ? Number(opts.maxCompilations) : DEFAULT_MAX_COMPILATIONS);
  const shuffle = !!opts.shuffle;

  const resolved = resolveSeed(seed);
  if (!resolved) return { ok: true, seed: null, items: [] };

  const vrow = db.prepare('SELECT embedding FROM vec_albums WHERE rowid = ?').get(BigInt(resolved.row.id));
  if (!vrow) return { ok: true, seed: { ...toCard(resolved.row.meta) }, items: [] };

  // Over-fetch generously: dropping the seed + capping per artist both thin the
  // candidate pool, so we need well more than `limit` neighbours to refill.
  const k = Math.min(byKey.size || (limit + 1), limit * 8 + 10);
  const hits = db.prepare(`
    SELECT a.albumKey AS albumKey, a.meta AS meta, x.distance AS distance
    FROM vec_albums x JOIN albums a ON a.id = x.rowid
    WHERE x.embedding MATCH ? AND k = ?
    ORDER BY x.distance
  `).all(vrow.embedding, k);

  // Build cards (distance-ordered; hits are sorted), dropping the seed.
  const candidates = [];
  for (const h of hits) {
    if (h.albumKey === resolved.key) continue;
    candidates.push({ ...toCard(JSON.parse(h.meta)), distance: +h.distance.toFixed(4) });
  }

  // Split into those WITH a usable cover and those without, then build a
  // deterministic QUALITY ranking: covers first (a rail full of placeholders
  // reads as broken), caps applied, distance order within each group. When
  // shuffling we fill a larger pool than `limit` so there's a window to vary over.
  const withArt = candidates.filter((c) => c.artworkSrc);
  const without = candidates.filter((c) => !c.artworkSrc);

  const poolTarget = shuffle
    ? Math.min(candidates.length, Math.max(limit * SHUFFLE_POOL_FACTOR, limit + 5))
    : limit;

  const ordered = [];
  const perArtist = new Map();
  let compilations = 0;
  const take = (pool) => {
    for (const card of pool) {
      if (ordered.length >= poolTarget) break;
      const artistKey = norm(card.artist);
      if (artistKey === 'various artists') {
        // Compilations get their own cap (they share no artist, so the
        // per-artist cap never applies) — otherwise they dominate the rail.
        if (compilations >= maxCompilations) continue;
        compilations += 1;
      } else if (artistKey) {
        const seen = perArtist.get(artistKey) || 0;
        if (seen >= maxPerArtist) continue;
        perArtist.set(artistKey, seen + 1);
      }
      ordered.push(card);
    }
  };
  take(withArt);
  take(without); // only reached if cover-having albums didn't fill the pool

  // "Fresh set each visit": keep the closest SHUFFLE_LOCK matches fixed (variety
  // shouldn't cost the strongest matches) and shuffle the rest of the pool, then
  // trim to `limit`. Any subset of `ordered` still respects the caps above.
  let items = ordered;
  if (shuffle) {
    const lock = Math.min(SHUFFLE_LOCK, ordered.length, limit);
    items = ordered.slice(0, lock).concat(shuffled(ordered.slice(lock)));
  }
  items = items.slice(0, limit);

  return { ok: true, seed: toCard(resolved.row.meta), items };
}
