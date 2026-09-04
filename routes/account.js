/**
 * routes/account.js — the account holder's own view of their account, and the
 * button that deletes it.
 *
 * Not in server.js's auth skip-list, so every route here already carries a
 * validated `req.accessToken` ({ code, email, ... }). That is the whole
 * authentication story: you can only delete the account whose token you hold.
 *
 * Apple Guideline 5.1.1(v) — see lib/account-delete.js for what "delete" covers
 * and, more importantly, what it deliberately does not.
 */
import express from 'express';
import { summariseAccount, deleteAccount } from '../lib/account-delete.js';
import { tokenValidationCache } from '../cache.js';

const router = express.Router();

/** What is about to be deleted. Read-only; drives the confirmation screen. */
router.get('/', async (req, res) => {
  try {
    const summary = await summariseAccount({
      email: req.accessToken?.email || null,
      tokenCode: req.accessToken?.code || '',
    });
    res.json({ ok: true, account: summary });
  } catch (err) {
    console.error('[MASS] /api/account summary failed:', err?.message || err);
    res.status(502).json({ ok: false, error: 'Could not read your account right now' });
  }
});

/**
 * Delete the account.
 *
 * POST, with an explicit `confirm: "DELETE"` in the body. The confirmation is
 * not security — the token already provides that — it is there so no stray
 * fetch, retry or prefetch can ever destroy an account by accident.
 */
router.post('/delete', async (req, res) => {
  const confirm = String(req.body?.confirm || '').trim().toUpperCase();
  if (confirm !== 'DELETE') {
    return res.status(400).json({
      ok: false,
      error: 'Deletion must be confirmed',
      detail: 'Send { "confirm": "DELETE" }',
    });
  }

  const email     = req.accessToken?.email || null;
  const tokenCode = req.accessToken?.code || '';

  try {
    const result = await deleteAccount({ email, tokenCode });

    // The token is dead in FileMaker now, but the validation cache would keep
    // honouring it for up to TOKEN_CACHE_TTL_MS. Evict it so the very next
    // request is refused — a deleted account must not keep browsing.
    if (tokenCode) tokenValidationCache.delete(tokenCode.trim().toUpperCase());

    console.log(`[MASS] Account deleted: ${email || '(token only)'} — ` +
      `${result.tokensScrubbed} token(s), ${result.playlistsDeleted} playlist(s), ` +
      `${result.libraryDeleted} library row(s)`);

    // Listening history keeps anonymising after the response. Deliberately not
    // awaited: it can run to thousands of FileMaker updates, and the account is
    // already unusable by the time we answer.
    result.streamEvents?.catch?.(() => {});

    res.json({
      ok: true,
      deleted: {
        tokens:    result.tokensScrubbed,
        playlists: result.playlistsDeleted,
        library:   result.libraryDeleted,
      },
      // Said plainly so the app can show it rather than imply everything vanished.
      retained: 'Purchase records are kept as financial records. Listening history is being anonymised.',
    });
  } catch (err) {
    console.error('[MASS] Account deletion FAILED:', err?.message || err);
    res.status(err?.status || 502).json({
      ok: false,
      error: 'We could not complete the deletion. Nothing partial has been reported as done — please try again, or email info@musicafricadirect.com.',
    });
  }
});

export default router;
