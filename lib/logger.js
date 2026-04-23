/**
 * lib/logger.js — Log-level-aware logger with per-tag debug gating.
 *
 * Usage:
 *   import { createLogger } from '../lib/logger.js';
 *   const log = createLogger('featured');
 *   log.debug('fetched', items.length, 'records');  // only logs if DEBUG includes 'featured' or '*'
 *   log.info('cache warmed');                        // always logs
 *   log.warn('fallback triggered');                  // always logs
 *   log.error('fatal', err);                         // always logs
 *
 * Enable debug output with:
 *   DEBUG=featured,trending node server.js
 *   DEBUG=*             node server.js    # enable all tags
 *
 * debug() is a no-op when disabled — no string formatting or IO cost.
 */

const DEBUG_ENV   = (process.env.DEBUG || '').trim();
const debugTags   = new Set(DEBUG_ENV.split(',').map((s) => s.trim()).filter(Boolean));
const allDebug    = debugTags.has('*') || debugTags.has('all') || debugTags.has('1');

export function isDebugEnabled(tag) {
  if (allDebug) return true;
  return debugTags.has(tag);
}

export function createLogger(tag) {
  const enabled = isDebugEnabled(tag);
  return {
    debug: enabled
      ? (...args) => console.log(`[${tag}]`, ...args)
      : () => {}, // cheap no-op; string args never evaluated
    info:  (...args) => console.log(`[${tag}]`, ...args),
    warn:  (...args) => console.warn(`[${tag}]`, ...args),
    error: (...args) => console.error(`[${tag}]`, ...args),
    /** true if this tag's debug output is enabled — use to guard expensive log building */
    isDebug: () => enabled
  };
}
