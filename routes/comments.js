// routes/comments.js — SoundCloud-style timed comments + quick reactions (client request, 2026-10-12).
//
// Every comment is pinned to a moment in a song; the players show markers on the progress bar and pop
// each comment up as the song reaches it. Ian's calls: everyone can READ (guests too — a nudge to
// subscribe), only subscribers can POST, under a display name they choose once; comments appear at once,
// a word filter blocks slurs/profanity/links, listeners can report, 3 reports hide a comment until the
// team looks, and the team hides comments / blocks authors in GalloIngest's Comments tab.
//
// Public (skip-listed in server.js; a token, when sent, only personalises the answer):
//   GET  /api/track-comments/:trackId → { ok, comments: [{ id, atMs, body, name, mine }], reactions: { fire, clap, tear },
//                                         myReactions: [...], me: { name } | null, signedIn }
// Subscriber (token middleware + the email on the code):
//   GET  /api/comments/me                        → { ok, name, banned }
//   POST /api/comments/me          { name }      → { ok, name } — set / change the display name
//   POST /api/comments/:trackId    { atMs, body }→ { ok, comment } | 409 needsName
//   POST /api/comments/:trackId/react { emoji }  → { ok, on, reactions }
//   POST /api/comments/c/:id/report              → { ok }
//   DELETE /api/comments/c/:id                   → { ok } — your own comment only
// COMMENTS_ENABLED=false turns it all off (404) without a deploy; it also needs Postgres.
import { Router } from 'express';
import { createSwrCache } from '../lib/swr-cache.js';
import { requireTokenEmail } from '../lib/auth.js';
import { normalizeEmail } from '../lib/format.js';
import { tokenValidationCache } from '../cache.js';
import { checkComment, checkDisplayName } from '../lib/comment-filter.js';
import * as store from '../lib/comments-store.js';

const TRACK_RE = /^\d{1,12}$/;               // FileMaker recordIds
const ID_RE = /^\d{1,15}$/;
const PER_PERSON = { max: 10, minutes: 10 }; // on top of the per-IP limiter in server.js
const MAX_AT_MS = 4 * 3600 * 1000;

export function commentsEnabled() {
  return process.env.COMMENTS_ENABLED !== 'false' && store.commentsAvailable();
}

// One SWR entry per song, 3 s fresh (dedupes bursts of listeners on one song). Short on purpose: MAD runs
// several server copies (cluster.js) and a write only clears THIS copy's entry — the others catch up in seconds.
const listSwr = createSwrCache({ ttlMs: 3_000, max: 500, label: 'comments', name: 'comments', loader: (trackId) => store.trackComments(trackId) });
const forget = (trackId) => listSwr.cache.delete(String(trackId));

/** The email of a token-bearing request on a PUBLIC path (no validation — personalising only). */
function optionalEmail(req) {
  const raw = String(req.headers['x-access-token'] || '').trim().toUpperCase();
  if (!raw) return null;
  const cached = tokenValidationCache.get(raw);
  return cached?.data?.email ? normalizeEmail(cached.data.email) : null;
}

const fail = (res, status, error, extra = {}) => res.status(status).json({ ok: false, error, ...extra });
const off = (req, res, next) => (commentsEnabled() ? next() : fail(res, 404, 'Comments are off.', { enabled: false }));

export const publicCommentsRouter = Router();
publicCommentsRouter.use(off);

publicCommentsRouter.get('/:trackId', async (req, res) => {
  const { trackId } = req.params;
  if (!TRACK_RE.test(trackId)) return fail(res, 400, 'Bad track');
  try {
    const { value } = await listSwr.get(trackId);
    const email = optionalEmail(req);
    const [mine, me] = email ? await Promise.all([store.myReactions(trackId, email), store.getAuthor(email)]) : [[], null];
    res.set('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      comments: value.comments.map((c) => ({ id: c.id, atMs: c.atMs, body: c.body, name: c.name, createdAt: c.createdAt, mine: !!email && c.author === email })),
      reactions: value.reactions,
      myReactions: mine,
      me: me ? { name: me.name } : null,
      signedIn: !!email,
    });
  } catch (err) {
    console.error('[comments] list failed:', err?.message);
    fail(res, 502, 'Comments are unavailable right now.');
  }
});

export const commentsRouter = Router();
commentsRouter.use(off);

const who = (req, res) => {
  const user = requireTokenEmail(req, res);
  return user ? normalizeEmail(user.email) : null;
};

commentsRouter.get('/me', async (req, res) => {
  const email = who(req, res); if (!email) return;
  try {
    const a = await store.getAuthor(email);
    res.json({ ok: true, name: a?.name || null, banned: !!a?.banned });
  } catch (err) { console.error('[comments] me failed:', err?.message); fail(res, 502, 'Try again in a moment.'); }
});

commentsRouter.post('/me', async (req, res) => {
  const email = who(req, res); if (!email) return;
  const chk = checkDisplayName(req.body?.name);
  if (!chk.ok) return fail(res, 400, chk.error);
  try {
    const r = await store.setDisplayName(email, chk.name);
    if (!r.ok) return fail(res, 409, 'That name is taken — try another.', { taken: true });
    listSwr.cache.clear();                     // the new name shows on this listener's existing comments
    res.json({ ok: true, name: chk.name });
  } catch (err) { console.error('[comments] name failed:', err?.message); fail(res, 502, 'Try again in a moment.'); }
});

commentsRouter.post('/c/:id/report', async (req, res) => {
  const email = who(req, res); if (!email) return;
  if (!ID_RE.test(req.params.id)) return fail(res, 400, 'Bad comment');
  try {
    const r = await store.reportComment(req.params.id, email);
    if (!r) return fail(res, 404, 'That comment is gone.');
    if (r.hidden) forget(r.trackId);
    res.json({ ok: true });
  } catch (err) { console.error('[comments] report failed:', err?.message); fail(res, 502, 'Try again in a moment.'); }
});

commentsRouter.delete('/c/:id', async (req, res) => {
  const email = who(req, res); if (!email) return;
  if (!ID_RE.test(req.params.id)) return fail(res, 400, 'Bad comment');
  try {
    const trackId = await store.deleteOwnComment(req.params.id, email);
    if (!trackId) return fail(res, 404, 'That comment isn’t yours, or it is already gone.');
    forget(trackId);
    res.json({ ok: true });
  } catch (err) { console.error('[comments] delete failed:', err?.message); fail(res, 502, 'Try again in a moment.'); }
});

commentsRouter.post('/:trackId/react', async (req, res) => {
  const email = who(req, res); if (!email) return;
  const { trackId } = req.params, emoji = String(req.body?.emoji || '');
  if (!TRACK_RE.test(trackId) || !store.REACTIONS.includes(emoji)) return fail(res, 400, 'Bad reaction');
  try {
    const on = await store.toggleReaction(trackId, email, emoji);
    forget(trackId);
    const { value } = await listSwr.get(trackId);
    res.json({ ok: true, on, reactions: value.reactions });
  } catch (err) { console.error('[comments] react failed:', err?.message); fail(res, 502, 'Try again in a moment.'); }
});

commentsRouter.post('/:trackId', async (req, res) => {
  const email = who(req, res); if (!email) return;
  const { trackId } = req.params;
  if (!TRACK_RE.test(trackId)) return fail(res, 400, 'Bad track');
  const atMs = Math.round(Number(req.body?.atMs));
  if (!Number.isFinite(atMs) || atMs < 0 || atMs > MAX_AT_MS) return fail(res, 400, 'Bad moment');
  const chk = checkComment(req.body?.body);
  if (!chk.ok) return fail(res, 400, chk.error, { filtered: true });
  try {
    const author = await store.getAuthor(email);
    if (!author) return fail(res, 409, 'Choose a display name first.', { needsName: true });
    if (author.banned) return fail(res, 403, 'Commenting is switched off for this account.', { banned: true });
    if (await store.recentCount(email, PER_PERSON.minutes) >= PER_PERSON.max) return fail(res, 429, 'Slow down a little — try again in a few minutes.');
    const row = await store.addComment({ trackId, atMs, body: chk.text, email });
    forget(trackId);
    res.json({ ok: true, comment: { id: String(row.id), atMs: row.at_ms, body: row.body, name: author.name, createdAt: row.created_at, mine: true } });
  } catch (err) { console.error('[comments] post failed:', err?.message); fail(res, 502, 'Your comment couldn’t be saved — try again.'); }
});
