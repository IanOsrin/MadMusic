/**
 * lib/trial-reminders.js — "your trial ends tomorrow" / "your trial has ended" emails.
 *
 * WHY (Ian, 2026-09-29): the store apps may not say where to buy, so an app listener only learns
 * how to keep listening from us, by email. Checked hourly on ONE process (see startTrialReminders).
 *
 * WHO gets what — trials only (Token_Type trial, Active 1), stamped Expiration_Date (= in use):
 *   ending             confirmed trial (full week) ending within the next ~day
 *   ended              trial ended in the last 3 days
 *   ended-unconfirmed  the 1-day unconfirmed trial ended — the email carries the Confirm link,
 *                      which still extends it (lib/token-store.js confirmTrialToken)
 * Never to someone whose email already holds a live paid code.
 *
 * ONCE EACH: a "[trial-reminder <kind> <date>]" note is written on the FileMaker record BEFORE the
 * email goes, so a crash or an overlapping run can't send it twice (at most once, by design — a
 * missed reminder is better than a repeated one). Both sites share one FileMaker, so only the live
 * site switches this on (TRIAL_REMINDERS_ENABLED=true); TRIAL_REMINDERS_DRY_RUN=true logs who would
 * be emailed and changes nothing.
 */
import { fmFindAll, fmFindRecords, fmUpdateRecord } from '../fm-client.js';
import { fmExactMatch } from './validators.js';
import { fmStamp, fmToDate } from './subscriptions.js';
import { PAYSTACK_PLANS, PAYSTACK_SUBSCRIPTION_PLAN } from './paystack.js';
import { sendTrialReminderEmail } from './email.js';
import { trialConfirmUrl } from './trial-links.js';

const LAYOUT = () => process.env.FM_TOKENS_LAYOUT || 'API_Access_Tokens';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FULL_TRIAL_SECONDS = 3 * 24 * 60 * 60;   // anything a confirmed (7-day) trial has; unconfirmed = 1 day
export const ENDING_WINDOW_MS = 30 * HOUR;      // "ends tomorrow": expiry within the next 30 hours…
export const ENDING_MIN_MS = 2 * HOUR;          // …but not in the last 2 (too late to be useful)
export const ENDED_WINDOW_MS = 3 * DAY;         // "has ended": within the last 3 days
const MAX_PER_RUN = 60;                         // a backstop against a bad query emailing everyone

const offsetMs = () => Number.parseFloat(process.env.FM_TIMEZONE_OFFSET || '0') * HOUR;
/** A UTC instant as FileMaker stores token timestamps (same convention as lib/auth.js). */
const toFm = (ms) => fmStamp(new Date(ms + offsetMs()));
const marker = (kind) => `[trial-reminder ${kind}`;

/** What (if anything) this trial record is due, at `now`. Pure — unit-tested. */
export function reminderKind(fieldData, now = Date.now()) {
  const f = fieldData || {};
  if (String(f.Token_Type) !== 'trial' || String(f.Active) !== '1' || !f.Email) return null;
  const expires = fmToDate(f.Expiration_Date)?.getTime();
  if (!expires) return null;
  const notes = String(f.Notes || '');
  const confirmed = (Number.parseInt(f.Token_Duration_Hours, 10) || 0) >= FULL_TRIAL_SECONDS;
  const left = expires - now;
  if (left > ENDING_MIN_MS && left <= ENDING_WINDOW_MS) {
    return confirmed && !notes.includes(marker('ending')) ? 'ending' : null;
  }
  if (left <= 0 && -left <= ENDED_WINDOW_MS && !notes.includes(marker('ended'))) {
    return confirmed ? 'ended' : 'ended-unconfirmed';
  }
  return null;
}

/** "tomorrow at 14:30" / "today at 14:30" / "on Friday 3 October at 14:30", South African time. */
export function endsText(expiresMs, now = Date.now()) {
  const tz = 'Africa/Johannesburg';
  const day = (ms) => new Date(ms).toLocaleDateString('en-ZA', { timeZone: tz });
  const time = new Date(expiresMs).toLocaleTimeString('en-ZA', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  if (day(expiresMs) === day(now)) return `today at ${time}`;
  if (day(expiresMs) === day(now + DAY)) return `tomorrow at ${time}`;
  const date = new Date(expiresMs).toLocaleDateString('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' });
  return `on ${date} at ${time}`;
}

/** Does this email already hold a live code that includes streaming? Then don't nag. */
async function hasPaidAccess(email, now) {
  const queries = ['valid', 'subscription', 'combined']
    .map((type) => ({ Email: fmExactMatch(email), Token_Type: fmExactMatch(type), Active: '1' }));
  const r = await fmFindRecords(LAYOUT(), queries, { limit: 20 });
  if (!r.ok) {
    if (String(r.code) === '401') return false;   // none found
    throw new Error(`paid-code lookup failed: ${r.msg || r.status}`);
  }
  return r.data.some(({ fieldData: f }) => {
    if (!f.Expiration_Date) return true;           // bought but not used yet — still theirs
    const exp = fmToDate(f.Expiration_Date)?.getTime();
    return !exp || exp > now;
  });
}

function prices() {
  const monthly = /R\s?\d/.test(PAYSTACK_SUBSCRIPTION_PLAN.display || '') ? PAYSTACK_SUBSCRIPTION_PLAN.display : null;
  const plans = Object.values(PAYSTACK_PLANS).map((pl) => ({ label: pl.label, display: pl.display }));
  return { plans, monthly };
}

/**
 * One pass. Returns a summary; `dryRun` finds and classifies but writes and sends nothing.
 */
export async function runTrialReminders({ dryRun = false, now = Date.now(), log = console } = {}) {
  const from = now - ENDED_WINDOW_MS;
  const to = now + ENDING_WINDOW_MS;
  const found = await fmFindAll(LAYOUT(), [{
    Token_Type: fmExactMatch('trial'),
    Active: '1',
    Expiration_Date: `${toFm(from)}...${toFm(to)}`,
  }], { pageSize: 200, maxRecords: 2000 });
  if (!found.ok) {
    if (String(found.code) === '401') return { checked: 0, due: [], sent: 0, skipped: 0 };
    throw new Error(`trial lookup failed: ${found.msg || found.status}`);
  }

  const due = found.data
    .map((rec) => ({ rec, kind: reminderKind(rec.fieldData, now) }))
    .filter((x) => x.kind);
  const summary = { checked: found.data.length, due: [], sent: 0, skipped: 0, failed: 0 };
  const { plans, monthly } = prices();

  for (const { rec, kind } of due.slice(0, MAX_PER_RUN)) {
    const f = rec.fieldData;
    const email = String(f.Email).trim().toLowerCase();
    const expires = fmToDate(f.Expiration_Date).getTime();
    if (await hasPaidAccess(email, now)) {
      summary.skipped += 1;
      log.log(`[MASS] Trial reminder: ${f.Token_Code} skipped — ${email} already has paid access`);
      continue;
    }
    summary.due.push({ code: f.Token_Code, email, kind, expires: new Date(expires).toISOString() });
    if (dryRun) continue;

    const today = new Date(now).toISOString().slice(0, 10);
    await fmUpdateRecord(LAYOUT(), rec.recordId, { Notes: `${f.Notes || ''} ${marker(kind)} ${today}]`.trim() });
    try {
      await sendTrialReminderEmail(email, {
        kind,
        tokenCode: f.Token_Code,
        endsText: endsText(expires, now),
        confirmUrl: kind === 'ended-unconfirmed' ? trialConfirmUrl(f.Token_Code) : null,
        plans, monthly,
      });
      summary.sent += 1;
    } catch (err) {
      summary.failed += 1;
      log.error(`[MASS] ⚠️  Trial reminder (${kind}) to ${email} failed: ${err?.message || err}`);
    }
  }
  if (due.length > MAX_PER_RUN) log.warn(`[MASS] Trial reminders: ${due.length} due, capped at ${MAX_PER_RUN} this run — the rest go next hour`);
  return summary;
}

/**
 * Hourly, on the first worker only. Off unless TRIAL_REMINDERS_ENABLED=true — set it on the LIVE
 * service only: the test site shares the same FileMaker and would double up.
 */
export function startTrialReminders() {
  if (process.env.TRIAL_REMINDERS_ENABLED !== 'true') return false;
  if ((process.env.WORKER_INDEX ?? '0') !== '0') return false;
  const dryRun = process.env.TRIAL_REMINDERS_DRY_RUN === 'true';
  const run = () => runTrialReminders({ dryRun })
    .then((s) => console.log(`[MASS] Trial reminders${dryRun ? ' (DRY RUN)' : ''}: checked ${s.checked}, due ${s.due.length}, sent ${s.sent}, skipped ${s.skipped}, failed ${s.failed || 0}`
      + (dryRun && s.due.length ? ` — would email: ${s.due.map((d) => `${d.kind}:${d.code}`).join(', ')}` : '')))
    .catch((err) => console.error('[MASS] Trial reminders run failed:', err?.message || err));
  setTimeout(run, 3 * 60 * 1000).unref();          // after boot has settled
  setInterval(run, HOUR).unref();
  console.log(`[MASS] Trial reminders scheduled hourly${dryRun ? ' (DRY RUN — nothing is written or sent)' : ''}`);
  return true;
}
