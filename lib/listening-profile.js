/**
 * lib/listening-profile.js — what one listener has actually listened to.
 *
 * Feeds the "Suggested for You" rail. Plays live in FileMaker's stream-event
 * layout; each record is one listen, carrying the Email and/or the Token_Number
 * it was played under. A person is their email: plays logged with only a token
 * still count when that token was issued to the same email, which is how
 * someone with several tokens over the months is seen as one listener.
 *
 * A "real listen" is at least 30 seconds of a track. The rail only switches on
 * once a listener has 100 DIFFERENT songs to their name (Ian, 2026-09-17) —
 * enough that a suggestion reflects a taste rather than a handful of plays.
 *
 * Output is album-level: each album they played, weighted by how much and how
 * recently, ready for lib/semantic-index.js suggestForListener().
 */
import { fmFindAll } from '../fm-client.js';
import { FM_STREAM_EVENTS_LAYOUT } from './fm-fields.js';
import { fmExactMatch } from './validators.js';
import { normalizeEmail, parseFileMakerTimestamp } from './format.js';
import { query as pgQuery, isPgEnabled } from './pg.js';

export const MIN_SONGS = Math.max(1, parseInt(process.env.PERSONAL_RAIL_MIN_SONGS || '100', 10) || 100);
const REAL_LISTEN_SEC = 30;
const WINDOW_DAYS = 365;          // older listening no longer describes the listener
const HALF_LIFE_DAYS = 120;       // a play four months ago counts half as much as today's
const TOKENS_LAYOUT = process.env.FM_TOKENS_LAYOUT || 'API_Access_Tokens';

async function tokensForEmail(email) {
  const r = await fmFindAll(TOKENS_LAYOUT, [{ Email: fmExactMatch(email) }, { IssuedTo: fmExactMatch(email) }], { pageSize: 500, maxRecords: 2000 });
  if (!r.ok) return [];
  return [...new Set(r.data.map((d) => String(d.fieldData?.Token_Code || '').trim().toUpperCase()).filter(Boolean))];
}

/**
 * @param {{ email?: string, tokenCode?: string }} who
 * @returns {Promise<{ songs:number, albums:{cat:string,title:string,artist:string,weight:number}[], listens:number }>}
 */
export async function loadListeningProfile({ email, tokenCode } = {}) {
  const em = normalizeEmail(email || '');
  const codes = new Set(em ? await tokensForEmail(em) : []);
  if (tokenCode) codes.add(String(tokenCode).trim().toUpperCase());
  const queries = [
    ...(em ? [{ Email: fmExactMatch(em) }] : []),
    ...[...codes].map((c) => ({ Token_Number: fmExactMatch(c) })),
  ];
  if (!queries.length) return { songs: 0, albums: [], listens: 0 };

  const found = await fmFindAll(FM_STREAM_EVENTS_LAYOUT, queries, { pageSize: 1000, maxRecords: 30000 });
  if (!found.ok) throw new Error(`listening history lookup failed: ${found.msg || found.status}`);

  const now = Date.now();
  const byTrack = new Map();       // TrackRecordID → weight
  let listens = 0;
  for (const rec of found.data) {
    const f = rec.fieldData || {};
    const trackId = String(f.TrackRecordID || '').trim();
    const secs = Number(f.TotalPlayedSec ?? f.TimeStreamed ?? 0) || 0;
    if (!trackId || secs < REAL_LISTEN_SEC) continue;
    const at = parseFileMakerTimestamp(f.LastEventUTC || f.TimestampUTC) || now;
    const ageDays = Math.max(0, (now - at) / 86_400_000);
    if (ageDays > WINDOW_DAYS) continue;
    listens += 1;
    byTrack.set(trackId, (byTrack.get(trackId) || 0) + Math.pow(0.5, ageDays / HALF_LIFE_DAYS));
  }

  const songs = byTrack.size;
  if (songs < MIN_SONGS || !isPgEnabled()) return { songs, albums: [], listens };

  // Track → album from the Postgres mirror, catalogue first — the same order the
  // suggestion index builds its album keys in (scripts/semantic/build-index.mjs).
  const { rows } = await pgQuery(
    `SELECT fm_record_id AS id,
            COALESCE(NULLIF(TRIM(raw->>'Reference Catalogue Number'), ''), NULLIF(TRIM(raw->>'Album Catalogue Number'), '')) AS cat,
            COALESCE(NULLIF(raw->>'Album Title', ''), raw->>'Tape Files::Album Title') AS title,
            COALESCE(NULLIF(raw->>'Album Artist', ''), raw->>'Tape Files::Album Artist') AS artist
       FROM tracks WHERE fm_record_id = ANY($1)`,
    [[...byTrack.keys()]]
  );
  const albums = new Map();
  for (const r of rows) {
    const key = r.cat ? `c:${r.cat.toLowerCase()}` : `t:${String(r.title || '').toLowerCase()}|||${String(r.artist || '').toLowerCase()}`;
    const a = albums.get(key) || { cat: r.cat || '', title: r.title || '', artist: r.artist || '', weight: 0 };
    a.weight += byTrack.get(String(r.id)) || 0;
    albums.set(key, a);
  }
  return { songs, albums: [...albums.values()], listens };
}
