// ============================================================================
// lib/catalog-store-pg.js — Postgres-backed catalog reads (mirror of API_Album_Songs).
//
// Returns records in the SAME shape FileMaker's _find produces
// ({ recordId, modId, fieldData }) with fieldData = the synced `raw` jsonb, then
// applies the EXACT same JS filters the FM path uses (recordIsVisible /
// hasValidAudio / hasValidArtwork / recordIsFeatured). Only the data source
// changes — downstream dedup/map/SWR in the routes is untouched. Engaged when
// METADATA_SOURCE=postgres (see lib/metadata-source.js).
// ============================================================================

import { query } from './pg.js';
import { hasValidAudio, hasValidArtwork } from './track.js';
import { recordIsVisible, recordIsFeatured } from './fm-fields.js';

const clamp = (n) => Math.max(1, Math.min(1000, Number(n) || 1));

// Whitelisted flag columns — the FM rails query a boolean flag; never interpolate
// caller input into SQL.
const FLAG_COLUMNS = {
  featured:  'is_featured',
  single:    'is_single',
  globalFav: 'is_global_fav',
  g100:      'is_g100',
};

function toFmRecord(r) {
  return {
    recordId:  String(r.fm_record_id),
    modId:     r.fm_mod_id == null ? undefined : String(r.fm_mod_id),
    fieldData: r.raw || {},
  };
}
const toFmRecords = (rows) => rows.map(toFmRecord);

async function selectByFlag(flagKey, limit) {
  const col = FLAG_COLUMNS[flagKey];
  if (!col) throw new Error(`catalog-store-pg: unknown flag "${flagKey}"`);
  const r = await query(
    `SELECT fm_record_id, fm_mod_id, raw FROM tracks WHERE ${col} = true LIMIT $1`,
    [clamp(limit)],
  );
  return toFmRecords(r.rows);
}

// Shared filter chain (visible + playable + has-artwork), matching the FM rails.
const visibleAudioArtwork = (recs) =>
  recs.filter((r) => recordIsVisible(r.fieldData))
      .filter((r) => hasValidAudio(r.fieldData))
      .filter((r) => hasValidArtwork(r.fieldData));

export async function pgFeatured(limit = 400) {
  return visibleAudioArtwork(await selectByFlag('featured', limit))
    .filter((r) => recordIsFeatured(r.fieldData));
}

export async function pgSingles(limit = 1000) {
  return visibleAudioArtwork(await selectByFlag('single', limit));
}

export async function pgGlobalFavorites(limit = 1000) {
  return visibleAudioArtwork(await selectByFlag('globalFav', limit));
}

export async function pgG100(limit = 400) {
  // FM's G100 path filters audio + artwork only (no visibility); is_g100 already
  // encodes the field value match.
  return (await selectByFlag('g100', limit))
    .filter((r) => hasValidAudio(r.fieldData))
    .filter((r) => hasValidArtwork(r.fieldData));
}

export async function pgNewReleases(limit = 1000) {
  // is_new_release is reconciled by the sync via a dedicated find (the field
  // lives on the Tape Files relationship and isn't in fieldData). FM's
  // new-releases path filters visibility only (no audio/artwork), so match that;
  // album dedup happens in the route's SWR loader.
  const r = await query(
    'SELECT fm_record_id, fm_mod_id, raw FROM tracks WHERE is_new_release = true LIMIT $1',
    [clamp(limit)],
  );
  return toFmRecords(r.rows).filter((rec) => recordIsVisible(rec.fieldData));
}

// ── Generic FileMaker _find → SQL translator ────────────────────────────────
// Mirrors the FM find operators the catalog routes use, over the `raw` jsonb
// (which carries every exact FM field name). Field names come from route code,
// never user input; all VALUES are parameterised. Returns the same shape the
// routes consume: { ok, data:[{recordId,modId,fieldData}], foundCount }.
//
// Operators (per whitespace-separated token within a value, ANDed):
//   *x*  contains   ·  x*  begins-with  ·  *x  ends-with  ·  *  non-empty
//   ==x  exact (whole value, not tokenised)  ·  a..b  numeric range (e.g. years)
//   plain x  → contains (matches FM's word-ish default for our full-string lookups)

function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
}

function conditionSql(field, rawVal, params) {
  const keyIdx = params.push(field);          // jsonb key is parameterised too
  const f = `raw->>$${keyIdx}`;
  const v = String(rawVal ?? '');
  const like = (pattern) => { const i = params.push(pattern); return `${f} ILIKE $${i}`; };

  // exact (==x), whole value
  if (v.startsWith('==')) {
    const i = params.push(v.slice(2).toLowerCase());
    return `lower(${f}) = $${i}`;
  }
  // numeric range (a..b), e.g. years
  const range = v.match(/^(\d{1,4})\.\.(\d{1,4})$/);
  if (range) {
    const a = params.push(range[1]);
    const b = params.push(range[2]);
    return `(${f} ~ '^[0-9]+$' AND (${f})::int BETWEEN $${a}::int AND $${b}::int)`;
  }
  // non-empty
  if (v === '*') return `(${f} IS NOT NULL AND ${f} <> '')`;

  const tokens = v.split(/\s+/).filter(Boolean);
  if (!tokens.length) return 'TRUE';

  // contains() form: "*w1* *w2*" — every space-token is wrapped in stars → AND of
  // substring matches (free-text q). This is the ONLY case we tokenise on spaces.
  const allStarred = tokens.every((t) => t.length > 1 && t.startsWith('*') && t.endsWith('*'));
  if (allStarred) {
    const parts = tokens.map((t) => like(`%${escapeLike(t.slice(1, -1))}%`));
    return parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`;
  }

  // Starred multi-word PHRASE: "*Afro Folk*" — the stars wrap the WHOLE value,
  // so contains-match the whole phrase (genre filters build these). Without
  // this case it fell through to the prefix fallback below, which kept the
  // leading star as a literal → ILIKE '*Afro Folk%' → zero rows for every
  // multi-word genre on Postgres.
  if (v.length > 2 && v.startsWith('*') && v.endsWith('*')) {
    return like(`%${escapeLike(v.slice(1, -1))}%`);
  }

  // Single-token operator forms.
  if (tokens.length === 1) {
    const t = tokens[0];
    if (t.length > 1 && t.startsWith('*') && t.endsWith('*')) return like(`%${escapeLike(t.slice(1, -1))}%`); // *x*  contains
    if (t.endsWith('*'))   return like(`${escapeLike(t.slice(0, -1))}%`);  // x*   prefix
    if (t.startsWith('*')) return like(`%${escapeLike(t.slice(1))}`);      // *x   suffix
    return like(`${escapeLike(t)}%`);                                      // x    whole-value prefix
  }

  // Multi-word value — begins() "phrase*" or a plain "phrase" (e.g. an album
  // title or artist name). Match the WHOLE phrase as a prefix; never split on
  // spaces into substrings (that made "U Hlaza" match anything containing "U").
  const phrase = v.endsWith('*') ? v.slice(0, -1) : v;
  return like(`${escapeLike(phrase)}%`);
}

function buildWhere(queries, params) {
  const ors = (queries || []).map((obj) => {
    const ands = Object.entries(obj || {}).map(([field, val]) => conditionSql(field, val, params));
    return ands.length ? `(${ands.join(' AND ')})` : 'TRUE';
  });
  return ors.length ? `(${ors.join(' OR ')})` : 'TRUE';
}

export async function pgFind(queries, { limit = 100, offset = 1 } = {}) {
  const params = [];
  const where = buildWhere(queries, params);
  const lim = Math.max(1, Math.min(2000, Number(limit) || 100));
  const off = Math.max(0, (Number(offset) || 1) - 1); // FM offset is 1-based
  const limIdx = params.push(lim);
  const offIdx = params.push(off);
  const sql =
    `SELECT fm_record_id, fm_mod_id, raw, count(*) OVER() AS __total ` +
    `FROM tracks WHERE ${where} ORDER BY fm_record_id::bigint ` +
    `LIMIT $${limIdx} OFFSET $${offIdx}`;
  const r = await query(sql, params);
  const foundCount = r.rows.length ? Number(r.rows[0].__total) : 0;
  return { ok: true, data: r.rows.map(toFmRecord), foundCount };
}

// ── Distinct genres (/genres) ───────────────────────────────────────────────
export async function pgGenres() {
  const r = await query(
    `SELECT DISTINCT genre FROM tracks WHERE genre IS NOT NULL AND genre <> ''`,
  );
  const genres = r.rows.map((x) => x.genre).sort((a, b) => a.localeCompare(b));
  const c = await query('SELECT count(*) AS c FROM tracks');
  return { genres, foundCount: Number(c.rows[0].c), totalPages: 1 };
}

// ── Single record by FM recordId (track cache → trending/my-stats) ──────────
export async function pgTrackById(recordId) {
  if (!recordId) return null;
  const r = await query(
    'SELECT fm_record_id, fm_mod_id, raw FROM tracks WHERE fm_record_id = $1 LIMIT 1',
    [String(recordId)],
  );
  return r.rows.length ? toFmRecord(r.rows[0]) : null;
}

// ── Random pool (/random-songs) ─────────────────────────────────────────────
// Genre filter → contains-match on Local Genre; no genre → true-random sample.
export async function pgRandomPool(genres = []) {
  if (genres.length) {
    const queries = genres.map((g) => ({ 'Local Genre': `*${g}*` }));
    const { data } = await pgFind(queries, { limit: 500 });
    return { error: false, data };
  }
  // TABLESAMPLE reads ~3% of the table's pages instead of shuffling all ~58k
  // heavy jsonb rows (`ORDER BY random()` measured 6.4s on prod, 2026-07-19;
  // the sample path is ~50ms). Page sampling is "clumpy" (rows that share a
  // page arrive together), but the pool consumer already shuffles per pick —
  // and the old FileMaker path served a fully CONTIGUOUS 600-record window,
  // so this is strictly more random than what shipped before.
  const sampled = await query(
    `SELECT fm_record_id, fm_mod_id, raw FROM tracks TABLESAMPLE SYSTEM (3)
      WHERE raw->>'Album Title' <> '' ORDER BY random() LIMIT 600`,
  );
  if (sampled.rows.length >= 600) return { error: false, data: toFmRecords(sampled.rows) };
  // Sparse sample (small table / unlucky pages) — fall back to the full shuffle.
  const r = await query(
    `SELECT fm_record_id, fm_mod_id, raw FROM tracks WHERE raw->>'Album Title' <> '' ORDER BY random() LIMIT 600`,
  );
  return { error: false, data: toFmRecords(r.rows) };
}

// ── Records lacking audio (/missing-audio-songs) ────────────────────────────
export async function pgMissingAudio(count = 12) {
  const lim = Math.max(1, Math.min(1000, (Number(count) || 12) * 5));
  const r = await query(
    `SELECT fm_record_id, fm_mod_id, raw FROM tracks WHERE s3_audio_url IS NULL ORDER BY random() LIMIT $1`,
    [lim],
  );
  return toFmRecords(r.rows);
}
