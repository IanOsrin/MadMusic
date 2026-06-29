#!/usr/bin/env node
// scripts/db/peek.mjs — read-only snapshot of the Postgres catalog mirror.
//   npm run db:peek
import 'dotenv/config';
import { isPgEnabled, query, closePgPool } from '../../lib/pg.js';

if (!isPgEnabled()) { console.error('DATABASE_URL is not a postgres:// URL.'); process.exit(1); }
const one = async (q) => (await query(q)).rows[0];
const all = async (q) => (await query(q)).rows;

console.log('\n── sync_state ──');
console.table(await all('SELECT source, last_status, rows_total, last_synced_at FROM sync_state'));

console.log('── totals ──');
const t = await one(`SELECT
  count(*) total,
  count(*) FILTER (WHERE s3_audio_url IS NOT NULL) with_audio,
  count(*) FILTER (WHERE is_featured) featured,
  count(*) FILTER (WHERE is_g100) g100,
  count(*) FILTER (WHERE is_single) singles,
  count(*) FILTER (WHERE is_global_fav) global_fav,
  count(*) FILTER (WHERE is_new_release) new_release
  FROM tracks`);
console.table([t]);

console.log('── distinct albums / genres ──');
console.table([await one(`SELECT
  (SELECT count(*) FROM (SELECT DISTINCT lower(album_title), lower(album_artist) FROM tracks) a) albums,
  (SELECT count(DISTINCT genre) FROM tracks WHERE genre <> '') genres`)]);

console.log('── visibility ──');
console.table(await all(`SELECT coalesce(visibility,'(null)') visibility, count(*) FROM tracks GROUP BY 1 ORDER BY 2 DESC`));

await closePgPool();
