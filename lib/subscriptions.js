/**
 * lib/subscriptions.js — keep Paystack monthly subscriptions and their MAD codes in step.
 *
 * WHY (found 2026-09-28): every Paystack subscription code expired after its first month.
 *   1. The subscription link was never saved: the payment callback runs before Paystack has
 *      created the subscription, so every code's Notes say "sub: null".
 *   2. Renewals were looked up by that link in the JSON backup file — which Render wipes on
 *      every deploy — never in FileMaker.
 *   3. A renewal charge without the link fell through to the one-time-payment path and would
 *      have minted a fresh 7-day code instead of extending the subscriber's own.
 * (4. Paystack's webhook signature was also failing — a dashboard/key setting, not code.)
 *
 * NOW: FileMaker is the source of truth and the customer's EMAIL (present on every Paystack
 * event) finds their code; the subscription code, when present, picks between several.
 * Renewing is idempotent — expiry becomes (payment date + billing period + 1 day grace) unless
 * it is already later — so Paystack's duplicate/overlapping events (charge.success AND
 * invoice.update for the same payment, retries) can never stack extra months.
 */
import { fmFindRecords, fmUpdateRecord } from '../fm-client.js';
import { fmExactMatch } from './validators.js';
import { loadAccessTokens, saveAccessTokens } from './token-store.js';

const LAYOUT = () => process.env.FM_TOKENS_LAYOUT || 'API_Access_Tokens';
const DAY = 24 * 60 * 60 * 1000;
const GRACE_DAYS = 1;

// FileMaker timestamps are written and read in server-local time elsewhere in the token code
// (lib/auth.js buildTokenUpdateFields / checkTokenExpired); keep exactly the same convention.
export function fmStamp(d) {
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
export function fmToDate(s) {
  if (!s) return null;
  const offsetMs = Number.parseFloat(process.env.FM_TIMEZONE_OFFSET || '0') * 60 * 60 * 1000;
  const t = new Date(String(s)).getTime() - offsetMs;
  return Number.isNaN(t) ? null : new Date(t);
}
const issued = (rec) => fmToDate(rec.fieldData?.Issued_Date)?.getTime() || 0;

/** Pull what we need out of any Paystack subscription-related event, wherever it sits. */
export function readEvent(event) {
  const d = event?.data || {};
  const plan = (d.plan && typeof d.plan === 'object') ? d.plan : null;
  return {
    type: event?.event || '',
    email: String(d.customer?.email || d.email || '').trim().toLowerCase() || null,
    subscriptionCode: d.subscription_code || d.subscription?.subscription_code || null,
    planCode: plan?.plan_code || (typeof d.plan === 'string' && d.plan.startsWith('PLN_') ? d.plan : null) || d.subscription?.plan?.plan_code || null,
    interval: plan?.interval || d.plan_object?.interval || d.subscription?.plan?.interval || 'monthly',
    reference: d.reference || d.transaction?.reference || null,
    paidAt: d.paid_at || d.paidAt || d.transaction?.paid_at || null,
    paid: d.paid === true || d.status === 'success' || d.transaction?.status === 'success',
  };
}

/** Is this charge.success part of a subscription (vs a one-time pass or download)? */
export const isSubscriptionCharge = (info) => !!(info.subscriptionCode || info.planCode);

/**
 * The customer's subscription code record in FileMaker: by email (every event has it), preferring
 * the one already linked to this subscription code, else the most recently issued. Null if none.
 */
export async function findSubscriptionRecord({ email, subscriptionCode }) {
  if (!email) return null;
  const r = await fmFindRecords(LAYOUT(), [{ Email: fmExactMatch(email), Token_Type: fmExactMatch('subscription') }], { limit: 50 });
  if (!r.ok) {
    if (String(r.code) === '401') return null;          // no records match
    throw new Error(`FM subscription lookup failed: ${r.msg || r.status}`);
  }
  const rows = [...(r.data || [])].sort((a, b) => issued(b) - issued(a));
  if (subscriptionCode) {
    const linked = rows.find((x) => String(x.fieldData?.Notes || '').includes(subscriptionCode));
    if (linked) return linked;
  }
  return rows[0] || null;
}

async function mirrorJson(code, patch) {
  try {
    const data = await loadAccessTokens();
    const t = data.tokens.find((x) => x.code === code);
    if (t) { Object.assign(t, patch); await saveAccessTokens(data); }
  } catch (err) { console.warn('[MASS] subscription JSON mirror failed:', err?.message || err); }
}

/** Record the Paystack subscription code on the MAD code (replaces the old "sub: null"). */
export async function linkSubscription(rec, subscriptionCode) {
  const notes = String(rec.fieldData?.Notes || '');
  if (!subscriptionCode || notes.includes(subscriptionCode)) return false;
  const next = notes.includes('sub: null') ? notes.replace('sub: null', `sub: ${subscriptionCode}`) : `${notes} [sub: ${subscriptionCode}]`.trim();
  await fmUpdateRecord(LAYOUT(), rec.recordId, { Notes: next });
  rec.fieldData.Notes = next;
  await mirrorJson(rec.fieldData.Token_Code, { subscriptionCode });
  console.log(`[MASS] Subscription ${subscriptionCode} linked to ${rec.fieldData.Token_Code}`);
  return true;
}

/**
 * A paid month: expiry → payment date + billing days + 1 day grace, unless already later.
 * Idempotent by construction. Before first use (no First_Used) the stamped expiry doesn't exist
 * yet, so the duration is widened instead.
 */
export async function extendSubscription(rec, { billingDays = 31, paidAt = null, reference = null } = {}) {
  const f = rec.fieldData || {};
  const paid = paidAt ? new Date(paidAt) : new Date();
  const base = Number.isNaN(paid.getTime()) ? new Date() : paid;
  const target = new Date(base.getTime() + (billingDays + GRACE_DAYS) * DAY);
  const today = new Date().toISOString().slice(0, 10);
  const note = `[renewed ${today}${reference ? ' ref ' + reference : ''}]`;
  const update = { Active: 1 };

  if (!f.First_Used) {
    const wantSeconds = Math.ceil((target.getTime() - Date.now()) / 1000);
    if (wantSeconds <= (Number.parseInt(f.Token_Duration_Hours, 10) || 0)) return { changed: false, code: f.Token_Code };
    update.Token_Duration_Hours = String(wantSeconds);   // seconds, despite the name
  } else {
    const current = fmToDate(f.Expiration_Date);
    if (current && current.getTime() >= target.getTime() - 60_000) return { changed: false, code: f.Token_Code };
    const offsetMs = Number.parseFloat(process.env.FM_TIMEZONE_OFFSET || '0') * 60 * 60 * 1000;
    update.Expiration_Date = fmStamp(new Date(target.getTime() + offsetMs));
  }
  if (!String(f.Notes || '').includes(reference || '\u0000')) update.Notes = `${f.Notes || ''} ${note}`.trim();
  await fmUpdateRecord(LAYOUT(), rec.recordId, update);
  Object.assign(rec.fieldData, update);
  await mirrorJson(f.Token_Code, { expirationDate: target.toISOString() });
  console.log(`[MASS] Subscription code ${f.Token_Code} renewed to ${target.toISOString()} (${reference || 'no ref'})`);
  return { changed: true, code: f.Token_Code, expires: target.toISOString() };
}

/** Cancelled: they keep what they paid for; access simply ends at the current expiry. */
export async function noteCancelled(rec, why = 'cancelled') {
  const today = new Date().toISOString().slice(0, 10);
  const notes = String(rec.fieldData?.Notes || '');
  if (notes.includes(`[${why} ${today}]`)) return;
  await fmUpdateRecord(LAYOUT(), rec.recordId, { Notes: `${notes} [${why} ${today}]`.trim() });
}
