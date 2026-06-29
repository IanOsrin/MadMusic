import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// lib/pg.js and lib/metadata-source.js read env at import time, so each case
// stubs env then dynamically re-imports a fresh module graph.
async function freshImport(path) {
  vi.resetModules();
  return import(path);
}

describe('lib/pg.js — disabled-safe when DATABASE_URL is unset/non-postgres', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('isPgEnabled() is false when DATABASE_URL is unset', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const { isPgEnabled } = await freshImport('../../lib/pg.js');
    expect(isPgEnabled()).toBe(false);
  });

  it('isPgEnabled() is false for a non-postgres URL (e.g. legacy sqlite value)', async () => {
    vi.stubEnv('DATABASE_URL', 'sqlite:./madmusic.db');
    const { isPgEnabled } = await freshImport('../../lib/pg.js');
    expect(isPgEnabled()).toBe(false);
  });

  it('isPgEnabled() is true for a postgres:// URL', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@host:5432/db');
    const { isPgEnabled } = await freshImport('../../lib/pg.js');
    expect(isPgEnabled()).toBe(true);
  });

  it('getPool() throws a clear error when disabled', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const { getPool } = await freshImport('../../lib/pg.js');
    expect(() => getPool()).toThrow(/disabled/i);
  });

  it('pgPing() resolves (never throws) and reports not-configured when disabled', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const { pgPing } = await freshImport('../../lib/pg.js');
    await expect(pgPing()).resolves.toMatchObject({ ok: false });
  });

  it('closePgPool() is a safe no-op when nothing was opened', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const { closePgPool } = await freshImport('../../lib/pg.js');
    await expect(closePgPool()).resolves.toBeUndefined();
  });
});

describe('lib/metadata-source.js — defaults + degrade', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('defaults to filemaker when nothing is set', async () => {
    vi.stubEnv('METADATA_SOURCE', '');
    vi.stubEnv('DATABASE_URL', '');
    const { METADATA_SOURCE, usePostgresMetadata } = await freshImport('../../lib/metadata-source.js');
    expect(METADATA_SOURCE).toBe('filemaker');
    expect(usePostgresMetadata()).toBe(false);
  });

  it('degrades postgres -> filemaker when DATABASE_URL is missing', async () => {
    vi.stubEnv('METADATA_SOURCE', 'postgres');
    vi.stubEnv('DATABASE_URL', '');
    const { METADATA_SOURCE } = await freshImport('../../lib/metadata-source.js');
    expect(METADATA_SOURCE).toBe('filemaker');
  });

  it('honours postgres when DATABASE_URL is a postgres URL', async () => {
    vi.stubEnv('METADATA_SOURCE', 'postgres');
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@host:5432/db');
    const { METADATA_SOURCE, usePostgresMetadata } = await freshImport('../../lib/metadata-source.js');
    expect(METADATA_SOURCE).toBe('postgres');
    expect(usePostgresMetadata()).toBe(true);
  });
});
