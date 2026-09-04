/**
 * lib/account-delete.js — permanent account deletion, initiated by the account holder.
 *
 * Apple Guideline 5.1.1(v) requires an app that lets people create an account to
 * let them delete it from inside the app. A support address is explicitly not
 * enough, and neither is signing out. We create accounts (`POST /api/payments/trial`
 * mints a token against an email), so the obligation applies.
 *
 * A MAD "account" is an EMAIL. There is no username and no password; the access
 * token is the credential and the email is the identity everything else hangs off:
 *
 *   API_Access_Tokens   Email / Issued_To   the account itself
 *   API_Playlists       User_Email          the user's playlists
 *   API_Library         User_Email          saved albums and songs
 *   Stream_Events       Email, Token_Number listening history (+ ClientIP, UserAgent)
 *
 * Three deliberate decisions:
 *
 * 1. **Token rows are scrubbed, not deleted.** Deleting the row would hand back a
 *    fresh 7-day trial to anyone who deletes their account — reopening exactly the
 *    abuse closed on 2026-08-27. So the row survives with its identifying fields
 *    emptied and an `account-deleted h:<fingerprint>` marker in Notes; the
 *    fingerprint is a SHA-256 of the canonical mailbox, which lets the trial check
 *    still recognise a returning address without storing the address. Retaining a
 *    one-way hash for fraud prevention is a purpose Apple's own guidance allows.
 *
 * 2. **Stream_Events are anonymised, not deleted.** They are the play record behind
 *    usage reporting; deleting them would silently rewrite history. Stripping the
 *    email, token, IP and user-agent leaves an event that is no longer about a
 *    person. It runs in the background because a heavy listener can have thousands
 *    of rows and FileMaker updates them one at a time.
 *
 * 3. **Purchases are kept.** API_Download_Purchases and API_Ringtone_Purchases are
 *    financial records with their own retention obligations. The confirmation
 *    screen says so plainly rather than quietly making an exception.
 *
 * Every FileMaker write here is read back. Writing a field that is not on the API
 * layout is silently discarded by the Data API — telling somebody their account was
 * deleted when the write evaporated would be the worst possible failure here.
 */
import { createHash } from 'node:crypto';
import {
  fmFindRecords, fmUpdateRecord, fmDeleteRecord, fmGetRecordById
} from '../fm-client.js';
import { fmExactMatch, canonicalizeEmail } from './validators.js';
import { FM_STREAM_EVENTS_LAYOUT } from './fm-fields.js';
import { loadAccessTokens, saveAccessTokens } from './token-store.js';

const TOKENS_LAYOUT    = () => process.env.FM_TOKENS_LAYOUT    || 'API_Access_Tokens';
const PLAYLISTS_LAYOUT = () => process.env.FM_PLAYLISTS_LAYOUT || 'API_Playlists';
const LIBRARY_LAYOUT   = () => process.env.FM_LIBRARY_LAYOUT   || 'API_Library';

export const DELETION_MARKER = 'account-deleted';

/** Rows to touch in one pass. A backstop, not an expected ceiling. */
const MAX_ROWS = { tokens: 50, playlists: 500, library: 50, streamEvents: 20000 };

/**
 * One-way fingerprint of a mailbox, canonicalised first so `i.osrin+2@gmail.com`
 * and `ianosrin@gmail.com` produce the same value — the same collapsing the trial
 * dedupe already does.
 */
export function emailFingerprint(email) {
  const canon = canonicalizeEmail(email || '');
  if (!canon) return '';
  return createHash('sha256').update(canon).digest('hex').slice(0, 32);
}

/** FM find that treats "no records match" as an empty result, not an error. */
async function findRows(layout, queries, limit) {
  const r = await fmFindRecords(layout, queries, { limit });
  if (r.ok) return r.data;
  if (String(r.code) === '401') return [];          // 401 = no matching records
  throw new Error(`FM find on ${layout} failed: ${r.msg || r.status}`);
}

/** Both spellings of a mailbox, so a row written before canonicalisation matches. */
function emailQueries(email, field) {
  const normalised = String(email || '').trim().toLowerCase();
  const canon      = canonicalizeEmail(normalised);
  const queries    = [{ [field]: fmExactMatch(normalised) }];
  if (canon && canon !== normalised) queries.push({ [field]: fmExactMatch(canon) });
  return queries;
}

/**
 * Token rows for a mailbox, across both field spellings.
 *
 * The layout carries `Issued_To`, or `Email`, or both — lib/auth.js reads
 * whichever is there. A find against a field the layout does NOT have is a hard
 * FileMaker error (102, "field is missing"), not an empty result, so searching
 * one name and hoping would abort the whole deletion on half the layouts. Try
 * both, keep whatever answers, and only complain if neither field exists at all.
 */
async function findTokenRowsByEmail(email) {
  const byId = new Map();
  let anyFieldWorked = false;
  for (const field of ['Email', 'Issued_To']) {
    try {
      for (const row of await findRows(TOKENS_LAYOUT(), emailQueries(email, field), MAX_ROWS.tokens)) {
        byId.set(row.recordId, row);
      }
      anyFieldWorked = true;
    } catch (err) {
      // 102 = the layout has no such field. Anything else is a real failure and
      // must not be mistaken for "this account has no tokens".
      if (!/\(102\)|field is missing/i.test(err?.message || '')) throw err;
    }
  }
  if (!anyFieldWorked) {
    throw new Error('FM_TOKENS_LAYOUT exposes neither Email nor Issued_To — cannot identify the account');
  }
  return [...byId.values()];
}

/**
 * What deletion would remove. Read-only — safe to call from a confirmation screen,
 * and the numbers are what make the confirmation meaningful rather than a shrug.
 */
export async function summariseAccount({ email, tokenCode }) {
  const out = { email: email || null, tokens: 0, playlists: 0, library: 0, streamEvents: 0 };
  if (!email) {
    // A token that was never claimed by an email: the token row IS the account.
    out.tokens = tokenCode ? 1 : 0;
    return out;
  }
  const [tokens, playlists, library, events] = await Promise.all([
    findTokenRowsByEmail(email).catch(() => []),
    findRows(PLAYLISTS_LAYOUT(), emailQueries(email, 'User_Email'), MAX_ROWS.playlists).catch(() => []),
    findRows(LIBRARY_LAYOUT(),   emailQueries(email, 'User_Email'), MAX_ROWS.library).catch(() => []),
    findRows(FM_STREAM_EVENTS_LAYOUT, emailQueries(email, 'Email'), 1).catch(() => []),
  ]);
  out.tokens       = tokens.length;
  out.playlists    = playlists.length;
  out.library      = library.length;
  out.streamEvents = events.length ? 'some' : 0;
  return out;
}

/** FM 301 = record locked by another client. Brief; worth a few retries. */
async function updateWithLockRetry(layout, recordId, fields) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try { await fmUpdateRecord(layout, recordId, fields); return; }
    catch (err) {
      lastErr = err;
      if (!/\(301\)/.test(err?.message || '') || attempt === 4) break;
      await sleep(250 * attempt);
    }
  }
  throw lastErr;
}

/**
 * Empty the identifying fields on one token row and stamp the marker.
 *
 * Which email field exists varies by layout — lib/auth.js reads both `Issued_To`
 * and `Email`, so we write only the ones the record actually has (the same
 * detection routes/access.js does in the email-claim flow). Writing a field that
 * is not on the layout is rejected outright; writing one that is on the layout but
 * absent from the record is silently dropped.
 */
async function scrubTokenRow(row, fingerprint) {
  const layout    = TOKENS_LAYOUT();
  const fieldData = row.fieldData || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(fieldData, k);

  const fields = { Active: 0 };
  if (has('Issued_To')) fields.Issued_To = '';
  if (has('Email'))     fields.Email     = '';
  for (const k of ['Current_Session_ID', 'Session_Device_Info', 'Session_IP', 'Session_Last_Activity']) {
    if (has(k)) fields[k] = '';
  }
  if (has('Notes')) {
    const existing = String(fieldData.Notes || '').trim();
    const stamp    = `${DELETION_MARKER} ${new Date().toISOString().slice(0, 10)} h:${fingerprint}`;
    fields.Notes   = existing ? `${existing} | ${stamp}` : stamp;
  }

  await updateWithLockRetry(layout, row.recordId, fields);

  // Read back: a silently-discarded write must not be reported as a deletion.
  const after = await fmGetRecordById(layout, row.recordId).catch(() => null);
  const af    = after?.fieldData || {};
  const stillNamed = String(af.Issued_To || af.Email || '').trim();
  if (stillNamed) {
    throw new Error(`token row ${row.recordId} still carries an email after scrub — check FM_TOKENS_LAYOUT`);
  }
  return true;
}

/**
 * Strip the person out of the play record, a page at a time. Returns counts.
 * Deliberately tolerant: a row that will not update is logged and skipped rather
 * than aborting the run, because a partial anonymisation still beats none.
 */
export async function anonymiseStreamEvents(email, fingerprint, { max = MAX_ROWS.streamEvents } = {}) {
  const layout  = FM_STREAM_EVENTS_LAYOUT;
  const queries = emailQueries(email, 'Email');
  let scrubbed = 0, failed = 0;

  // Each pass re-runs the find: the rows just scrubbed no longer match, so the
  // first page is always the next batch of work. That terminates naturally when
  // nothing matches, and cannot loop forever on a row that refuses to update
  // because `failed` rows stop the run.
  while (scrubbed < max) {
    const rows = await findRows(layout, queries, 100).catch(() => []);
    if (!rows.length) break;
    let progressed = false;
    for (const row of rows) {
      const f = row.fieldData || {};
      const fields = {};
      if ('Email' in f)        fields.Email        = `deleted:${fingerprint}`;
      if ('Token_Number' in f) fields.Token_Number = '';
      if ('ClientIP' in f)     fields.ClientIP     = '';
      if ('UserAgent' in f)    fields.UserAgent    = '';
      try {
        await updateWithLockRetry(layout, row.recordId, fields);
        scrubbed++; progressed = true;
      } catch (err) {
        failed++;
        console.warn(`[MASS] account-delete: stream event ${row.recordId} not anonymised:`, err?.message || err);
      }
      if (scrubbed >= max) break;
    }
    // Nothing in a whole page could be updated — stop rather than spin.
    if (!progressed) break;
  }
  return { scrubbed, failed };
}

/** Drop the account's tokens from the JSON store that shadows FileMaker. */
async function scrubLocalTokenStore(email) {
  const canon = canonicalizeEmail(email);
  if (!canon) return 0;
  const data   = await loadAccessTokens();
  const before = data.tokens.length;
  data.tokens  = data.tokens.filter(t => !(t.email && canonicalizeEmail(t.email) === canon));
  const removed = before - data.tokens.length;
  if (removed) await saveAccessTokens(data);
  return removed;
}

/**
 * Delete the account. Everything bounded and fast happens here and is reported
 * truthfully; the long tail (listening history) is returned as a promise the
 * caller can leave running.
 *
 * @param {{email: string|null, tokenCode: string}} account
 * @returns {Promise<{ok, email, tokensScrubbed, playlistsDeleted, libraryDeleted,
 *                    localTokensRemoved, fingerprint, streamEvents: Promise}>}
 */
export async function deleteAccount({ email, tokenCode }) {
  const normalised = String(email || '').trim().toLowerCase();
  const code       = String(tokenCode || '').trim().toUpperCase();
  if (!normalised && !code) {
    throw Object.assign(new Error('An account is identified by an email or a token'), { status: 400 });
  }
  const fingerprint = normalised ? emailFingerprint(normalised) : '';

  // ── Token rows: the account itself ────────────────────────────────────────
  const tokenRows = normalised ? await findTokenRowsByEmail(normalised) : [];
  // A token claimed by nobody has no email to find it by, and an Issued_To-only
  // layout will not match an `Email` query either — look the caller's own token
  // up directly so it is always covered.
  if (code) {
    const own = await findRows(TOKENS_LAYOUT(), [{ Token_Code: fmExactMatch(code) }], 1);
    for (const row of own) {
      if (!tokenRows.some(r => r.recordId === row.recordId)) tokenRows.push(row);
    }
  }

  let tokensScrubbed = 0;
  for (const row of tokenRows) {
    await scrubTokenRow(row, fingerprint);
    tokensScrubbed++;
  }

  // ── User content: deleted outright ────────────────────────────────────────
  let playlistsDeleted = 0, libraryDeleted = 0;
  if (normalised) {
    for (const row of await findRows(PLAYLISTS_LAYOUT(), emailQueries(normalised, 'User_Email'), MAX_ROWS.playlists)) {
      try { await fmDeleteRecord(PLAYLISTS_LAYOUT(), row.recordId); playlistsDeleted++; }
      catch (err) { console.warn('[MASS] account-delete: playlist not deleted:', err?.message || err); }
    }
    for (const row of await findRows(LIBRARY_LAYOUT(), emailQueries(normalised, 'User_Email'), MAX_ROWS.library)) {
      try { await fmDeleteRecord(LIBRARY_LAYOUT(), row.recordId); libraryDeleted++; }
      catch (err) { console.warn('[MASS] account-delete: library row not deleted:', err?.message || err); }
    }
  }

  const localTokensRemoved = normalised ? await scrubLocalTokenStore(normalised).catch(() => 0) : 0;

  // ── Listening history: handed back still running ──────────────────────────
  const streamEvents = normalised
    ? anonymiseStreamEvents(normalised, fingerprint)
        .then((r) => { console.log(`[MASS] account-delete: anonymised ${r.scrubbed} stream events (${r.failed} failed)`); return r; })
        .catch((err) => { console.error('[MASS] account-delete: stream-event anonymisation failed:', err?.message || err); return { scrubbed: 0, failed: -1 }; })
    : Promise.resolve({ scrubbed: 0, failed: 0 });

  return {
    ok: true, email: normalised || null, fingerprint,
    tokensScrubbed, playlistsDeleted, libraryDeleted, localTokensRemoved, streamEvents,
  };
}

/**
 * Has this mailbox deleted an account before? Used by the trial check so a
 * delete-and-retry cannot mint a second free trial. Matches the fingerprint in
 * Notes — FileMaker text finds are substring by default, which is what we want.
 */
export async function wasAccountDeleted(email) {
  const fp = emailFingerprint(email);
  if (!fp) return false;
  const rows = await findRows(TOKENS_LAYOUT(), [{ Notes: `h:${fp}` }], 1);
  return rows.length > 0;
}
