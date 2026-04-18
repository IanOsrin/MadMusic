// ============================================================================
// fm-client.js — FileMaker Data API client
// Handles connection pooling, request queuing, token management, and all
// FileMaker API operations. Imported by server.js.
// ============================================================================

import 'dotenv/config';
import { fetch, Agent } from 'undici';
import { parsePositiveInt, parseNonNegativeInt } from './lib/format.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// HTTP CONNECTION POOL
// ============================================================================

const fmAgent = new Agent({
  connections: 20,              // Max 20 persistent connections to FileMaker
  pipelining: 1,                // 1 request per connection (HTTP/1.1 default)
  keepAliveTimeout: 60000,      // Keep connections alive for 60 seconds
  keepAliveMaxTimeout: 600000,  // Maximum keep-alive time: 10 minutes
  connect: {
    timeout: 30000,             // 30 second connection timeout
    keepAlive: true,
    keepAliveInitialDelay: 1000
  }
});

console.log('[INIT] FileMaker HTTP connection pool created (20 persistent connections)');

// ============================================================================
// FM REQUEST QUEUE
// Rate-limits and concurrency-caps all outgoing FileMaker requests.
// ============================================================================

const FM_TIMEOUT_MS = parsePositiveInt(process.env.FM_TIMEOUT_MS, 45000);
const fmDefaultFetchOptions = { timeoutMs: FM_TIMEOUT_MS, retries: 1, dispatcher: fmAgent };
const FM_MAX_CONCURRENT_REQUESTS = parsePositiveInt(process.env.FM_MAX_CONCURRENT_REQUESTS, 8);
const FM_MIN_REQUEST_INTERVAL_MS = parseNonNegativeInt(process.env.FM_MIN_REQUEST_INTERVAL_MS, 10);

const fmRequestQueue = [];
let fmActiveRequests = 0;
let fmConsecutive401s = 0;        // reset on success; triggers fast-fail after threshold
const FM_MAX_CONSECUTIVE_401S = 3; // if we hit this, credentials are likely wrong
let fmLastRequestTime = 0;
let fmStartChain = Promise.resolve();

// Exported so admin health endpoint can report queue state without importing internals.
export function fmQueueStats() {
  return {
    queueDepth:     fmRequestQueue.length,
    activeRequests: fmActiveRequests,
    maxConcurrent:  FM_MAX_CONCURRENT_REQUESTS,
    consecutive401s: fmConsecutive401s,
  };
}

async function takeStartSlot() {
  let release;
  const prev = fmStartChain;
  fmStartChain = new Promise((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    if (FM_MIN_REQUEST_INTERVAL_MS > 0) {
      const elapsed = Date.now() - fmLastRequestTime;
      const waitMs = FM_MIN_REQUEST_INTERVAL_MS - elapsed;
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    }
    fmLastRequestTime = Date.now();
  } finally {
    release();
  }
}

function processFmQueue() {
  while (fmRequestQueue.length && fmActiveRequests < FM_MAX_CONCURRENT_REQUESTS) {
    const job = fmRequestQueue.shift();
    fmActiveRequests += 1;
    (async () => {
      try {
        await takeStartSlot();
        const result = await job.task();
        job.resolve(result);
      } catch (err) {
        job.reject(err);
      } finally {
        fmActiveRequests -= 1;
        if (fmRequestQueue.length) {
          process.nextTick(processFmQueue);
        }
      }
    })();
  }
}

function enqueueFmRequest(task) {
  return new Promise((resolve, reject) => {
    fmRequestQueue.push({ task, resolve, reject });
    if (fmRequestQueue.length > FM_MAX_CONCURRENT_REQUESTS * 4) {
      console.warn(`[FM] Request queue length: ${fmRequestQueue.length}`);
    }
    processFmQueue();
  });
}

export function fmSafeFetch(url, options, overrides = {}) {
  const finalOptions = { ...fmDefaultFetchOptions, ...overrides };
  return enqueueFmRequest(() => safeFetch(url, options, finalOptions));
}

// ============================================================================
// FM CONNECTION CONFIG + TOKEN STATE
// ============================================================================

const FM_HOST = process.env.FM_HOST;
const FM_DB = process.env.FM_DB;
const FM_USER = process.env.FM_USER;
const FM_PASS = process.env.FM_PASS;

if (!FM_HOST || !FM_DB || !FM_USER || !FM_PASS) {
  console.warn('[MASS] Missing .env values; expected FM_HOST, FM_DB, FM_USER, FM_PASS');
}

export const fmBase = `${FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(FM_DB)}`;
console.log(`[MASS] FileMaker connection: ${FM_HOST} -> Database: ${FM_DB}`);

let fmToken = null;
let fmTokenExpiresAt = 0;
let fmLoginPromise = null;

// ============================================================================
// SAFE FETCH — timeout + exponential backoff retry
// ============================================================================

const RETRYABLE_CODES = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'ETIMEDOUT']);
const RETRYABLE_NAMES = new Set(['AbortError']);

function buildFetchHeaders(originalHeaders, finalDispatcher) {
  const headers = new Headers(originalHeaders || {});
  if (!finalDispatcher && !headers.has('Connection')) {
    headers.set('Connection', 'close');
  }
  return headers;
}

function wireExternalAbort(originalSignal, timeoutController, state) {
  if (!originalSignal) return timeoutController.signal;
  if (originalSignal.aborted) {
    state.externalAbort = true;
    timeoutController.abort();
  } else {
    originalSignal.addEventListener(
      'abort',
      () => { state.externalAbort = true; timeoutController.abort(); },
      { once: true }
    );
  }
  return AbortSignal.any([timeoutController.signal, originalSignal]);
}

function isRetryableError(err, externalAbort) {
  if (externalAbort) return false;
  if (err.timedOut) return true;
  if (RETRYABLE_NAMES.has(err?.name)) return true;
  const code = err?.code || err?.cause?.code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  return String(err?.message || '').toLowerCase().includes('terminated');
}

export async function safeFetch(url, options = {}, { timeoutMs = 15000, retries = 2, dispatcher = null } = {}) {
  let attempt = 0;
  let backoff = 500;

  while (true) {
    const state = { timedOut: false, externalAbort: false };
    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      state.timedOut = true;
      timeoutController.abort();
    }, timeoutMs);

    const { signal: originalSignal, headers: originalHeaders, dispatcher: optionsDispatcher, ...rest } = options || {};
    const finalDispatcher = optionsDispatcher || dispatcher;
    const headers = buildFetchHeaders(originalHeaders, finalDispatcher);
    const composedSignal = wireExternalAbort(originalSignal, timeoutController, state);

    try {
      const fetchOptions = { ...rest, headers, signal: composedSignal };
      if (finalDispatcher) fetchOptions.dispatcher = finalDispatcher;
      const response = await fetch(url, fetchOptions);
      clearTimeout(timer);
      return response;
    } catch (err) {
      clearTimeout(timer);
      err.timedOut = err.timedOut || state.timedOut;
      err.externalAbort = err.externalAbort || state.externalAbort;

      if (isRetryableError(err, state.externalAbort) && attempt < retries) {
        await sleep(backoff);
        attempt += 1;
        backoff *= 2;
        continue;
      }
      throw err;
    }
  }
}

// ============================================================================
// FM AUTH — login, token refresh, 401 retry wrapper
// ============================================================================

export async function fmLogin() {
  if (fmLoginPromise) {
    return fmLoginPromise;
  }

  fmLoginPromise = (async () => {
    try {
      const loginUrl = `${fmBase}/sessions`;
      console.log(`[FM LOGIN] Attempting to connect to: ${loginUrl}`);
      console.log(`[FM LOGIN] FM_HOST from env: ${FM_HOST}`);
      console.log(`[FM LOGIN] FM_DB from env: ${FM_DB}`);
      const res = await fmSafeFetch(loginUrl, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(`${FM_USER}:${FM_PASS}`).toString('base64')
        },
        body: JSON.stringify({})
      }, { retries: 1 });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = json?.messages?.[0]?.message || `HTTP ${res.status}`;
        throw new Error(`FM login failed: ${msg}`);
      }
      const token = json?.response?.token;
      if (!token) throw new Error('FM login returned no token');
      fmToken = token;
      fmTokenExpiresAt = Date.now() + (11.5 * 60 * 1000);
      fmConsecutive401s = 0; // Successful login — credentials are good
      return fmToken;
    } finally {
      fmLoginPromise = null;
    }
  })();

  return fmLoginPromise;
}

export async function ensureToken() {
  if (!fmToken || Date.now() >= fmTokenExpiresAt) {
    await fmLogin();
  }
  return fmToken;
}

// Handles the token-refresh-on-401 pattern in one place.
// Tracks consecutive 401s to distinguish an expired token (recoverable) from
// bad credentials (not recoverable) — fails fast after FM_MAX_CONSECUTIVE_401S.
export async function fmWithAuth(fetchFn) {
  if (fmConsecutive401s >= FM_MAX_CONSECUTIVE_401S) {
    throw new Error(
      `FM authentication failing repeatedly (${fmConsecutive401s} consecutive 401s) — check FM credentials`
    );
  }

  await ensureToken();
  let res = await fetchFn(fmToken);

  if (res.status === 401) {
    fmConsecutive401s += 1;
    console.warn(`[FM] 401 received (consecutive: ${fmConsecutive401s}/${FM_MAX_CONSECUTIVE_401S}) — forcing token refresh`);

    if (fmConsecutive401s >= FM_MAX_CONSECUTIVE_401S) {
      fmToken = null;
      fmTokenExpiresAt = 0;
      throw new Error(
        `FM authentication failing repeatedly (${fmConsecutive401s} consecutive 401s) — check FM credentials`
      );
    }

    // Invalidate cached token so fmLogin() issues a fresh POST /sessions
    fmToken = null;
    fmTokenExpiresAt = 0;
    await fmLogin(); // resets fmConsecutive401s on success; throws on credential error
    res = await fetchFn(fmToken);

    if (res.status === 401) {
      fmConsecutive401s += 1;
      console.error(`[FM] Still 401 after fresh login (consecutive: ${fmConsecutive401s}) — credentials may be invalid`);
    } else {
      fmConsecutive401s = 0;
    }
  } else {
    fmConsecutive401s = 0; // Any non-401 response resets the counter
  }

  return res;
}

// ============================================================================
// FM API FUNCTIONS
// ============================================================================

export async function fmPost(pathSuffix, body) {
  const url = `${fmBase}${pathSuffix}`;
  return fmWithAuth((token) => fmSafeFetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(body)
  }));
}

export async function fmGet(pathSuffix) {
  const url = `${fmBase}${pathSuffix}`;
  return fmWithAuth((token) => fmSafeFetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  }));
}

export async function fmGetAbsolute(u, { signal } = {}) {
  const isFmUrl = typeof u === 'string' && u.startsWith(FM_HOST);
  if (!isFmUrl) {
    return fmSafeFetch(u, { signal }, { retries: 1 });
  }
  return fmWithAuth((token) => fmSafeFetch(u, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal
  }, { retries: 1 }));
}

export async function fmCreateRecord(layout, fieldData) {
  const url = `${fmBase}/layouts/${encodeURIComponent(layout)}/records`;
  const res = await fmWithAuth((token) => fmSafeFetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ fieldData })
  }));
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.messages?.[0]?.message || 'FM error';
    const code = json?.messages?.[0]?.code;
    if (code === '102' || code === 102) {
      console.error('[FM] Field is missing (102) — fields attempted:', Object.keys(fieldData).join(', '));
    }
    throw new Error(`FM create failed: ${msg} (${code ?? 'n/a'})`);
  }
  return json?.response || null;
}

export async function fmUpdateRecord(layout, recordId, fieldData) {
  if (!recordId) throw new Error('fmUpdateRecord requires recordId');
  const url = `${fmBase}/layouts/${encodeURIComponent(layout)}/records/${encodeURIComponent(recordId)}`;
  const res = await fmWithAuth((token) => fmSafeFetch(url, {
    method: 'PATCH',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ fieldData })
  }));
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.messages?.[0]?.message || 'FM error';
    const code = json?.messages?.[0]?.code;
    throw new Error(`FM update failed: ${msg} (${code ?? 'n/a'})`);
  }
  return json?.response || null;
}

export async function fmGetRecordById(layout, recordId) {
  if (!recordId) return null;
  const url = `${fmBase}/layouts/${encodeURIComponent(layout)}/records/${encodeURIComponent(recordId)}`;
  const res = await fmWithAuth((token) => fmSafeFetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  }));
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  return json?.response?.data?.[0] || null;
}

export async function fmFindRecords(layout, queries, { limit = 1, offset = 1, sort = [] } = {}) {
  const payload = { query: queries, limit, offset };
  if (Array.isArray(sort) && sort.length) {
    payload.sort = sort;
  }
  const r = await fmPost(`/layouts/${encodeURIComponent(layout)}/_find`, payload);
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = json?.messages?.[0]?.message || 'FM error';
    const code = json?.messages?.[0]?.code;
    return { ok: false, status: r.status, msg, code, data: [], total: 0 };
  }
  const data = json?.response?.data || [];
  const total = json?.response?.dataInfo?.foundCount ?? data.length;
  return { ok: true, data, total };
}

export async function fmDeleteRecord(layout, recordId) {
  if (!recordId) throw new Error('fmDeleteRecord requires recordId');
  const url = `${fmBase}/layouts/${encodeURIComponent(layout)}/records/${encodeURIComponent(recordId)}`;
  const res = await fmWithAuth((token) => fmSafeFetch(url, {
    method: 'DELETE',
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  }));
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    const msg  = json?.messages?.[0]?.message || 'FM error';
    const code = json?.messages?.[0]?.code;
    throw new Error(`FM delete failed: ${msg} (${code ?? 'n/a'})`);
  }
  return true;
}

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

export async function closeFmPool() {
  try {
    await fmAgent.close();
    console.log('[MASS] FileMaker connection pool closed');
  } catch (err) {
    console.warn('[MASS] Error closing FileMaker pool:', err?.message || err);
  }
}
