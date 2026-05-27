import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { acquireLock, releaseLock } from '../../lib/file-lock.js';

const tmpFile = () => path.join(os.tmpdir(), `mass-lock-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

const tracked = [];
afterEach(async () => {
  while (tracked.length) {
    const p = tracked.pop();
    await fs.unlink(p).catch(() => {});
    await fs.unlink(p + '.lock').catch(() => {});
  }
});

describe('file-lock', () => {
  it('acquires and releases a lock', async () => {
    const f = tmpFile(); tracked.push(f);
    const lockPath = await acquireLock(f);
    expect(lockPath).toBe(f + '.lock');
    await expect(fs.access(lockPath)).resolves.toBeUndefined();
    await releaseLock(lockPath);
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it('second acquire waits until first releases (serialises)', async () => {
    const f = tmpFile(); tracked.push(f);
    const a = await acquireLock(f);
    let bResolved = false;
    const bPromise = acquireLock(f).then((p) => { bResolved = true; return p; });
    await new Promise((r) => setTimeout(r, 100));
    expect(bResolved).toBe(false);
    await releaseLock(a);
    const b = await bPromise;
    expect(bResolved).toBe(true);
    await releaseLock(b);
  });

  it('breaks stale locks (mtime > 10s old)', async () => {
    const f = tmpFile(); tracked.push(f);
    // Manually create a stale lockfile with mtime 30s ago
    const lockPath = f + '.lock';
    await fs.writeFile(lockPath, '');
    const past = new Date(Date.now() - 30_000);
    await fs.utimes(lockPath, past, past);
    // acquireLock should break it
    const newLock = await acquireLock(f);
    expect(newLock).toBe(lockPath);
    await releaseLock(newLock);
  });

  it('releaseLock is idempotent', async () => {
    const f = tmpFile(); tracked.push(f);
    const lockPath = await acquireLock(f);
    await releaseLock(lockPath);
    await expect(releaseLock(lockPath)).resolves.toBeUndefined();
  });
});
