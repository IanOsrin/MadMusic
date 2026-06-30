#!/usr/bin/env node
// ============================================================================
// scripts/semantic/refresh-index.mjs — rebuild the "Similar albums" index from
// Postgres and publish it to S3. Built for the Render Docker cron, but runs
// anywhere with AWS creds + DATABASE_URL.
//
// Incremental: pulls the prior semantic.db from S3 so build-index only re-embeds
// tracks whose document changed. Publishes BOTH the semantic.db (state for the
// next run) and suggest.db (the slim index the app hot-swaps).
// ============================================================================
import { execSync } from 'node:child_process';

const BUCKET  = process.env.SUGGEST_S3_BUCKET   || 'mass-music-audio-files';
const SEM_KEY = process.env.SUGGEST_SEMANTIC_KEY || 'suggest/semantic.db';
const IDX_KEY = process.env.SUGGEST_INDEX_KEY    || 'suggest/album-index.db';

const run = (cmd) => { console.log(`+ ${cmd}`); execSync(cmd, { stdio: 'inherit' }); };

// 1. Prior index state for the incremental build (absent on the very first run).
try {
  run(`aws s3 cp s3://${BUCKET}/${SEM_KEY} data/semantic.db`);
} catch {
  console.log('[refresh] no prior semantic.db on S3 — full rebuild this run');
}

// 2–3. Build from Postgres (build-index defaults to PG when DATABASE_URL is set;
// SUGGEST_SOURCE=postgres makes it explicit). semantic.db → suggest.db.
run('node scripts/semantic/build-index.mjs');
run('node scripts/semantic/build-suggest.mjs');

// 4. Publish: the incremental state + the live album index the app hot-swaps.
run(`aws s3 cp data/semantic.db s3://${BUCKET}/${SEM_KEY}`);
run(`aws s3 cp data/suggest.db s3://${BUCKET}/${IDX_KEY} --content-type application/x-sqlite3`);

console.log('[refresh] done — app hot-swaps the new index within SUGGEST_REFRESH_MINUTES');
