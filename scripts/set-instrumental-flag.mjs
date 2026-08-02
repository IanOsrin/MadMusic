#!/usr/bin/env node
/**
 * scripts/set-instrumental-flag.mjs
 * Set the new `Instrumental` attribute on MadStreamer tracks.
 *
 * DRY RUN BY DEFAULT. Writes only with --apply.
 *
 *   node scripts/set-instrumental-flag.mjs
 *   node scripts/set-instrumental-flag.mjs --apply
 *   node scripts/set-instrumental-flag.mjs --rollback <file>
 *
 * WHY: "Instrumental" was being carried in `Local Genre`, which meant an
 * instrumental mbaqanga record could be described as instrumental OR as
 * mbaqanga, never both. It is an attribute, not a genre. This moves it to its
 * own field so the genre field can eventually say what the music actually is.
 *
 * `Local Genre` IS DELIBERATELY LEFT ALONE. Clearing it here would make 5,860
 * tracks unbrowsable overnight with nothing to replace them — the genre gets
 * cleared per album, as each one gets a real answer. Same destination, no
 * window where the site is worse.
 *
 * Targets records where EITHER genre field says Instrumental: the attribute is
 * true regardless of which field happens to record it.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fmFindRecords, fmUpdateRecord, closeFmPool } from '../fm-client.js';
import { FM_LAYOUT } from './../lib/fm-fields.js';

const FIELD  = 'Instrumental';
const VALUE  = 'Yes';
const PAGE   = 500;
const PAUSE  = Number.parseInt(process.env.INSTRUMENTAL_PAUSE_MS || '', 10) || 120;

const args     = process.argv.slice(2);
const APPLY    = args.includes('--apply');
const ROLLBACK = (() => { const i = args.indexOf('--rollback'); return i !== -1 ? args[i + 1] : null; })();
const sleep    = (ms) => new Promise(r => setTimeout(r, ms));

async function findAll(field, value) {
  const out = [];
  for (let offset = 1; ; offset += PAGE) {
    const res = await fmFindRecords(FM_LAYOUT, [{ [field]: `==${value}` }], { limit: PAGE, offset });
    const rows = res?.data || [];
    out.push(...rows);
    if (rows.length < PAGE) break;
    await sleep(PAUSE);
  }
  return out;
}

async function main() {
  if (ROLLBACK) return doRollback(ROLLBACK);

  console.log(`\nLayout: ${FM_LAYOUT}   Field: ${FIELD} = "${VALUE}"`);
  console.log(APPLY ? '*** APPLY MODE — records WILL be written ***\n' : 'DRY RUN — nothing will be written\n');

  const byLocal = await findAll('Local Genre', 'Instrumental');
  const byGenre = await findAll('Genre', 'Instrumental');
  console.log(`Local Genre = Instrumental : ${byLocal.length}`);
  console.log(`Genre       = Instrumental : ${byGenre.length}`);

  const merged = new Map();
  for (const r of [...byLocal, ...byGenre]) merged.set(String(r.recordId), r);
  const extras = [...merged.values()].filter(r =>
    String(r.fieldData?.['Local Genre'] ?? '').trim().toLowerCase() !== 'instrumental');
  console.log(`union (unique records)     : ${merged.size}`);
  console.log(`  ...of which are flagged only by the Ingrooves Genre field: ${extras.length}`);

  // Idempotent: skip anything already carrying the value, so a re-run is safe.
  const todo = [...merged.values()].filter(r =>
    String(r.fieldData?.[FIELD] ?? '').trim().toLowerCase() !== VALUE.toLowerCase());
  const already = merged.size - todo.length;
  if (already) console.log(`  ...already set, skipping: ${already}`);
  console.log(`\nto write: ${todo.length}`);

  if (!APPLY) {
    console.log(`\nNothing written. Re-run with --apply.`);
    console.log(`At ${PAUSE}ms/record this takes roughly ${Math.ceil((todo.length * PAUSE) / 60000)} minute(s).`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rollbackPath = path.join('data', `instrumental-flag-rollback-${stamp}.json`);
  const journal = [];
  let written = 0, failed = 0;

  for (const r of todo) {
    journal.push({ recordId: r.recordId, field: FIELD, from: r.fieldData?.[FIELD] ?? '', to: VALUE });
    fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync(rollbackPath, JSON.stringify(journal, null, 2));
    try {
      await fmUpdateRecord(FM_LAYOUT, r.recordId, { [FIELD]: VALUE });
      written++;
      if (written % 250 === 0) console.log(`   … ${written}/${todo.length}`);
    } catch (err) {
      failed++;
      console.error(`   FAILED #${r.recordId}: ${err.message}`);
    }
    await sleep(PAUSE);
  }

  console.log(`\nwritten ${written} | failed ${failed}`);
  console.log(`rollback: ${rollbackPath}`);
  console.log(`\nTo undo:  node scripts/set-instrumental-flag.mjs --rollback ${rollbackPath}`);
  console.log(`\nNOTE: Local Genre untouched — those tracks still read "Instrumental" on the site.`);
}

async function doRollback(file) {
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`\nRolling back ${entries.length} record(s) from ${file}`);
  let ok = 0, bad = 0;
  for (const e of entries) {
    try { await fmUpdateRecord(FM_LAYOUT, e.recordId, { [e.field]: e.from }); ok++; }
    catch (err) { bad++; console.error(`  FAILED #${e.recordId}: ${err.message}`); }
    await sleep(PAUSE);
  }
  console.log(`Restored ${ok}, failed ${bad}`);
}

main()
  .catch(err => { console.error('\nFATAL:', err.message); process.exitCode = 1; })
  .finally(async () => { await closeFmPool(); });
