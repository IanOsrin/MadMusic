#!/usr/bin/env node
/**
 * scripts/genre-cleanup.mjs — normalise the `Local Genre` field in FileMaker.
 *
 * DRY RUN BY DEFAULT. Nothing is written unless you pass --apply.
 *
 *   node scripts/genre-cleanup.mjs                 # report only — what WOULD change
 *   node scripts/genre-cleanup.mjs --apply         # actually write
 *   node scripts/genre-cleanup.mjs --apply --only "Afro-folk"   # one mapping at a time
 *   node scripts/genre-cleanup.mjs --rollback data/genre-rollback-<stamp>.json
 *
 * WHY THIS IS THROTTLED
 * FileMaker allows 8 concurrent requests for the WHOLE application (see
 * FM_MAX_CONCURRENT_REQUESTS in fm-client.js), and that queue is shared with
 * live traffic — token validation, playback resolution and payments all go
 * through it. A tight update loop over thousands of records would starve the
 * running site. This writes one record at a time with a deliberate pause, so a
 * long run stays boring rather than taking the site down. Run it off-peak.
 *
 * ROLLBACK
 * Every applied run writes data/genre-rollback-<stamp>.json mapping recordId ->
 * previous value BEFORE it changes anything, flushed as it goes. If the run dies
 * halfway, that file still describes exactly what was already changed.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fmFindRecords, fmUpdateRecord, closeFmPool } from '../fm-client.js';
import { FM_LAYOUT } from '../lib/fm-fields.js';

const GENRE_FIELD = 'Local Genre';

// ── The mapping ──────────────────────────────────────────────────────────────
// Left = value to find, right = value to write. Derived from the 31 July count
// of the Postgres mirror; see MAD-genre-cleanup-2026-07-31.md for the numbers.
const MAPPING = [
  // duplicates / casing / punctuation
  ['Afro-folk',                              'Afro Folk'],
  ['instrumental',                           'Instrumental'],
  ['BoereMusiek',                            'Boere Musiek'],
  ['Afro-Pop',                               'Afro Pop'],
  ['Afropop',                                'Afro Pop'],
  ['Hip Hop',                                'Hip-Hop'],
  ['Pop Rap/Hip-Hop',                        'Hip-Hop'],
  ['R & B/Soul',                             'R&B/Soul'],
  ['Childrens Music',                        "Children's Music"],
  ['Afro Fusion',                            'Afro-fusion'],
  ['Adult Contemporary (Singer/Songwriter',  'Adult Contemporary (Singer/Songwriter)'],

  // typos / truncations
  ['Oldied',                                 'Oldies'],
  ['Mbhaqnga',                               'Mbaqanga'],
  ["80'",                                    "80's"],

  // judgement call — comment out if you disagree
  ['Afro Dancehall',                         'African Dancehall'],

  // pre-1980 decades → Oldies. 80's deliberately NOT included.
  ["50's",                                   'Oldies'],
  ['50s',                                    'Oldies'],
  ["60's",                                   'Oldies'],
  ['60s',                                    'Oldies'],
  ["70's",                                   'Oldies'],
];

// ── args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ONLY = (() => { const i = args.indexOf('--only'); return i !== -1 ? args[i + 1] : null; })();
const ROLLBACK = (() => { const i = args.indexOf('--rollback'); return i !== -1 ? args[i + 1] : null; })();
// --mapping <file>: JSON [[from, to], ...]. Lets the team edit the taxonomy
// without touching code. Falls back to the built-in MAPPING above.
const MAPPING_FILE = (() => { const i = args.indexOf('--mapping'); return i !== -1 ? args[i + 1] : null; })();
const PAUSE_MS = Number.parseInt(process.env.GENRE_CLEANUP_PAUSE_MS || '', 10) || 120;
const PAGE = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

async function findAll(value) {
  const out = [];
  for (let offset = 1; ; offset += PAGE) {
    // '==' is FileMaker's exact-match operator — without it "50s" would also
    // match "50s Jive" and we would rewrite genres nobody asked us to touch.
    const res = await fmFindRecords(FM_LAYOUT, [{ [GENRE_FIELD]: `==${value}` }], { limit: PAGE, offset });
    const rows = res?.data || [];
    out.push(...rows);
    if (rows.length < PAGE) break;
    await sleep(PAUSE_MS);
  }
  return out;
}

async function main() {
  if (ROLLBACK) return doRollback(ROLLBACK);

  const table = MAPPING_FILE ? JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8')) : MAPPING;
  if (MAPPING_FILE) console.log(`Mapping: ${MAPPING_FILE} (${table.length} rules)`);
  const plan = table.filter(([from]) => !ONLY || from === ONLY);
  if (!plan.length) { console.error(`No mapping matches --only "${ONLY}"`); process.exit(1); }

  console.log(`\nLayout: ${FM_LAYOUT}   Field: ${GENRE_FIELD}`);
  console.log(APPLY ? '*** APPLY MODE — records WILL be written ***' : 'DRY RUN — nothing will be written\n');

  const rollbackPath = path.join('data', `genre-rollback-${stamp}.json`);
  const rollback = [];
  let totalFound = 0, totalWritten = 0, totalFailed = 0, totalSkipped = 0;

  for (const [from, to] of plan) {
    const matched = await findAll(from);

    // FileMaker's find is CASE-INSENSITIVE, so `==instrumental` also returns
    // every correctly-capitalised "Instrumental" — 5,859 of them. Writing those
    // would be a no-op in value but real cost: minutes of write traffic through
    // the 8-slot queue the live site shares, and a modification timestamp
    // touched on 9% of the catalogue. Compare exactly, in JS, and skip anything
    // that already reads the way we want it.
    const rows = matched.filter((r) => (r.fieldData?.[GENRE_FIELD] ?? '') !== to);
    const alreadyCorrect = matched.length - rows.length;

    totalFound += rows.length;
    totalSkipped += alreadyCorrect;
    if (!rows.length) {
      console.log(`  ${String(0).padStart(5)}  "${from}" — nothing to change` +
        (alreadyCorrect ? ` (${alreadyCorrect} already "${to}")` : ' (none found)'));
      continue;
    }
    if (alreadyCorrect) console.log(`         (${alreadyCorrect} matched but already "${to}" — skipping those)`);

    console.log(`  ${String(rows.length).padStart(5)}  "${from}"  ->  "${to}"`);
    const sample = rows.slice(0, 3).map((r) => `#${r.recordId} ${r.fieldData?.['Track Name'] || ''}`.trim());
    sample.forEach((s) => console.log(`         e.g. ${s}`));

    if (!APPLY) continue;

    for (const r of rows) {
      // Record the previous value BEFORE writing, and flush immediately — a run
      // that dies halfway must still leave a complete record of what changed.
      rollback.push({ recordId: r.recordId, field: GENRE_FIELD, from: r.fieldData?.[GENRE_FIELD] ?? '', to });
      fs.mkdirSync('data', { recursive: true });
      fs.writeFileSync(rollbackPath, JSON.stringify(rollback, null, 2));
      try {
        await fmUpdateRecord(FM_LAYOUT, r.recordId, { [GENRE_FIELD]: to });
        totalWritten++;
        if (totalWritten % 100 === 0) console.log(`         … ${totalWritten} written`);
      } catch (err) {
        totalFailed++;
        console.error(`         FAILED #${r.recordId}: ${err.message}`);
      }
      await sleep(PAUSE_MS);   // stay out of the live site's way
    }
  }

  console.log(`\n${'-'.repeat(60)}`);
  console.log(`Records to change   : ${totalFound}`);
  console.log(`Already correct     : ${totalSkipped} (skipped, not written)`);
  if (APPLY) {
    console.log(`Records written : ${totalWritten}`);
    console.log(`Failures        : ${totalFailed}`);
    console.log(`Rollback file   : ${rollbackPath}`);
    console.log(`\nTo undo:  node scripts/genre-cleanup.mjs --rollback ${rollbackPath}`);
  } else {
    console.log(`\nNothing was written. Re-run with --apply to make these changes.`);
    const mins = Math.ceil((totalFound * PAUSE_MS) / 60000);
    console.log(`At ${PAUSE_MS}ms per record an apply run would take roughly ${mins} minute(s).`);
  }
}

async function doRollback(file) {
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`\nRolling back ${entries.length} record(s) from ${file}`);
  let ok = 0, bad = 0;
  for (const e of entries) {
    try { await fmUpdateRecord(FM_LAYOUT, e.recordId, { [e.field]: e.from }); ok++; }
    catch (err) { bad++; console.error(`  FAILED #${e.recordId}: ${err.message}`); }
    await sleep(PAUSE_MS);
  }
  console.log(`Restored ${ok}, failed ${bad}`);
}

main()
  .catch((err) => { console.error('\nFATAL:', err.message); process.exitCode = 1; })
  .finally(async () => { await closeFmPool(); });
