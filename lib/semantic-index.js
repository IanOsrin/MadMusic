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
  if (old && old !== state.handle) { try { old.close(); } catch { /* already closed */ } }
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
    try { fs.rmSync(`${DB_PATH}.refresh`, { force: true }); } catch { /* best effort cleanup */ }
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
// family acts), crowding out variety. Tunable via env. Dropped 2→1 (Ian,
// 2026-07-06: rails still read as same-artist walls at 2).
const DEFAULT_MAX_PER_ARTIST = Math.max(1, parseInt(process.env.SUGGEST_MAX_PER_ARTIST || '1', 10) || 1);

// Albums by the SEED's own artist are excluded from the rail entirely — the
// visitor is already looking at that artist; suggestions should widen, not
// echo. Disable with SUGGEST_EXCLUDE_SEED_ARTIST=false. Never applies when the
// seed is a Various Artists compilation (that would empty compilation rails).
const EXCLUDE_SEED_ARTIST = process.env.SUGGEST_EXCLUDE_SEED_ARTIST !== 'false';

// Collapse billing variants to one artist identity for the caps above:
// "X & The Band", "X feat. Y", "X and Y", "X with Y" all count as "X". Cutting
// at the first connective can over-group names that legitimately contain one
// ("Earth Wind & Fire" → "earth wind") — an acceptable trade: the failure mode
// is slightly FEWER albums from a family of acts, never a flooded rail.
const ARTIST_CONNECTIVES = /\s+(?:feat\.?|ft\.?|featuring|&|and|with|presents?|meets|vs\.?|x)\s+|\s*[,/+]\s*/i;
export function artistCoreKey(name) {
  const n = norm(name);
  if (!n || n === 'various artists') return n;
  const core = n.split(ARTIST_CONNECTIVES)[0].trim();
  return core || n;
}

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

// ── Musical re-rank (vibe-first) ─────────────────────────────────────────────
// After the semantic KNN returns the closest albums, nudge harmonically- and
// tempo-compatible ones up WITHIN that pool. Weight is small so genre/mood still
// leads; SUGGEST_MUSIC_WEIGHT=0 disables it (pure semantic). Features come from
// build-suggest album meta (median BPM, Camelot key num/mode, avg energy); a
// missing feature is treated as neutral so it neither boosts nor penalises.
const MUSIC_WEIGHT = Math.max(0, Number(process.env.SUGGEST_MUSIC_WEIGHT ?? 0.1) || 0);
const W_KEY = 0.4, W_BPM = 0.4, W_ENERGY = 0.2;

function musicFromMeta(m) {
  return {
    bpm: Number.isFinite(m.bpm) ? m.bpm : null,
    energy: Number.isFinite(m.energy) ? m.energy : null,
    keyNum: Number.isInteger(m.keyNum) ? m.keyNum : null,
    keyMajor: typeof m.keyMajor === 'boolean' ? m.keyMajor : null
  };
}
const hasMusic = (x) => !!x && (x.bpm != null || x.keyNum != null || x.energy != null);

// Camelot-wheel harmonic compatibility (same key=1, relative/adjacent high, …).
function keyCompat(a, b) {
  if (a.keyNum == null || b.keyNum == null) return null;
  if (a.keyNum === b.keyNum && a.keyMajor === b.keyMajor) return 1;
  const dn = Math.min(Math.abs(a.keyNum - b.keyNum), 12 - Math.abs(a.keyNum - b.keyNum));
  if (dn === 0) return 0.85;                          // relative major/minor
  if (dn === 1 && a.keyMajor === b.keyMajor) return 0.8; // adjacent on the wheel
  if (dn === 1) return 0.4;                            // adjacent, different mode
  return Math.max(0, 1 - dn / 6) * 0.3;               // distant keys
}
// Tempo proximity, tolerant of half/double-time (120 ≈ 60 ≈ 240).
function bpmCompat(a, b) {
  if (!(a.bpm > 0) || !(b.bpm > 0)) return null;
  const d = Math.min(Math.abs(a.bpm - b.bpm), Math.abs(a.bpm - 2 * b.bpm), Math.abs(2 * a.bpm - b.bpm));
  return Math.max(0, 1 - d / 30);
}
function energyCompat(a, b) {
  if (a.energy == null || b.energy == null) return null;
  return Math.max(0, 1 - Math.abs(a.energy - b.energy) / 100);
}
// Weighted blend of the available sub-scores → [0,1], or null if none apply.
function musicalCompat(a, b) {
  const parts = [];
  const k = keyCompat(a, b); if (k != null) parts.push([k, W_KEY]);
  const t = bpmCompat(a, b); if (t != null) parts.push([t, W_BPM]);
  const e = energyCompat(a, b); if (e != null) parts.push([e, W_ENERGY]);
  if (!parts.length) return null;
  const w = parts.reduce((s, [, ww]) => s + ww, 0);
  return parts.reduce((s, [v, ww]) => s + v * ww, 0) / w;
}

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
  // When true, never top up the rail with cover-less albums (the route sets this
  // so the public Similar-albums rail never shows a placeholder sleeve). The lib
  // default keeps the art-less filler so callers can still page the full result.
  const coversOnly = !!opts.coversOnly;

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
    const cmeta = JSON.parse(h.meta);
    candidates.push({ ...toCard(cmeta), distance: +h.distance.toFixed(4), _music: musicFromMeta(cmeta) });
  }

  // Vibe-first musical re-rank: reorder the semantically-similar pool by a small
  // musical penalty (harmonic key + tempo + energy). Skipped when disabled or the
  // seed has no musical features (e.g. an index built before AI_BPM coverage), so
  // it degrades to pure semantic ordering. A candidate missing features scores
  // neutral (no boost or penalty).
  const seedMusic = musicFromMeta(resolved.row.meta);
  if (MUSIC_WEIGHT > 0 && hasMusic(seedMusic)) {
    for (const c of candidates) {
      const mc = hasMusic(c._music) ? musicalCompat(seedMusic, c._music) : null;
      c._blended = c.distance + MUSIC_WEIGHT * (1 - (mc == null ? 0.5 : mc));
    }
    candidates.sort((a, b) => a._blended - b._blended);
  }

  // Split into those WITH a usable cover and those without. A rail full of
  // placeholders reads as broken, so covers come first (caps + distance order
  // within each group). With coversOnly the art-less filler is dropped entirely;
  // otherwise it tops up the page. When shuffling we fill a larger pool than
  // `limit` so there's a window to vary over.
  const withArt = candidates.filter((c) => c.artworkSrc);
  const without = candidates.filter((c) => !c.artworkSrc);

  const poolTarget = shuffle
    ? Math.min(candidates.length, Math.max(limit * SHUFFLE_POOL_FACTOR, limit + 5))
    : limit;

  // Seed-artist exclusion + per-artist cap both key on the FUZZY artist
  // identity (artistCoreKey) so billing variants ("X", "X & Band", "X feat. Y")
  // can't flood the rail as distinct artists.
  const seedArtistKey = EXCLUDE_SEED_ARTIST ? artistCoreKey(toCard(resolved.row.meta).artist) : '';
  const excludeSeedArtist = seedArtistKey && seedArtistKey !== 'various artists';

  const ordered = [];
  const perArtist = new Map();
  let compilations = 0;
  const take = (pool) => {
    for (const card of pool) {
      if (ordered.length >= poolTarget) break;
      const artistKey = artistCoreKey(card.artist);
      if (artistKey === 'various artists') {
        // Compilations get their own cap (they share no artist, so the
        // per-artist cap never applies) — otherwise they dominate the rail.
        if (compilations >= maxCompilations) continue;
        compilations += 1;
      } else if (artistKey) {
        // The seed's own artist never appears — the visitor is already on
        // that artist; the rail's job is to widen.
        if (excludeSeedArtist && artistKey === seedArtistKey) continue;
        const seen = perArtist.get(artistKey) || 0;
        if (seen >= maxPerArtist) continue;
        perArtist.set(artistKey, seen + 1);
      }
      ordered.push(card);
    }
  };
  take(withArt);
  if (!coversOnly) take(without); // art-less albums top up the page unless coversOnly

  // "Fresh set each visit": keep the closest SHUFFLE_LOCK matches fixed (variety
  // shouldn't cost the strongest matches) and shuffle the rest of the pool, then
  // trim to `limit`. Any subset of `ordered` still respects the caps above.
  let items = ordered;
  if (shuffle) {
    const lock = Math.min(SHUFFLE_LOCK, ordered.length, limit);
    items = ordered.slice(0, lock).concat(shuffled(ordered.slice(lock)));
  }
  // Strip internal re-rank fields before returning (keep the public card shape).
  items = items.slice(0, limit).map(({ _music, _blended, ...card }) => card);

  return { ok: true, seed: toCard(resolved.row.meta), items };
}
