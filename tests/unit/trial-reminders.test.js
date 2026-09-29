import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Trial reminder emails (2026-09-29): "ends tomorrow" for confirmed trials, "has ended" after,
// "ended — confirm for 6 more days" for unconfirmed 1-day trials; once each (a Notes marker is
// written before sending), never to someone who already holds a live paid code.

const fm = { trials: [], paid: [], updates: [] };
vi.mock('../../fm-client.js', () => ({
  fmCreateRecord: vi.fn(async () => ({})),
  safeFetch: vi.fn(),
  fmFindAll: vi.fn(async () => ({ ok: true, data: fm.trials, total: fm.trials.length })),
  fmFindRecords: vi.fn(async () => (fm.paid.length ? { ok: true, data: fm.paid } : { ok: false, code: '401', data: [] })),
  fmUpdateRecord: vi.fn(async (_layout, recordId, fields) => { fm.updates.push({ recordId, fields }); }),
}));
const sent = [];
vi.mock('../../lib/email.js', () => ({
  sendTrialReminderEmail: vi.fn(async (email, opts) => { sent.push({ email, ...opts }); }),
}));

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'mad-trial-reminders-'));
const { reminderKind, endsText, runTrialReminders } = await import('../../lib/trial-reminders.js');
const { fmStamp } = await import('../../lib/subscriptions.js');
// Pinned AFTER the imports: token-store loads dotenv, and a developer .env may set an offset.
// The fixtures below write FileMaker stamps with no offset, so the reader must use none either.
process.env.FM_TIMEZONE_OFFSET = '0';

const HOUR = 3600_000;
const NOW = new Date('2026-09-29T10:00:00Z').getTime();
const WEEK = String(7 * 86400);
const DAY1 = String(86400);
const trial = (id, expiresInMs, extra = {}) => ({
  recordId: id,
  fieldData: {
    Token_Code: `MASS-${id}`, Token_Type: 'trial', Active: 1, Email: `listener${id}@example.com`,
    Token_Duration_Hours: WEEK, First_Used: 'x', Expiration_Date: fmStamp(new Date(NOW + expiresInMs)), Notes: 'trial', ...extra,
  },
});
const quiet = { log() {}, warn() {}, error() {} };

beforeEach(() => { fm.trials = []; fm.paid = []; fm.updates = []; sent.length = 0; });

describe('reminderKind', () => {
  it('a confirmed trial ending within ~a day is due "ending"', () => {
    expect(reminderKind(trial('1', 20 * HOUR).fieldData, NOW)).toBe('ending');
  });
  it('not yet: more than 30 hours left, or under 2 hours (too late to help)', () => {
    expect(reminderKind(trial('1', 40 * HOUR).fieldData, NOW)).toBeNull();
    expect(reminderKind(trial('1', 1 * HOUR).fieldData, NOW)).toBeNull();
  });
  it('an unconfirmed 1-day trial gets no "ending" email — only the confirm offer once it ends', () => {
    expect(reminderKind(trial('1', 20 * HOUR, { Token_Duration_Hours: DAY1 }).fieldData, NOW)).toBeNull();
    expect(reminderKind(trial('1', -5 * HOUR, { Token_Duration_Hours: DAY1 }).fieldData, NOW)).toBe('ended-unconfirmed');
  });
  it('ended within 3 days → "ended"; older than that → nothing', () => {
    expect(reminderKind(trial('1', -5 * HOUR).fieldData, NOW)).toBe('ended');
    expect(reminderKind(trial('1', -80 * HOUR).fieldData, NOW)).toBeNull();
  });
  it('each is sent once: the Notes marker stops a repeat', () => {
    expect(reminderKind(trial('1', 20 * HOUR, { Notes: 'trial [trial-reminder ending 2026-09-28]' }).fieldData, NOW)).toBeNull();
    expect(reminderKind(trial('1', -5 * HOUR, { Notes: 'x [trial-reminder ended-unconfirmed 2026-09-28]' }).fieldData, NOW)).toBeNull();
  });
  it('never for paid codes, cancelled trials, no email, or a trial not yet used', () => {
    expect(reminderKind(trial('1', 20 * HOUR, { Token_Type: 'valid' }).fieldData, NOW)).toBeNull();
    expect(reminderKind(trial('1', 20 * HOUR, { Active: 0 }).fieldData, NOW)).toBeNull();
    expect(reminderKind(trial('1', 20 * HOUR, { Email: '' }).fieldData, NOW)).toBeNull();
    expect(reminderKind(trial('1', 20 * HOUR, { Expiration_Date: '' }).fieldData, NOW)).toBeNull();
  });
});

describe('endsText (South African time)', () => {
  it('says tomorrow / today with the SAST clock time', () => {
    expect(endsText(new Date('2026-09-30T12:30:00Z').getTime(), NOW)).toBe('tomorrow at 14:30');
    expect(endsText(new Date('2026-09-29T15:00:00Z').getTime(), NOW)).toBe('today at 17:00');
  });
});

describe('runTrialReminders', () => {
  it('marks FileMaker BEFORE emailing, and sends the right email to each', async () => {
    fm.trials = [trial('1', 20 * HOUR), trial('2', -5 * HOUR), trial('3', -5 * HOUR, { Token_Duration_Hours: DAY1 }), trial('4', 50 * HOUR)];
    const s = await runTrialReminders({ now: NOW, log: quiet });
    expect(s.sent).toBe(3);
    expect(sent.map((x) => x.kind)).toEqual(['ending', 'ended', 'ended-unconfirmed']);
    expect(fm.updates.map((u) => u.fields.Notes)).toEqual([
      'trial [trial-reminder ending 2026-09-29]',
      'trial [trial-reminder ended 2026-09-29]',
      'trial [trial-reminder ended-unconfirmed 2026-09-29]',
    ]);
    // Only the unconfirmed one carries the signed Confirm link.
    expect(sent[0].confirmUrl).toBeNull();
    expect(sent[2].confirmUrl).toMatch(/\/api\/payments\/trial\/confirm\?t=MASS-3&s=/);
    expect(sent[0].endsText).toMatch(/^tomorrow at /);
  });

  it('skips anyone who already has live paid access', async () => {
    fm.trials = [trial('1', 20 * HOUR)];
    fm.paid = [{ fieldData: { Token_Type: 'subscription', Expiration_Date: fmStamp(new Date(NOW + 20 * 86400_000)) } }];
    const s = await runTrialReminders({ now: NOW, log: quiet });
    expect(s).toMatchObject({ sent: 0, skipped: 1 });
    expect(fm.updates).toHaveLength(0);
  });

  it('an expired paid code does not count as paid access', async () => {
    fm.trials = [trial('1', 20 * HOUR)];
    fm.paid = [{ fieldData: { Token_Type: 'valid', Expiration_Date: fmStamp(new Date(NOW - 86400_000)) } }];
    expect((await runTrialReminders({ now: NOW, log: quiet })).sent).toBe(1);
  });

  it('dry run: reports who is due, writes nothing, sends nothing', async () => {
    fm.trials = [trial('1', 20 * HOUR), trial('2', -5 * HOUR)];
    const s = await runTrialReminders({ now: NOW, dryRun: true, log: quiet });
    expect(s.due.map((d) => d.kind)).toEqual(['ending', 'ended']);
    expect(fm.updates).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});
