// lib/comments-store.js — timed comments + reactions in Postgres (2026-10-12). Tables: db/schema.sql
// (comment_authors, track_comments, comment_reports, track_reactions). A listener = the normalised
// email on their access code. Reads here are cached by routes/comments.js (SWR per track); writes are
// never cached and invalidate that track's entry.
import { query, isPgEnabled } from './pg.js';

export const REPORTS_TO_HIDE = 3;          // distinct listeners reporting a comment hide it until the team looks
export const MAX_PER_TRACK = 500;          // the newest 500 visible comments of a song are shown
export const REACTIONS = ['fire', 'clap', 'tear'];

export function commentsAvailable() { return isPgEnabled(); }

/** The public view of a song: visible comments (oldest moment first) and reaction counts. */
export async function trackComments(trackId) {
  const [c, r] = await Promise.all([
    query(
      `SELECT * FROM (
         SELECT c.id, c.at_ms, c.body, c.created_at, a.display_name AS name, c.author_email
           FROM track_comments c JOIN comment_authors a ON a.email = c.author_email
          WHERE c.track_id = $1 AND c.status = 'visible'
          ORDER BY c.created_at DESC LIMIT ${MAX_PER_TRACK}) x
        ORDER BY at_ms, created_at`, [trackId]),
    query(`SELECT emoji, count(*)::int AS n FROM track_reactions WHERE track_id = $1 GROUP BY emoji`, [trackId]),
  ]);
  const reactions = Object.fromEntries(REACTIONS.map((e) => [e, 0]));
  for (const row of r.rows) reactions[row.emoji] = row.n;
  return {
    comments: c.rows.map((x) => ({ id: String(x.id), atMs: x.at_ms, body: x.body, name: x.name, createdAt: x.created_at, author: x.author_email })),
    reactions,
  };
}

export async function myReactions(trackId, email) {
  const { rows } = await query(`SELECT emoji FROM track_reactions WHERE track_id = $1 AND email = $2`, [trackId, email]);
  return rows.map((r) => r.emoji);
}

export async function getAuthor(email) {
  const { rows } = await query(`SELECT email, display_name, banned FROM comment_authors WHERE email = $1`, [email]);
  return rows[0] ? { name: rows[0].display_name, banned: rows[0].banned } : null;
}

/** Set or change a display name. → { ok } | { ok: false, taken: true } */
export async function setDisplayName(email, name) {
  try {
    await query(
      `INSERT INTO comment_authors (email, display_name) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()`, [email, name]);
    return { ok: true };
  } catch (err) {
    if (err?.code === '23505') return { ok: false, taken: true };   // the unique lower(display_name) index
    throw err;
  }
}

/** How many comments this listener posted in the last `minutes` (a per-person cap on top of the IP limit). */
export async function recentCount(email, minutes) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM track_comments WHERE author_email = $1 AND created_at > now() - make_interval(mins => $2)`, [email, minutes]);
  return rows[0]?.n || 0;
}

export async function addComment({ trackId, atMs, body, email }) {
  const { rows } = await query(
    `INSERT INTO track_comments (track_id, at_ms, body, author_email) VALUES ($1, $2, $3, $4)
     RETURNING id, at_ms, body, created_at`, [trackId, atMs, body, email]);
  return rows[0];
}

/** A listener reports a comment (once each). Returns { trackId, hidden } or null when there is no such comment. */
export async function reportComment(id, email) {
  const { rows } = await query(`SELECT track_id, author_email FROM track_comments WHERE id = $1 AND status <> 'deleted'`, [id]);
  if (!rows[0]) return null;
  if (rows[0].author_email === email) return { trackId: rows[0].track_id, hidden: false };   // reporting yourself does nothing
  const ins = await query(`INSERT INTO comment_reports (comment_id, reporter_email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, email]);
  if (!ins.rowCount) return { trackId: rows[0].track_id, hidden: false };
  const up = await query(
    `UPDATE track_comments SET reports = reports + 1, updated_at = now(),
            status = CASE WHEN status = 'visible' AND reports + 1 >= $2 THEN 'hidden' ELSE status END,
            hidden_reason = CASE WHEN status = 'visible' AND reports + 1 >= $2 THEN 'reports' ELSE hidden_reason END
      WHERE id = $1 RETURNING status`, [id, REPORTS_TO_HIDE]);
  return { trackId: rows[0].track_id, hidden: up.rows[0]?.status === 'hidden' };
}

/** A listener deletes their OWN comment. Returns the track id, or null when it isn't theirs. */
export async function deleteOwnComment(id, email) {
  const { rows } = await query(
    `UPDATE track_comments SET status = 'deleted', updated_at = now() WHERE id = $1 AND author_email = $2 AND status <> 'deleted'
     RETURNING track_id`, [id, email]);
  return rows[0]?.track_id ?? null;
}

/** Tap a reaction: give it, or take it back. → true when it is now on. */
export async function toggleReaction(trackId, email, emoji) {
  const del = await query(`DELETE FROM track_reactions WHERE track_id = $1 AND email = $2 AND emoji = $3`, [trackId, email, emoji]);
  if (del.rowCount) return false;
  await query(`INSERT INTO track_reactions (track_id, email, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [trackId, email, emoji]);
  return true;
}
