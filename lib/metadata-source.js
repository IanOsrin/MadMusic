// ============================================================================
// lib/metadata-source.js — which backend serves catalog READS.
//
//   'filemaker' (default) → routes/catalog/* read FileMaker, as today.
//   'postgres'            → routes/catalog/* read the Postgres mirror.
//
// FileMaker remains the system of record either way; this only switches the
// catalog READ path. Default is 'filemaker' so local + main are untouched —
// flip to 'postgres' ONLY in the LIVE env, after the mirror is populated.
// See docs/postgres-mirror.md.
// ============================================================================

import { isPgEnabled } from './pg.js';

const RAW = (process.env.METADATA_SOURCE || 'filemaker').toLowerCase();

// Refuse to claim 'postgres' if no Postgres is configured — degrade to
// filemaker so a misconfigured env can never blank the catalog.
const RESOLVED = RAW === 'postgres' && isPgEnabled() ? 'postgres' : 'filemaker';

if (RAW === 'postgres' && !isPgEnabled()) {
  console.warn('[metadata-source] METADATA_SOURCE=postgres but DATABASE_URL is not set — falling back to filemaker');
}

export const METADATA_SOURCE = RESOLVED;
export const usePostgresMetadata = () => METADATA_SOURCE === 'postgres';
