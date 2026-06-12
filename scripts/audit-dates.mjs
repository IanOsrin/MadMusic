/**
 * scripts/audit-dates.mjs — one-off data-quality audit of release-date fields
 * in PRODUCTION MADStreamer (fmcloud). Read-only: paged GETs, sequential,
 * nothing written to FM. Output: console summary + data/date-audit.csv.
 *
 * Checks every API_Album_Songs record's date-ish fields:
 *   - "Year of Release"        expected: 4-digit year
 *   - "Original Release date"  expected: ISO yyyy-mm-dd
 * and reports anything that doesn't conform, with recordId/recid/track/artist
 * so the fixes can be found in FileMaker.
 */

import 'dotenv/config';
import fs from 'node:fs';

const HOST = process.env.FM_HOST;          // production fmcloud
const DB   = process.env.FM_DB;
const USER = process.env.FM_USER;
const PASS = process.env.FM_PASS;
const LAYOUT = process.env.FM_LAYOUT || 'API_Album_Songs';

const YEAR_FIELD = 'Year of Release';
const DATE_FIELD = 'Original Release date';

async function login() {
  const auth = Buffer.from(`${USER}:${PASS}`).toString('base64');
  const r = await fetch(`${HOST}/fmi/data/vLatest/databases/${DB}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: '{}'
  }).then((x) => x.json());
  if (!r.response?.token) throw new Error(`login failed: ${JSON.stringify(r.messages)}`);
  return r.response.token;
}

async function page(token, offset, limit) {
  const r = await fetch(
    `${HOST}/fmi/data/vLatest/databases/${DB}/layouts/${LAYOUT}/records?_offset=${offset}&_limit=${limit}`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).then((x) => x.json());
  if (!r.response?.data) {
    const code = r.messages?.[0]?.code;
    if (code === '401' || code === '101') return [];
    throw new Error(`page failed at ${offset}: ${JSON.stringify(r.messages)}`);
  }
  return r.response.data;
}

// ── classification ────────────────────────────────────────────────────────────

const RE_YEAR = /^(19|20)\d{2}$/;
const RE_ISO  = /^(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function classifyYear(v) {
  if (!v) return null;                       // empty: counted separately, not "bad"
  if (RE_YEAR.test(v)) {
    const y = Number(v);
    if (y >= 1900 && y <= 2026) return null; // good
    return 'year-out-of-range';
  }
  if (RE_ISO.test(v)) return 'full-date-in-year-field';
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(v)) return 'malformed-date-in-year-field';
  if (/^\d+$/.test(v)) return 'numeric-but-not-a-year';
  return 'non-numeric-text';
}

function classifyDate(v) {
  if (!v) return null;                       // empty: counted separately
  if (RE_ISO.test(v)) {
    const y = Number(v.slice(0, 4));
    if (y >= 1900 && y <= 2026) return null; // good
    return 'date-out-of-range';
  }
  if (RE_YEAR.test(v)) return 'year-only-in-date-field';
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(v)) return 'slash-format-date';
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(v)) return 'iso-but-unpadded';
  if (/^\d{4}-\d{2}$/.test(v)) return 'year-month-only';
  return 'unrecognised-format';
}

// ── main ─────────────────────────────────────────────────────────────────────

const t0 = Date.now();
console.log(`[audit] PRODUCTION ${HOST}/${DB} layout ${LAYOUT} — read-only`);
const token = await login();

const bad = [];
const counts = { scanned: 0, yearEmpty: 0, dateEmpty: 0, yearGood: 0, dateGood: 0 };
const byIssue = {};

try {
  let offset = 1;
  const PAGE = 500;
  for (;;) {
    const recs = await page(token, offset, PAGE);
    if (!recs.length) break;
    for (const rec of recs) {
      const f = rec.fieldData;
      counts.scanned++;
      const yearV = String(f[YEAR_FIELD] ?? '').trim();
      const dateV = String(f[DATE_FIELD] ?? '').trim();

      const yIssue = classifyYear(yearV);
      if (!yearV) counts.yearEmpty++;
      else if (!yIssue) counts.yearGood++;

      const dIssue = classifyDate(dateV);
      if (!dateV) counts.dateEmpty++;
      else if (!dIssue) counts.dateGood++;

      for (const [field, value, issue] of [[YEAR_FIELD, yearV, yIssue], [DATE_FIELD, dateV, dIssue]]) {
        if (!issue) continue;
        byIssue[issue] = (byIssue[issue] || 0) + 1;
        bad.push({
          recordId: rec.recordId,
          recid: String(f.recid ?? ''),
          track: String(f['Track Name'] ?? '').slice(0, 60),
          artist: String(f['Track Artist'] ?? f['Album Artist'] ?? '').slice(0, 50),
          album: String(f['Album Title'] ?? '').slice(0, 60),
          field, value: value.slice(0, 60), issue
        });
      }
    }
    offset += recs.length;
    if (counts.scanned % 10000 < PAGE) console.log(`[audit] scanned ${counts.scanned}…`);
  }
} finally {
  await fetch(`${HOST}/fmi/data/vLatest/databases/${DB}/sessions/${token}`, { method: 'DELETE' }).catch(() => {});
}

// CSV report
const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
const csv = [
  'recordId,recid,field,issue,value,track,artist,album',
  ...bad.map((b) => [b.recordId, b.recid, b.field, b.issue, b.value, b.track, b.artist, b.album].map(esc).join(','))
].join('\n');
fs.writeFileSync('data/date-audit.csv', csv);

console.log(`\n[audit] done in ${((Date.now() - t0) / 1000).toFixed(0)}s — scanned ${counts.scanned} records`);
console.log(`\n"${YEAR_FIELD}":  good ${counts.yearGood}  empty ${counts.yearEmpty}  bad ${counts.scanned - counts.yearGood - counts.yearEmpty}`);
console.log(`"${DATE_FIELD}":  good ${counts.dateGood}  empty ${counts.dateEmpty}  bad ${counts.scanned - counts.dateGood - counts.dateEmpty}`);
console.log(`\nIssues by type:`);
for (const [issue, n] of Object.entries(byIssue).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${issue.padEnd(30)} ${n}`);
}
console.log(`\nFull list: data/date-audit.csv (${bad.length} rows)`);
console.log(`\nSample of each issue type:`);
const seen = new Set();
for (const b of bad) {
  if (seen.has(b.issue)) continue;
  seen.add(b.issue);
  console.log(`  [${b.issue}] ${b.field} = "${b.value}" — ${b.track} / ${b.artist} (recid ${b.recid})`);
}
