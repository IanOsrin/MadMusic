#!/usr/bin/env node
/**
 * scripts/apply-genre-proposals.mjs
 * Apply propagated genre proposals to MadStreamer's `Local Genre`.
 *
 * DRY RUN BY DEFAULT. Writes only with --apply.
 *
 *   node scripts/apply-genre-proposals.mjs
 *   node scripts/apply-genre-proposals.mjs --apply
 *   node scripts/apply-genre-proposals.mjs --rollback <file>
 *
 * --exclude-to "Afro Folk"   skip proposals assigning that genre
 *
 * SAFETY — verifies the record still holds the value the proposal expected.
 * Proposals are computed from the Postgres mirror, which lags FileMaker by up
 * to a day. If a record has changed since (someone tagged it by hand, another
 * script touched it), the proposal is stale and must not overwrite the newer
 * value. Anything that doesn't match `from` is skipped and reported.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fmFindRecords, fmUpdateRecord, closeFmPool } from '../fm-client.js';
import { FM_LAYOUT } from '../lib/fm-fields.js';

const FIELD = 'Local Genre';
const IN    = process.env.PROPOSALS_IN || '/Users/ianosrin/Downloads/madstreamer-genre-proposals-filtered.json';
const PAGE  = 500;
const PAUSE = Number.parseInt(process.env.PROPOSAL_PAUSE_MS || '', 10) || 120;

const args      = process.argv.slice(2);
const APPLY     = args.includes('--apply');
const EXCLUDE   = (() => { const i = args.indexOf('--exclude-to'); return i !== -1 ? args[i + 1] : null; })();
const ROLLBACK  = (() => { const i = args.indexOf('--rollback'); return i !== -1 ? args[i + 1] : null; })();
const sleep     = (ms) => new Promise(r => setTimeout(r, ms));

/** Current value of FIELD for every record holding `value` (or empty when ''). */
async function snapshot(value) {
  const map = new Map();
  const query = value === '' ? { [FIELD]: '=' } : { [FIELD]: `==${value}` };
  for (let offset = 1; ; offset += PAGE) {
    const res = await fmFindRecords(FM_LAYOUT, [query], { limit: PAGE, offset });
    const rows = res?.data || [];
    for (const r of rows) map.set(String(r.recordId), String(r.fieldData?.[FIELD] ?? '').trim());
    if (rows.length < PAGE) break;
    await sleep(PAUSE);
  }
  return map;
}

async function main() {
  if (ROLLBACK) return doRollback(ROLLBACK);

  let proposals = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const excludedCount = EXCLUDE ? proposals.filter(p => p.to === EXCLUDE).length : 0;
  if (EXCLUDE) proposals = proposals.filter(p => p.to !== EXCLUDE);

  console.log(`\nproposals file : ${IN}`);
  if (EXCLUDE) console.log(`excluded       : ${excludedCount} assigning "${EXCLUDE}" (parked, not applied)`);
  console.log(`to consider    : ${proposals.length}`);
  console.log(APPLY ? '*** APPLY MODE — records WILL be written ***\n' : 'DRY RUN — nothing will be written\n');

  // Build a current-state snapshot per source bucket, so we can confirm each
  // record still holds what the proposal assumed without 1,478 single reads.
  const buckets = [...new Set(proposals.map(p => p.from))];
  console.log('checking current state in FileMaker…');
  const current = new Map();
  for (const b of buckets) {
    const val = b === '(blank)' ? '' : b;
    const snap = await snapshot(val);
    for (const [id, v] of snap) current.set(id, v);
    console.log(`   ${String(snap.size).padStart(5)} records currently "${b}"`);
  }

  const todo = [], stale = [];
  for (const p of proposals) {
    const expected = p.from === '(blank)' ? '' : p.from;
    const actual = current.get(String(p.fm_record_id));
    if (actual === undefined || actual !== expected) { stale.push(p); continue; }
    todo.push(p);
  }
  console.log(`\nstill matching : ${todo.length}`);
  if (stale.length) console.log(`stale, skipped : ${stale.length} (changed since the mirror snapshot)`);

  if (!APPLY) {
    console.log(`\nNothing written. Re-run with --apply.`);
    console.log(`At ${PAUSE}ms/record this takes roughly ${Math.ceil((todo.length * PAUSE) / 60000)} minute(s).`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rollbackPath = path.join('data', `genre-proposals-rollback-${stamp}.json`);
  const journal = [];
  let written = 0, failed = 0;

  for (const p of todo) {
    journal.push({ recordId: String(p.fm_record_id), field: FIELD, from: p.from === '(blank)' ? '' : p.from, to: p.to, tier: p.tier });
    fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync(rollbackPath, JSON.stringify(journal, null, 2));
    try {
      await fmUpdateRecord(FM_LAYOUT, String(p.fm_record_id), { [FIELD]: p.to });
      written++;
      if (written % 250 === 0) console.log(`   … ${written}/${todo.length}`);
    } catch (err) {
      failed++;
      console.error(`   FAILED #${p.fm_record_id}: ${err.message}`);
    }
    await sleep(PAUSE);
  }

  console.log(`\nwritten ${written} | failed ${failed}`);
  console.log(`rollback: ${rollbackPath}`);
  console.log(`\nTo undo:  node scripts/apply-genre-proposals.mjs --rollback ${rollbackPath}`);
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
