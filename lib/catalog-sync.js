// ============================================================================
// lib/catalog-sync.js — one-way FileMaker → Postgres mirror of API_Album_Songs.
//
// Dependency-injected so it runs against mocks in tests and real fm-client / pg
// in scripts/sync/catalog-sync.mjs. Strategy: full resync each run —
//   1. stamp every upserted row with runStartedAt
//   2. paginate ALL records from FM, mapping + upserting in batches
//   3. DELETE rows whose synced_at < runStartedAt (records removed from FM)
//   4. record counts/status in sync_state
// Full resync is idempotent and self-healing; incremental is a later option
// once a FM modification-timestamp field is confirmed (see docs/postgres-mirror.md).
// ============================================================================

import { mapRecordToRow, buildUpsertQuery } from './catalog-mapper.js';

const noopLog = () => {};

/**
 * @param {Object} deps
 * @param {(pathSuffix:string)=>Promise<Response>} deps.fmGet  — fm-client.fmGet
 * @param {(text:string, params?:any[])=>Promise<{rowCount:number}>} deps.query — pg query
 * @param {string}   deps.layout      — FM layout (e.g. 'API_Album_Songs')
 * @param {number}  [deps.pageSize]   — records per FM page (default 500)
 * @param {Date}    [deps.runStartedAt] — injectable for deterministic tests
 * @param {Function}[deps.log]
 * @returns {Promise<{ rowsTotal:number, rowsUpserted:number, rowsDeleted:number, pages:number }>}
 */
export async function runCatalogSync({ fmGet, query, layout, pageSize = 500, runStartedAt, log = noopLog }) {
  if (typeof fmGet !== 'function' || typeof query !== 'function') {
    throw new Error('runCatalogSync requires fmGet + query');
  }
  if (!layout) throw new Error('runCatalogSync requires a layout');

  const startedAt = runStartedAt || new Date();
  const layoutPath = `/layouts/${encodeURIComponent(layout)}/records`;

  await markSyncState(query, layout, { last_status: 'running', last_error: null });

  let offset = 1;
  let pages = 0;
  let rowsUpserted = 0;
  let foundCount = Infinity;

  try {
    while (offset <= foundCount) {
      const res = await fmGet(`${layoutPath}?_limit=${pageSize}&_offset=${offset}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = json?.messages?.[0]?.message || `HTTP ${res.status}`;
        throw new Error(`FM read failed at offset ${offset}: ${msg}`);
      }

      const data = json?.response?.data || [];
      foundCount = json?.response?.dataInfo?.foundCount ?? data.length;
      if (data.length === 0) break;

      const rows = data.map(mapRecordToRow).filter(Boolean);
      const upsert = buildUpsertQuery(rows, startedAt);
      if (upsert) {
        await query(upsert.text, upsert.params);
        rowsUpserted += rows.length;
      }

      pages += 1;
      offset += pageSize;
      log(`[catalog-sync] page ${pages}: upserted ${rowsUpserted}/${foundCount}`);
    }

    // Prune records that vanished from FileMaker since this run started.
    const del = await query('DELETE FROM tracks WHERE synced_at < $1', [startedAt]);
    const rowsDeleted = del?.rowCount || 0;

    await markSyncState(query, layout, {
      last_status: 'ok',
      last_error: null,
      last_synced_at: startedAt,
      rows_upserted: rowsUpserted,
      rows_total: rowsUpserted,
    });

    log(`[catalog-sync] done: ${rowsUpserted} upserted, ${rowsDeleted} pruned, ${pages} pages`);
    return { rowsTotal: rowsUpserted, rowsUpserted, rowsDeleted, pages };
  } catch (err) {
    await markSyncState(query, layout, { last_status: 'error', last_error: String(err?.message || err) })
      .catch(() => {});
    throw err;
  }
}

// Reconcile the is_new_release column. New_Release lives on the Tape Files
// relationship and is NOT returned in fieldData, so it can't be derived from the
// synced `raw` — we fetch the flagged recordIds directly and set the column
// (true for matches, false for everyone else) in one statement.
const NEW_RELEASE_FIELDS = ['Tape Files::New_Release', 'New_Release'];
export async function syncNewReleaseFlags({ fmPost, query, layout, log = noopLog }) {
  if (typeof fmPost !== 'function' || typeof query !== 'function' || !layout) {
    throw new Error('syncNewReleaseFlags requires fmPost + query + layout');
  }
  let ids = null;
  for (const field of NEW_RELEASE_FIELDS) {
    const r = await fmPost(`/layouts/${encodeURIComponent(layout)}/_find`, { query: [{ [field]: 'Yes' }], limit: 5000 });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { ids = (j?.response?.data || []).map((rec) => String(rec.recordId)); break; }
    // FM 102 "field missing" → try the next candidate; anything else, keep trying too.
  }
  if (ids === null) {
    log('[catalog-sync] new-release field not found on layout — leaving is_new_release unchanged');
    return { flagged: null };
  }
  await query('UPDATE tracks SET is_new_release = (fm_record_id = ANY($1::text[]))', [ids]);
  log(`[catalog-sync] is_new_release reconciled: ${ids.length} flagged`);
  return { flagged: ids.length };
}

// Upsert one sync_state row, patching only the provided fields.
async function markSyncState(query, source, patch) {
  const cols = ['source', ...Object.keys(patch), 'updated_at'];
  const vals = [source, ...Object.values(patch), new Date()];
  const placeholders = vals.map((_, i) => `$${i + 1}`);
  const updateSet = cols.filter((c) => c !== 'source').map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  await query(
    `INSERT INTO sync_state (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) ` +
    `ON CONFLICT (source) DO UPDATE SET ${updateSet}`,
    vals,
  );
}
