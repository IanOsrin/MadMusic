// ============================================================================
// fm-client.js — FileMaker Data API client
// Handles connection pooling, request queuing, token management, and all
// FileMaker API operations. Imported by server.js.
// ============================================================================

import 'dotenv/config';
import { fetch, Agent } from 'undici';

// Local helpers (same logic as server.js versions)
function parsePositiveInt(value, fallback) {
  const num = Number.parseInt(value, 10);
  if (Number.isFinite(num) && num > 0) return num;
  return fallback;
}

function parseNonNegativeInt(value, fallback) {
  const num = Number.parseInt(value, 10);
  if (Number.isFinite(num) && num >= 0) return num;
  return fallback;
}

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
let fmLastRequestTime = 0;
let fmStartChain = Promise.resolve();

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

export async function safeFetch(url, options = {}, { timeoutMs = 15000, retries = 2, dispatcher = null } = {}) {
  let attempt = 0;
  let backoff = 500;

  while (true) {
    let timedOut = false;
    let externalAbort = false;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, timeoutMs);

    const { signal: originalSignal, headers: originalHeaders, dispatcher: optionsDispatcher, ...rest } = options || {};

    const headers = new Headers(originalHeaders || {});
    const finalDispatcher = optionsDispatcher || dispatcher;
    if (!finalDispatcher && !headers.has('Connection')) {
      headers.set('Connection', 'close');
    }

    if (originalSignal) {
      if (originalSignal.aborted) {
        externalAbort = true;
        timeoutController.abort();
      } else {
        originalSignal.addEventListener(
          'abort',
          () => {
            externalAbort = true;
            timeoutController.abort();
          },
          { once: true }
        );
      }
    }

    const signals = [timeoutController.signal];
    if (originalSignal) signals.push(originalSignal);
    const composedSignal = signals.length > 1 ? AbortSignal.any(signals) : timeoutController.signal;

    try {
      const fetchOptions = { ...rest, headers, signal: composedSignal };
      if (finalDispatcher) {
        fetchOptions.dispatcher = finalDispatcher;
      }
      const response = await fetch(url, fetchOptions);
      clearTimeout(timer);
      return response;
    } catch (err) {
      clearTimeout(timer);
      err.timedOut = err.timedOut || timedOut;
      err.externalAbort = err.externalAbort || externalAbort;

      const message = String(err?.message || '').toLowerCase();
      const code = err?.code || err?.cause?.code;
      const retryable = !externalAbort && (
        err.timedOut ||
        RETRYABLE_NAMES.has(err?.name) ||
        (code && RETRYABLE_CODES.has(code)) ||
        message.includes('terminated')
      );

      if (retryable && attempt < retries) {
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
export async function fmWithAuth(fetchFn) {
  await ensureToken();
  let res = await fetchFn(fmToken);
  if (res.status === 401) {
    await fmLogin();
    res = await fetchFn(fmToken);
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
