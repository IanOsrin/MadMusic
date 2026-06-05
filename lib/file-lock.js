/**
 * lib/file-lock.js — Cross-process advisory file locking.
 * Uses O_EXCL (fail-if-exists) to atomically create lockfiles.
 * Stale locks older than LOCK_STALE_MS are automatically broken.
 */

import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const LOCK_STALE_MS        = 10_000; // treat lock as stale after 10 seconds
const LOCK_RETRY_INTERVAL_MS = 30;
const LOCK_TIMEOUT_MS      = 8_000;

export async function acquireLock(targetPath) {
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      // O_EXCL: fails atomically if file already exists — no TOCTOU race
      const fh = await fs.open(lockPath, 'wx');
      await fh.close();
      return lockPath; // caller must pass this to releaseLock()
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // Check if the existing lock is stale (e.g. process crashed mid-write)
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          // Break the stale lock atomically: rename it to a unique temp name so
          // only ONE racing process can succeed (rename of a single source
          // succeeds for exactly one caller; the loser gets ENOENT). This avoids
          // the TOCTOU race where two processes both unlink and both acquire.
          const stalePath = `${lockPath}.stale.${process.pid}.${randomBytes(6).toString('hex')}`;
          try {
            await fs.rename(lockPath, stalePath);
          } catch (renameErr) {
            // ENOENT: another process already broke/took the lock — just retry.
            if (renameErr.code === 'ENOENT') continue;
            throw renameErr;
          }
          await fs.unlink(stalePath).catch(() => {});
          continue; // retry immediately after breaking stale lock
        }
      } catch {
        // lock was already removed between our check and stat — retry
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`[MASS] Write lock timeout for ${targetPath} — another process may be stuck`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));
    }
  }
}

export async function releaseLock(lockPath) {
  try {
    await fs.unlink(lockPath);
  } catch {
    // ignore: lock may have already been cleaned up
  }
}
