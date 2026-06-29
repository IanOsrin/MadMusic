// ============================================================================
// lib/pg.js — PostgreSQL connection pool
//
// Postgres is a ONE-WAY READ MIRROR of MadStreamer (fmcloud). FileMaker stays
// the system of record; this pool only ever serves catalog reads once
// METADATA_SOURCE=postgres flips the read path. See docs/postgres-mirror.md.
//
// DISABLED-SAFE: if DATABASE_URL is unset (or not a postgres:// URL) the pool
// never initialises, isPgEnabled() is false, and the app runs on FileMaker
// exactly as before. This file must never become a hard dependency until the
// flag is flipped — so importing it has zero side effects.
// ============================================================================

import 'dotenv/config';
import pg from 'pg';
import { parsePositiveInt } from './format.js';

const { Pool } = pg;

const RAW_URL = (process.env.DATABASE_URL || '').trim();
const IS_PG_URL = /^postgres(ql)?:\/\//i.test(RAW_URL);

// ── SSL policy ───────────────────────────────────────────────────────────────
// Render's managed Postgres external URLs serve a cert chain Node won't verify
// by default, so external connections need ssl with rejectUnauthorized:false.
// Internal/localhost connections need no SSL. Override with DATABASE_SSL:
//   'no-verify' → ssl on, don't verify chain (Render external — default off-localhost)
//   'true'      → ssl on, verify chain
//   'false'     → ssl off
function resolveSsl(url) {
  const mode = (process.env.DATABASE_SSL || '').toLowerCase();
  if (mode === 'false') return false;
  if (mode === 'true') return { rejectUnauthorized: true };
  if (mode === 'no-verify') return { rejectUnauthorized: false };
  // Auto: no SSL for localhost, lenient SSL otherwise.
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url) || /\blocalhost\b/.test(url);
  return isLocal ? false : { rejectUnauthorized: false };
}

let pool = null;

export function isPgEnabled() {
  return IS_PG_URL;
}

/**
 * Lazily create and return the shared pool. Throws a clear error if Postgres is
 * not configured — callers on the FileMaker path should never reach here.
 */
export function getPool() {
  if (!IS_PG_URL) {
    throw new Error('[pg] DATABASE_URL is not a postgres:// URL — Postgres is disabled');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: RAW_URL,
      ssl: resolveSsl(RAW_URL),
      max: parsePositiveInt(process.env.PG_POOL_MAX, 10),
      idleTimeoutMillis: parsePositiveInt(process.env.PG_IDLE_TIMEOUT_MS, 30000),
      connectionTimeoutMillis: parsePositiveInt(process.env.PG_CONNECT_TIMEOUT_MS, 10000),
    });
    pool.on('error', (err) => {
      // Idle client errors must not crash the process.
      console.error('[pg] idle client error:', err?.message || err);
    });
    console.log(`[pg] pool created (max ${pool.options.max}, ssl ${pool.options.ssl ? 'on' : 'off'})`);
  }
  return pool;
}

/** Run a parameterised query. Returns the node-postgres result. */
export function query(text, params) {
  return getPool().query(text, params);
}

/** Lightweight health check. Returns { ok, latencyMs, error? } — never throws. */
export async function pgPing() {
  if (!IS_PG_URL) return { ok: false, error: 'not configured' };
  const start = Date.now();
  try {
    await getPool().query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err?.message || String(err) };
  }
}

/** Graceful shutdown — mirror of closeFmPool(). Safe to call when disabled. */
export async function closePgPool() {
  if (!pool) return;
  try {
    await pool.end();
    console.log('[pg] pool closed');
  } catch (err) {
    console.warn('[pg] error closing pool:', err?.message || err);
  } finally {
    pool = null;
  }
}
