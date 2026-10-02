/**
 * lib/mixer-trial.js — the Mad Mixer free split (2026-09-28), shared by the in-MAD routes
 * (routes/mixer.js → /api/mixer/trial…) and the signed internal routes Mad Mixer on Vercel calls
 * (routes/mixer-internal.js → /internal/mixer/trial…). Moved out of routes/mixer.js 2026-10-02.
 *
 * One free split per email. Sign-up gives a Mixer-only code at once (browse, play, mix); the
 * split itself unlocks when the email is confirmed (each split costs MVSEP credits, so an
 * invented address gets no split). Confirmation = "[email confirmed" in the FM token's Notes
 * (Notes is already on the API layout), mirrored in the JSON copy.
 *
 * The email's two links depend on where Mad Mixer lives:
 *   madTrialLinks(code)              → APP_URL/api/mixer/trial/confirm?t=…&s=… and APP_URL/mixer?code=…
 *                                      (Mad Mixer inside MAD, today)
 *   mixerTrialLinks(code, MIXER_URL) → MIXER_URL/#confirm=CODE.SIG and MIXER_URL/#code=CODE
 *                                      (Mad Mixer on its own host: fragments, so the code never
 *                                      reaches a server log or a Referer)
 */
import crypto from 'node:crypto';
import { fmFindRecords, fmUpdateRecord } from '../fm-client.js';
import { MIXER_TRIAL_TYPE, MIXER_TRIAL_DAYS } from './mixer-plans.js';
import { createAccessToken, findTrialTokenByEmail, findTrialTokenInFM, revokeToken, loadAccessTokens, saveAccessTokens } from './token-store.js';
import { sendMixerTrialEmail, emailTransporter } from './email.js';
import { isStrictEmail, fmExactMatch } from './validators.js';
import { timingSafeEqualStr } from './crypto-utils.js';

const TOKENS_LAYOUT = () => process.env.FM_TOKENS_LAYOUT || 'API_Access_Tokens';
export const APP_BASE_URL = () => (process.env.APP_URL || 'https://musicafricadirect.com').replace(/\/+$/, '');
const shortCode = (code) => `${String(code || '').slice(0, 8)}…`;

export const trialSig = (code) => crypto.createHmac('sha256', process.env.AUTH_SECRET || '')
  .update(`mixer-trial-confirm:${code}`).digest('base64url').slice(0, 32);

export const madTrialLinks = (code) => ({
  confirmUrl: `${APP_BASE_URL()}/api/mixer/trial/confirm?t=${encodeURIComponent(code)}&s=${trialSig(code)}`,
  openUrl: `${APP_BASE_URL()}/mixer?code=${encodeURIComponent(code)}`,
});

export const mixerTrialLinks = (code, mixerUrl) => {
  const base = String(mixerUrl || '').replace(/\/+$/, '');
  return {
    confirmUrl: `${base}/#confirm=${encodeURIComponent(code)}.${trialSig(code)}`,
    openUrl: `${base}/#code=${encodeURIComponent(code)}`,
  };
};

export async function trialConfirmed(code) {
  const c = String(code || '').trim().toUpperCase();
  try {
    const r = await fmFindRecords(TOKENS_LAYOUT(), [{ Token_Code: fmExactMatch(c) }], { limit: 1 });
    if (r.ok && r.data?.length) return /\[email confirmed/.test(String(r.data[0].fieldData?.Notes || ''));
  } catch { /* fall back to the JSON copy */ }
  const local = (await loadAccessTokens()).tokens.find((t) => t.code === c);
  return !!local?.emailConfirmed;
}

/**
 * Issue a free-split code and email it. `links(code)` → { confirmUrl, openUrl } for the email.
 * Returns { ok: true, code } or { ok: false, status, error } (400 bad email, 503 no email
 * service, 409 this email already had one, 502 the email failed — the code is revoked, 500).
 */
export async function startTrial({ email, links }) {
  const addr = String(email || '').trim().toLowerCase();
  if (!isStrictEmail(addr)) return { ok: false, status: 400, error: 'Please enter a valid email address.' };
  if (!emailTransporter) return { ok: false, status: 503, error: 'Free splits are unavailable right now. Please try again later.' };
  try {
    const already = (await findTrialTokenByEmail(addr, MIXER_TRIAL_TYPE)) ||
      (await findTrialTokenInFM(addr, MIXER_TRIAL_TYPE).catch((err) => { console.warn('[mixer] trial FM dedupe failed:', err.message); return null; }));
    if (already) return { ok: false, status: 409, error: 'This email has already had its free split. Sign in with your code, or subscribe.' };

    const token = await createAccessToken(MIXER_TRIAL_DAYS, 'Mad Mixer free split (1 split, unlocks when the email is confirmed)', addr, MIXER_TRIAL_TYPE);
    try {
      await sendMixerTrialEmail(addr, token.code, links(token.code));
    } catch {
      await revokeToken(token.code, 'mixer trial email delivery failed');
      return { ok: false, status: 502, error: 'We could not send the email. Please check the address and try again.' };
    }
    console.log(`[mixer] free split issued: ${shortCode(token.code)} → ${addr}`);
    return { ok: true, code: token.code };
  } catch (err) {
    console.error('[mixer] free split signup failed:', err?.message || err);
    return { ok: false, status: 500, error: 'Could not start your free split. Please try again.' };
  }
}

/**
 * The email's Confirm link. Returns { ok: true, code } (confirmed now or already), or
 * { ok: false, reason } with reason 'bad-link' (malformed / forged), 'ended' (no such active
 * free-split code) or 'error' (FileMaker unreachable — try again).
 */
export async function confirmTrial(code, sig) {
  const c = String(code || '').trim().toUpperCase();
  const s = String(sig || '');
  if (!/^[A-Z0-9-]{6,40}$/.test(c) || !s || !timingSafeEqualStr(s, trialSig(c))) return { ok: false, reason: 'bad-link' };
  try {
    const r = await fmFindRecords(TOKENS_LAYOUT(), [{ Token_Code: fmExactMatch(c) }], { limit: 1 });
    const rec = r.ok ? r.data?.[0] : null;
    const f = rec?.fieldData || {};
    if (!rec || f.Token_Type !== MIXER_TRIAL_TYPE || String(f.Active) !== '1') return { ok: false, reason: 'ended' };
    if (!/\[email confirmed/.test(String(f.Notes || ''))) {
      await fmUpdateRecord(TOKENS_LAYOUT(), rec.recordId, { Notes: `${f.Notes || ''} [email confirmed ${new Date().toISOString().slice(0, 10)}]`.trim() });
      const data = await loadAccessTokens();
      const local = data.tokens.find((t) => t.code === c);
      if (local) { local.emailConfirmed = true; await saveAccessTokens(data); }
      console.log(`[mixer] free split confirmed: ${shortCode(c)}`);
    }
    return { ok: true, code: c };
  } catch (err) {
    console.error('[mixer] free split confirm failed:', err?.message || err);
    return { ok: false, reason: 'error' };
  }
}
