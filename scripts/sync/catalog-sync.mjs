#!/usr/bin/env node
// ============================================================================
// scripts/sync/catalog-sync.mjs — run the FileMaker → Postgres catalog mirror.
//
//   npm run sync:catalog
//
// Reads API_Album_Songs from fmcloud via the Data API (the approved internal
// job — never the public path) and upserts into the Postgres `tracks` mirror.
// Requires DATABASE_URL (postgres) + the usual FM_* env. Safe to run repeatedly.
// ============================================================================

import 'dotenv/config';
import { fmGet, fmFindRecords, closeFmPool } from '../../fm-client.js';
import { FM_LAYOUT } from '../../lib/fm-fields.js';
import { isPgEnabled, query, closePgPool } from '../../lib/pg.js';
import { parsePositiveInt } from '../../lib/format.js';
import { runCatalogSync } from '../../lib/catalog-sync.js';
import { mapRecordToRow, TRACK_COLUMNS } from '../../lib/catalog-mapper.js';

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const FIELDS = args.has('--fields');
const limitArg = process.argv.slice(2).find((a) => a.startsWith('--limit='));
const DRY_LIMIT = limitArg ? Math.max(1, parseInt(limitArg.split('=')[1], 10) || 5) : 5;

// Flag definitions mirror lib/catalog-mapper.js — used to verify each flag
// resolves true against a record that actually carries it.
const FLAG_PROBES = [
  { col: 'is_featured',   field: 'Tape Files::Featured',          value: 'yes' },
  { col: 'is_g100',       field: 'Tape Files::G100_Highlights',   value: 'Yes' },
  { col: 'is_single',     field: 'Tape Files::Singles',           value: 'Yes' },
  { col: 'is_global_fav', field: 'Tape Files::Global_Favorites',  value: 'Yes' },
];

// Read-only: dump the real field names, highlight year/date/flag candidates, and
// confirm each flag end-to-end via a _find for an actually-flagged record.
async function inspectFields() {
  console.log(`[catalog-sync] FIELD INSPECTION on ${FM_LAYOUT} — read-only.\n`);
  const res = await fmGet(`/layouts/${encodeURIComponent(FM_LAYOUT)}/records?_limit=3&_offset=1`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`FM read failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`);

  const data = json?.response?.data || [];
  const keys = new Set();
  for (const r of data) for (const k of Object.keys(r.fieldData || {})) keys.add(k);
  const sorted = [...keys].sort((a, b) => a.localeCompare(b));
  const sample = data[0]?.fieldData || {};

  console.log(`── all ${sorted.length} field names (sample value from record 1) ──`);
  for (const k of sorted) {
    const v = sample[k];
    const show = v === '' || v == null ? '∅' : String(v).slice(0, 48);
    console.log(`   ${k.padEnd(34)} ${show}`);
  }

  const yearish = sorted.filter((k) => /year|date|released|©|copyright/i.test(k));
  console.log(`\n── year/date-like fields ──\n   ${yearish.length ? yearish.join('\n   ') : '(none found)'}`);

  console.log('\n── flag verification (via _find for a flagged record) ──');
  for (const probe of FLAG_PROBES) {
    const r = await fmFindRecords(FM_LAYOUT, [{ [probe.field]: probe.value }], { limit: 1 });
    if (!r.ok) {
      const missing = String(r.code) === '102';
      console.log(`   ${probe.col.padEnd(15)} ${missing ? `field "${probe.field}" NOT on layout` : `find error (${r.code}: ${r.msg})`}`);
      continue;
    }
    if (!r.data.length) {
      console.log(`   ${probe.col.padEnd(15)} field exists, but 0 records match "${probe.value}"`);
      continue;
    }
    const row = mapRecordToRow(r.data[0]);
    const ok = row[probe.col] === true;
    console.log(`   ${probe.col.padEnd(15)} ${ok ? '✓ resolves true' : '✗ MAPPED FALSE'} (recordId ${row.fm_record_id}, "${row.album_title}")`);
  }
}

// Read-only probe: fetch a few real records, map them, print sample + coverage.
// Writes NOTHING (doesn't even need Postgres). Use to validate the field mapping
// against live fmcloud before a full sync.
async function dryRun() {
  console.log(`[catalog-sync] DRY RUN — reading ${DRY_LIMIT} record(s) from ${FM_LAYOUT}, no writes.\n`);
  const res = await fmGet(`/layouts/${encodeURIComponent(FM_LAYOUT)}/records?_limit=${DRY_LIMIT}&_offset=1`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`FM read failed: ${json?.messages?.[0]?.message || `HTTP ${res.status}`}`);
  }
  const data = json?.response?.data || [];
  const foundCount = json?.response?.dataInfo?.foundCount ?? data.length;
  console.log(`[catalog-sync] FileMaker reports foundCount = ${foundCount} total records.\n`);

  const rows = data.map(mapRecordToRow).filter(Boolean);
  const NORM = TRACK_COLUMNS.filter((c) => !['raw', 'synced_at'].includes(c));
  rows.forEach((row, i) => {
    console.log(`── record ${i + 1} (recordId ${row.fm_record_id}) ──`);
    for (const c of NORM) if (c !== 'fm_record_id') console.log(`   ${c.padEnd(15)} ${row[c] ?? '∅'}`);
    console.log(`   raw fields: ${Object.keys(row.raw).length}\n`);
  });

  // Coverage across the sample: how often each normalized column resolved.
  console.log('── field coverage across sample ──');
  for (const c of NORM) {
    const n = rows.filter((r) => r[c] !== null && r[c] !== false && r[c] !== '').length;
    console.log(`   ${c.padEnd(15)} ${n}/${rows.length}`);
  }
  // Flag which audio values are NOT stable S3 URLs (would need FM container fallback).
  const nonS3 = rows.filter((r) => r.s3_audio_url && !/\.s3[.-]|s3[.-]/.test(r.s3_audio_url));
  if (nonS3.length) {
    console.log(`\n⚠️  ${nonS3.length}/${rows.length} audio URLs are NOT direct S3 (would need /api/track/:id/container fallback).`);
  }
}

async function main() {
  if (FIELDS) {
    await inspectFields();
    return;
  }
  if (DRY_RUN) {
    await dryRun();
    return;
  }
  if (!isPgEnabled()) {
    console.error('[catalog-sync] DATABASE_URL is not a postgres:// URL — set it first (npm run db:migrate).');
    process.exitCode = 1;
    return;
  }
  const pageSize = parsePositiveInt(process.env.SYNC_PAGE_SIZE, 500);
  console.log(`[catalog-sync] starting full resync of ${FM_LAYOUT} (page size ${pageSize}) ...`);

  const result = await runCatalogSync({
    fmGet,
    query,
    layout: FM_LAYOUT,
    pageSize,
    log: (msg) => console.log(msg),
  });

  console.log(`[catalog-sync] ✓ ${result.rowsUpserted} rows upserted, ${result.rowsDeleted} pruned, ${result.pages} pages`);
}

// Always tear down both connection pools so the cron process exits promptly
// (undici keep-alive sockets would otherwise hold the event loop ~60s).
main()
  .catch((err) => {
    console.error('[catalog-sync] FAILED:', err?.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeFmPool().catch(() => {});
    await closePgPool().catch(() => {});
  });
