#!/usr/bin/env node
/**
 * scripts/repoint-playlist-art.mjs
 * Repoint API_Playlist_Art.Image_S3_URL at a new master key.
 *
 * DRY RUN BY DEFAULT.
 *   node scripts/repoint-playlist-art.mjs
 *   node scripts/repoint-playlist-art.mjs --apply
 *   node scripts/repoint-playlist-art.mjs --rollback data/<file>.json
 *
 * WHY: Cloudflare caches the 403 an artwork URL returns while its derivative is
 * missing, and never re-checks — so a cover requested during the window between
 * "saved in FileMaker" and "resizer has run" is permanently blank at that path.
 * Verified 2026-08-02 by A/B: an object probed while missing stayed 403 after
 * being created; an identical object never probed served 200. Purging needs
 * dashboard access we don't have, so the fix is a path the CDN has never seen.
 *
 * Only Image_S3_URL is touched — Category, Active and the name are left alone.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fmFindRecords, fmUpdateRecord, closeFmPool } from '../fm-client.js';
import { FM_PLAYLIST_ART_LAYOUT } from '../lib/fm-fields.js';

const FIELD = 'Image_S3_URL';
const NAME  = 'Playlist_Name';
const STAMP = '20260802';
// Store the S3 host, NOT the CDN host. server.js rewrites this host to
// MEDIA_CDN_HOST on every JSON response, so host policy lives in one place —
// a hard-coded CDN host here would strand these records if that env changes.
const HOST  = 'https://mass-music-audio-files.s3.eu-north-1.amazonaws.com';
const TARGETS = ['Mbaqanga', 'Maskandi', 'Afro Reggae', 'Gospel Spirit Selects'];

const args     = process.argv.slice(2);
const APPLY    = args.includes('--apply');
const ROLLBACK = (() => { const i = args.indexOf('--rollback'); return i !== -1 ? args[i + 1] : null; })();

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const newUrl = (name) => `${HOST}/artwork/playlist-${slug(name)}-${STAMP}.jpg`;

async function main() {
  if (ROLLBACK) return doRollback(ROLLBACK);
  console.log(`\nLayout: ${FM_PLAYLIST_ART_LAYOUT}   Field: ${FIELD}`);
  console.log(APPLY ? '*** APPLY MODE — records WILL be written ***\n' : 'DRY RUN — nothing will be written\n');

  const plan = [];
  for (const name of TARGETS) {
    // '==' is exact: FM finds are case-insensitive and '=' alone means empty.
    const res  = await fmFindRecords(FM_PLAYLIST_ART_LAYOUT, [{ [NAME]: `==${name}` }], { limit: 5 });
    const rows = res?.data || [];
    if (rows.length !== 1) { console.log(`  !! ${name}: ${rows.length} record(s) — skipped`); continue; }
    const r    = rows[0];
    const from = String(r.fieldData?.[FIELD] ?? '').trim();
    const to   = newUrl(name);
    if (from === to) { console.log(`  == ${name}: already repointed`); continue; }
    plan.push({ recordId: String(r.recordId), name, from, to });
    console.log(`  -> ${name}  (record ${r.recordId})\n       from ${from || '(blank)'}\n       to   ${to}`);
  }
  if (!plan.length) { console.log('\nNothing to do.'); return; }
  if (!APPLY) { console.log(`\n${plan.length} record(s) would change. Re-run with --apply.`); return; }

  const rb = path.join('data', `playlist-art-repoint-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const journal = [];
  let ok = 0, bad = 0;
  for (const p of plan) {
    journal.push(p);
    fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync(rb, JSON.stringify(journal, null, 2));
    try { await fmUpdateRecord(FM_PLAYLIST_ART_LAYOUT, p.recordId, { [FIELD]: p.to }); ok++; }
    catch (e) { bad++; console.error(`  FAILED ${p.name}: ${e.message}`); }
  }
  console.log(`\nwritten ${ok} | failed ${bad}`);
  console.log(`rollback: ${rb}`);
  console.log(`\nTo undo:  node scripts/repoint-playlist-art.mjs --rollback ${rb}`);
}

async function doRollback(file) {
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`\nRolling back ${entries.length} record(s)`);
  let ok = 0, bad = 0;
  for (const e of entries) {
    try { await fmUpdateRecord(FM_PLAYLIST_ART_LAYOUT, e.recordId, { [FIELD]: e.from }); ok++; }
    catch (err) { bad++; console.error(`  FAILED ${e.name}: ${err.message}`); }
  }
  console.log(`Restored ${ok}, failed ${bad}`);
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exitCode = 1; })
      .finally(async () => { await closeFmPool(); });
