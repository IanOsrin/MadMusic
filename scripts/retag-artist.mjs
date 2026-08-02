#!/usr/bin/env node
/**
 * scripts/retag-artist.mjs
 * Retag one artist's tracks to a genre — the "this artist is filed wrong" fix.
 *
 * DRY RUN BY DEFAULT.
 *
 *   node scripts/retag-artist.mjs --artist Mahotella --to Mbaqanga
 *   node scripts/retag-artist.mjs --artist Mahotella --to Mbaqanga --apply
 *   node scripts/retag-artist.mjs --artist Mahotella --to Mbaqanga --from "Afro Folk,World,African,Marabi" --apply
 *   node scripts/retag-artist.mjs --rollback data/retag-<stamp>.json
 *
 * --from limits which current genres get moved. Without it, EVERY track by the
 * artist is retagged — rarely what you want, because artists cross genres
 * legitimately (the Mahotella Queens are mbaqanga but did record gospel).
 * Always dry-run first and read the "left alone" line.
 *
 * Matches the artist as a SUBSTRING across both artist fields, because names
 * fragment badly: "Mahotella Queens", "Mahlathini and the Mahotella Queens",
 * "Peggy And Mahotella Queens" are all the same act to a listener.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fmFindRecords, fmUpdateRecord, closeFmPool } from '../fm-client.js';
import { FM_LAYOUT } from '../lib/fm-fields.js';

const FIELD = 'Local Genre';
const PAGE  = 200;
const PAUSE = 120;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const arg = (name) => { const i = process.argv.indexOf(name); return i !== -1 ? process.argv[i + 1] : null; };
const APPLY    = process.argv.includes('--apply');
const ARTIST   = arg('--artist');
const TO       = arg('--to');
const FROM     = arg('--from');
const ROLLBACK = arg('--rollback');

async function findByArtist(term) {
  const found = new Map();
  for (const field of ['Album Artist', 'Track Artist']) {
    for (let offset = 1; ; offset += PAGE) {
      const res = await fmFindRecords(FM_LAYOUT, [{ [field]: term }], { limit: PAGE, offset });
      const rows = res?.data || [];
      rows.forEach(r => found.set(String(r.recordId), r));
      if (rows.length < PAGE) break;
      await sleep(PAUSE);
    }
  }
  return [...found.values()];
}

async function main() {
  if (ROLLBACK) return doRollback(ROLLBACK);
  if (!ARTIST || !TO) { console.error('need --artist and --to'); process.exit(1); }

  const allow = FROM ? new Set(FROM.split(',').map(s => s.trim()).filter(Boolean)) : null;
  const records = await findByArtist(ARTIST);
  const genreOf = (r) => String(r.fieldData?.[FIELD] ?? '').trim();

  const todo = records.filter(r => genreOf(r) !== TO && (!allow || allow.has(genreOf(r))));
  const left = records.filter(r => !todo.includes(r));

  console.log(`\nartist match : "${ARTIST}"  →  ${records.length} record(s)`);
  const spread = new Map();
  records.forEach(r => { const g = genreOf(r) || '(blank)'; spread.set(g, (spread.get(g) || 0) + 1); });
  [...spread.entries()].sort((a, b) => b[1] - a[1]).forEach(([g, n]) => console.log(`   ${String(n).padStart(4)}  ${g}`));
  console.log(`\nretag to "${TO}" : ${todo.length}`);
  console.log(`left alone      : ${left.length}${left.length ? ' (' + [...new Set(left.map(r => genreOf(r) || '(blank)'))].join(', ') + ')' : ''}`);

  if (!APPLY) { console.log('\nDRY RUN — nothing written. Add --apply.'); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rbPath = path.join('data', `retag-${stamp}.json`);
  const journal = [];
  let ok = 0, bad = 0;
  for (const r of todo) {
    journal.push({ recordId: r.recordId, field: FIELD, from: genreOf(r), to: TO });
    fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync(rbPath, JSON.stringify(journal, null, 2));
    try { await fmUpdateRecord(FM_LAYOUT, r.recordId, { [FIELD]: TO }); ok++; }
    catch (e) { bad++; console.error(`  FAILED #${r.recordId}: ${e.message}`); }
    await sleep(PAUSE);
  }
  console.log(`\nwritten ${ok} | failed ${bad}`);
  console.log(`rollback: ${rbPath}`);
  console.log(`\nTo undo:  node scripts/retag-artist.mjs --rollback ${rbPath}`);
}

async function doRollback(file) {
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`\nRolling back ${entries.length} record(s)`);
  let ok = 0, bad = 0;
  for (const e of entries) {
    try { await fmUpdateRecord(FM_LAYOUT, e.recordId, { [e.field]: e.from }); ok++; }
    catch (err) { bad++; console.error(`  FAILED #${e.recordId}: ${err.message}`); }
    await sleep(PAUSE);
  }
  console.log(`Restored ${ok}, failed ${bad}`);
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exitCode = 1; })
      .finally(async () => { await closeFmPool(); });
