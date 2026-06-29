#!/usr/bin/env node
// ============================================================================
// scripts/db/migrate.mjs — apply db/schema.sql to the Postgres mirror.
//
// Idempotent (schema.sql is all CREATE ... IF NOT EXISTS). Run after
// provisioning Render Postgres and setting DATABASE_URL:
//   npm run db:migrate
// ============================================================================

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isPgEnabled, getPool, closePgPool } from '../../lib/pg.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(here, '../../db/schema.sql');

async function main() {
  if (!isPgEnabled()) {
    console.error('[migrate] DATABASE_URL is not a postgres:// URL — nothing to do.');
    console.error('[migrate] Set DATABASE_URL to your Render Postgres connection string first.');
    process.exit(1);
  }
  const sql = await readFile(schemaPath, 'utf8');
  console.log(`[migrate] applying ${schemaPath} ...`);
  await getPool().query(sql);
  console.log('[migrate] schema applied ✓');
  await closePgPool();
}

main().catch(async (err) => {
  console.error('[migrate] failed:', err?.message || err);
  await closePgPool();
  process.exit(1);
});
