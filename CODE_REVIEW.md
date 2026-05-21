# Mad Music Streamer — Code Review
_Reviewed: May 2026_

---

## Summary

The codebase is generally well-structured with solid patterns: parameterised SQL queries, Paystack webhook signature verification, a file-lock-protected token store, input validators, and good error handling throughout. The issues below are ranked by severity — fix the Critical and High ones before going to production.

---

## Critical

### 1. SSRF in `/api/audio-proxy` — missing private IP check

**File:** `server.js`, lines 445–467

The container proxy (`/api/container`) correctly calls `isPrivateHostname()` before forwarding a URL. The audio proxy does **not**:

```js
app.get('/api/audio-proxy', async (req, res) => {
  const target = new URL(url);
  if (target.protocol !== 'https:') return res.status(400)...
  // ← no isPrivateHostname() check here
  const upstream = await fetch(url, ...);
```

An attacker can send `url=https://192.168.1.1/anything` and the server will forward the request to an internal host. Add the same guard that already exists in `stream.js`:

```js
const { hostname } = new URL(url);
if (isPrivateHostname(hostname)) {
  return res.status(400).json({ error: 'Private/internal addresses not allowed' });
}
```

---

### 2. Hardcoded fallback key for Audio Lab

**File:** `server.js`, line 423

```js
const validKey = process.env.AUDIO_LAB_KEY || 'abc123';
```

If `AUDIO_LAB_KEY` is not set in the environment, anyone who knows (or guesses) `abc123` can activate Audio Lab on their token. Either require the env var unconditionally or disable the feature when it is missing:

```js
const validKey = process.env.AUDIO_LAB_KEY;
if (!validKey) return res.status(503).json({ ok: false, error: 'Audio Lab not configured' });
```

---

## High

### 3. Cookie forgery bypass in `requireTokenEmail`

**File:** `lib/auth.js`, lines 201–212

```js
const tokenEmail   = req.accessToken?.email || null;
const cookieEmail  = parseCookies(req)['mass.email'] || null;
const email        = tokenEmail || cookieEmail || tokenCode;
```

When a token was issued without an email (i.e. `tokenEmail` is null), the function falls back to the **client-controlled** `mass.email` cookie. Any user with a valid token can set that cookie to `someone-else@example.com` and read or modify another user's library and playlists.

The cookie fallback should be removed entirely, or at minimum it must only be trusted for the token that set it (store the email inside the validated token record, not in a naked cookie).

---

### 4. Timing-unsafe admin secret comparisons

**Files:** `routes/admin.js` line 38, `lib/auth.js` line 215

Both `requireAdminKey` and `adminAuth` use JavaScript's `!==` operator:

```js
if (!provided || provided !== ADMIN_SECRET) { ... }
```

String `!==` short-circuits on the first differing byte, leaking timing information that can be exploited to brute-force the secret over many requests. Use `crypto.timingSafeEqual`:

```js
import { timingSafeEqual } from 'node:crypto';

const a = Buffer.from(provided.padEnd(64));
const b = Buffer.from(ADMIN_SECRET.padEnd(64));
if (provided.length !== ADMIN_SECRET.length || !timingSafeEqual(a, b)) { ... }
```

---

### 5. Admin secret exposed in server logs via query param

**File:** `routes/ingest.js`, lines 243–248

```js
const token = req.headers.authorization?.replace('Bearer ', '').trim()
           || req.query.token   // ← written to access logs
```

The `?token=` fallback is there so `<audio src="...?token=SECRET">` works in browsers. However, the full URL — including the secret — appears in every access log line, browser history, and Referer headers. Consider signing short-lived audio preview URLs (e.g. with a HMAC and a 60-second expiry) rather than embedding the long-lived admin secret in the URL.

---

## Medium

### 6. No rate limiting or auth on `/api/ingest/submit`

**File:** `routes/ingest.js`, line 129

The submission endpoint is intentionally public (invite-optional), but:

- The `upload` multer instance allows files up to **2 GB**.
- There is no rate limiter applied to `/api/ingest/`.
- A bot can fill the server disk quickly with repeated large uploads.

Add an `expensiveLimiter`-style rate limit and consider a max-file-size that reflects realistic audio submissions (e.g. 500 MB).

---

### 7. No size cap on bulk playlist track import

**File:** `routes/playlists.js`, line 180

```js
const rawTracks = Array.isArray(req.body?.tracks) ? req.body.tracks : [];
```

There is no upper bound on `rawTracks.length`. A request with 100,000 tracks will be normalised and written to FileMaker. Add a cap before processing:

```js
if (rawTracks.length > 500) {
  return res.status(400).json({ ok: false, error: 'Maximum 500 tracks per bulk import' });
}
```

---

### 8. Import code length not validated before base64 decode

**File:** `routes/playlists.js`, line 713

```js
importedTrackIds = decodeImportCode(importCode);
```

`importCode` is an arbitrary user string. A megabyte-long string will be decoded and split before the 100-item cap is applied. Validate length first:

```js
if (importCode.length > 4096) {
  return res.status(400).json({ ok: false, error: 'Import code too long' });
}
```

---

### 9. Internal error details returned to clients

Multiple `catch` blocks return `err.message` directly to the API consumer, potentially leaking file paths, DB column names, or stack fragments. Examples:

- `routes/ingest.js` line 189: `res.status(500).json({ error: err.message })`
- `routes/playlists.js` line 531: `res.status(500).json({ ..., detail: err?.message })`

In production, map unhandled errors to a generic message and log the original internally:

```js
console.error('[ingest] Submit error:', err);
res.status(500).json({ error: 'Submission failed' });
```

---

## Low / Informational

### 10. Misleading field name `Token_Duration_Hours` (stores seconds)

**File:** `lib/token-store.js`, line 321; `lib/auth.js`, line 118

The comment correctly explains the field stores seconds despite the name, and the arithmetic is right, but this is a maintenance trap. Add an explicit comment at every call site that writes to this field, or rename the variable to `durationSeconds` (which it already uses correctly in the local scope) and document the discrepancy with FileMaker.

---

### 11. Paystack payload logged at `console.log`

**File:** `routes/payments.js`, lines 312 and 397

```js
console.log(`[MASS] Paystack initialize payload:`, JSON.stringify(paystackPayload));
```

This logs the user's email and plan details on every payment initialisation. Consider downgrading to `console.debug` or only logging the reference and plan name, to reduce PII in logs.

---

### 12. Ingest portal HTML served without cache-control headers

**File:** `server.js`, lines 374–375

```js
app.get('/ingest',       (_req, res) => res.sendFile(...));
app.get('/ingest/admin', (_req, res) => res.sendFile(...));
```

Unlike the main app pages, these don't go through `sendHtml()` and don't get the `no-store` cache directive. A cached stale admin page after a deploy could confuse operators. Add explicit headers, or route through `sendHtml`.

---

### 13. Cluster-mode race condition on library / playlist writes

**File:** `lib/library-store.js`, line 156

The per-user mutex serialises writes within a single Node worker but not across multiple workers when running in cluster mode. This is documented in a comment. It means concurrent writes from two open browser tabs in different Render workers can silently overwrite each other. Not an immediate bug if you run a single worker, but worth resolving before scaling horizontally (a FileMaker-level `edit` with `modId` check would be the clean fix).

---

### 14. `response.text()` after `response.json()` fails is always unreadable

**File:** `lib/paystack.js`, line 78

```js
data = await response.json();
} catch {
  const text = await response.text().catch(() => '(unreadable)');
```

Once `response.json()` starts consuming the body stream and throws, the body is partially or fully consumed and `response.text()` will always return empty or throw. The `.catch(() => '(unreadable)')` silently swallows this, so the error log always says `(unreadable)`. Read the text first and parse manually if you need both:

```js
const text = await response.text();
try { data = JSON.parse(text); } catch { throw new Error(`Non-JSON: ${text.slice(0, 200)}`); }
```

---

## Quick-fix checklist

| # | File | Line | Severity |
|---|------|------|----------|
| 1 | `server.js` | 451 | Critical — add `isPrivateHostname` check to audio proxy |
| 2 | `server.js` | 423 | Critical — remove `\|\| 'abc123'` fallback key |
| 3 | `lib/auth.js` | 203–205 | High — remove client cookie as email source |
| 4 | `routes/admin.js` + `lib/auth.js` | 38, 215 | High — use `timingSafeEqual` |
| 5 | `routes/ingest.js` | 244 | High — stop putting admin secret in query params |
| 6 | `routes/ingest.js` | 129 | Medium — add rate limit + smaller file-size cap |
| 7 | `routes/playlists.js` | 180 | Medium — cap bulk track count |
| 8 | `routes/playlists.js` | 713 | Medium — validate import code length |
| 9 | Multiple | — | Medium — sanitise error messages in responses |
