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

---

# Audit continuation — 29 May 2026

Second pass. Part A re-checks the 14 findings above against the current tree (after the three "hardening" commits). Part B covers the files the first review never reached: routes `access`, `catalog/*`, `download`, `library`, `ringtone`, `stream`, `telkom`, `tts`, and the `lib/` modules. Lens: security + correctness.

## Part A — status of the original 14

| # | Original issue | Status now | Notes |
|---|----------------|-----------|-------|
| 1 | SSRF in `/api/audio-proxy` | ✅ Fixed | `_audioProxyIsPrivate()` guard added (`server.js:472`). See new finding 18 for a residual gap. |
| 2 | Hardcoded `abc123` Audio Lab key | ⚠️ Outstanding (by design) | Still `|| 'abc123'` at `server.js:427` — kept as the beta unlock per product decision. Note the `if (!validKey)` on line 428 is now **dead code** (the `||` makes `validKey` always truthy). |
| 3 | Cookie-forgery email bypass | ✅ Fixed | `requireTokenEmail` now trusts only `req.accessToken.email` (`lib/auth.js:209`). |
| 4 | Timing-unsafe admin compare | ✅ Fixed | `routes/admin.js:41` uses `timingSafeEqualStr`; the old `adminAuth` in `lib/auth.js` is gone. `lib/crypto-utils.js` impl is correct. |
| 5 | Admin secret in query param (ingest) | ➖ N/A | `routes/ingest.js` and the ingest portal were removed entirely; only `MAD_MUSIC_INGEST_SPEC.md` remains. |
| 6 | No rate limit on ingest submit | ➖ N/A | Ingest routes removed. A global `/api/` limiter (100 req/15 min in prod) now exists regardless (`server.js:166–190`). |
| 7 | No cap on bulk playlist import | ❌ Outstanding | `routes/playlists.js:180` still maps `rawTracks` with no upper bound. |
| 8 | Import code length unvalidated | ❌ Outstanding | `routes/playlists.js:578` checks type only; no length cap before `decodeImportCode` (line 588). |
| 9 | Internal error details to clients | ❌ Outstanding (widespread) | Still leaking via `detail: err.message` / raw `err.message` in `routes/admin.js` (248,278,296), `routes/playlists.js` (293,405,465,495,590,635), `server.js` (495,523,540), and now also public catalog endpoints — see new finding 27. |
| 10 | `Token_Duration_Hours` stores seconds | ⚠️ Partial | Comment added at `token-store.js:321` only; other call sites (180, 377; `auth.js:116`) still undocumented. Informational. |
| 11 | Paystack payload logged with PII | ❌ Outstanding | Full payload incl. email still `JSON.stringify`'d at `routes/payments.js:103` and `:188`. |
| 12 | Ingest portal cache headers | ➖ N/A | Ingest removed. |
| 13 | Cluster-mode library write race | ❌ Outstanding (by design) | Documented in `lib/library-store.js:60`; no `modId` guard yet. |
| 14 | `response.text()` after `response.json()` | ❌ Outstanding | Same pattern persists in `lib/paystack.js` (~line 78); error log will always be empty/`(unreadable)`. |

Net: of the 14, **3 fixed** (1, 3, 4), **4 not applicable** (5, 6, 12 via ingest removal; 2 retained by product decision), and **6 still outstanding** (7, 8, 9, 11, 13, 14), plus 10 partially documented.

## Part B — new findings

### Critical

#### 15. Telkom webhooks are unauthenticated and mint access tokens

**File:** `routes/telkom.js` (`/api/telkom/subscription`, `/api/telkom/billing`)

Both endpoints are in the auth skip-list (`server.js:227`) and perform **no signature, shared-secret, or source-IP verification** — unlike the Paystack webhook, which verifies an HMAC. The handler trusts the request body wholesale: a POST of `{ "user_msisdn": "27...", "subscription_id": "x", "status_name": "ACTIVATED" }` causes `createTelkomToken()` to issue a real 30-day access token and returns it in the response (`token_code` + `activation_link`). Anyone on the internet can mint unlimited free, paid-tier access tokens. `next_billing_at` is attacker-controlled and sets token duration, so an arbitrarily long-lived token can be requested. The general 100-req/15-min limiter caps volume but does nothing about the bypass itself.

**Fix:** verify a Telkom-supplied signature/shared secret on every webhook (constant-time compare via `timingSafeEqualStr`), and/or restrict to Telkom's source IP range. Reject unverified requests with 401 before any FM write.

### High

#### 16. Revoked/expired tokens keep working for ~24h via the stale-cache grace

**File:** `server.js:258–264`

When live FM validation fails, the middleware falls back to the last cached token data for up to `STALE_GRACE_MS` (24h) on top of the 5-min cache TTL. For a subscription product this means a cancelled, suspended, or expired subscriber retains full access for up to ~24h after revocation. Acceptable for transient FM outages, but it should not apply to *definitive* "expired/cancelled" verdicts — only to network/availability failures.

**Fix:** distinguish FM "unreachable" (use grace) from FM "token invalid/expired/disabled" (deny immediately). Only invoke the grace path on connection/5xx errors.

#### 17. Paid-download `ref` is an unguarded bearer token exposed in URLs and logs

**Files:** `routes/download.js` (`/file`, `/callback`), `routes/ringtone.js` (`/verify`)

`/api/download/file?ref=` returns the audio file to anyone presenting a reference whose purchase is `complete` — there is no expiry and no binding to the buyer's identity/email/token. The same `ref` is placed in a redirect URL the browser lands on (`download.js:143`: `/?download=success&ref=...`), so it leaks into browser history, the `Referer` header, and server access logs, and can be replayed indefinitely by anyone who sees it. Ringtone `/verify` has the same shape.

**Fix:** sign short-lived, single-use download URLs (HMAC + expiry), or require the purchaser's validated token/email to match the purchase record before serving. Don't put the long-lived reference in a redirect query string.

### Medium

#### 18. SSRF guards match the hostname string only (DNS-rebinding / encoding bypass)

**Files:** `routes/stream.js:20` (`isPrivateHostname`), `server.js:459` (`_audioProxyIsPrivate`)

Both guards test the literal hostname against private-range regexes. They do **not** resolve the host first, so a public domain that resolves to a private/metadata IP (DNS rebinding) passes, as do alternate encodings the regexes miss: decimal/octal/hex IPv4 (`http://2130706433/`), `0.0.0.0`, and IPv4-mapped IPv6 (`[::ffff:169.254.169.254]`). The cloud metadata endpoint `169.254.169.254` is caught by the literal form but not by these encodings.

**Fix:** resolve the hostname and check every resolved address against the private ranges (or use a vetted SSRF-filtering agent), and normalise/parse IP-literal forms before matching.

#### 19. Open redirect via `/container?u=`

**File:** `routes/stream.js:40–62`, `lib/validators.js:49`

For a public `https` `u` value that isn't an FM URL and isn't `proxy=1`, the handler issues `res.redirect(302, direct)` to the client-supplied URL. `validators.url()` only blocks `..` and `\` and a length cap — it does not constrain scheme or host — so `/api/container?u=https://evil.example/...` is a working open redirect usable for phishing.

**Fix:** allowlist redirect targets to known CDN/S3/FM hosts, or always proxy rather than redirect arbitrary hosts.

#### 20. TTS endpoint enables third-party billing amplification

**File:** `routes/tts.js` (`/api/tts/announce`)

The endpoint is token-gated (not in the skip-list) but is **not** in `expensiveLimiter`, so any single valid token can hit it up to the general 100/15-min budget. The per-result cache is keyed on `voice:text`, and `title`/`artist` are free-form (≤200 chars each) — varying them defeats the cache so every call bills ElevenLabs. One low-tier token can run up real spend. Line 170 also returns the upstream error body (`detail: errBody`) to the client.

**Fix:** add `expensiveLimiter` (or a dedicated tighter limit) to `/api/tts/`, constrain `title`/`artist` to the actual now-playing track, and drop `detail` from the error response.

#### 21. `streamTotalMap` grows unbounded (memory leak)

**File:** `routes/access.js:33`, freed only at `:673`

The in-process accumulator is keyed `sessionId::trackRecordId` and is deleted only on terminal `END`/`ERROR` events. Plays that never send a terminal event (browser/tab closed, network drop, mobile background-kill) leak their entries permanently. On the 512 MB Render tier this accumulates toward OOM over long uptimes. `EMAIL_CLAIM_CODES` has a similar lazy-eviction pattern but is self-limiting via TTL-on-access.

**Fix:** give `streamTotalMap` a bounded LRU with TTL (it's purely a perf shadow of FM, so eviction is safe), or sweep entries older than a max session age.

#### 22. TOCTOU race in stale-lock breaking

**File:** `lib/file-lock.js:28–33`

When a lock is judged stale, the code `unlink`s it and retries. Two processes can both stat the same stale lock, both `unlink` (the second deleting the first's freshly-created lock), and both then succeed at `open('wx')` — so two holders run concurrently, exactly in the post-crash scenario the lock exists to protect. This weakens the cross-process guarantee behind library/playlist writes (related to original finding 13).

**Fix:** break stale locks atomically — e.g. write a unique owner-id into the lockfile and re-read after a grace delay to confirm ownership, or rename-into-place rather than unlink-then-create.

#### 23. `/api/access/email/start` can be used to email-bomb arbitrary addresses

**File:** `routes/access.js:130`

The endpoint requires a valid token but then sends a verification email to any client-supplied address. A single valid token can request unlimited codes to a victim's inbox (each call overwrites the prior code but still sends mail), throttled only by the general 100/15-min limit. Potential for abuse of your SMTP reputation.

**Fix:** rate-limit per token and per destination email (e.g. 1/min, 5/hour), and consider a short cool-down between `/email/start` calls.

#### 24. No cap on library size per user

**File:** `routes/library.js` (`/songs`, `/albums`)

Neither add-route bounds the number of entries; each `POST` pushes to the user's array and persists to FM. Same unbounded-growth class as original finding 7 (bulk playlist import). A script can bloat a user's library record without limit.

**Fix:** cap songs/albums per user (e.g. a few thousand) and reject beyond it.

### Low / Informational

#### 25. `trust proxy` + spoofable client IP can defeat the rate limiter

**Files:** `server.js:71` (`trust proxy` from `TRUST_PROXY` env), `lib/http.js:41` (`getClientIP`)

If `TRUST_PROXY` is set to `true` (trust all hops), `req.ip` — and the rate-limiter key — becomes the left-most, client-controlled `X-Forwarded-For` value, so rotating that header bypasses `apiLimiter` entirely. `getClientIP()` similarly trusts the first XFF value, so `ClientIP` on stream events is attacker-spoofable.

**Fix:** set `trust proxy` to the exact number of proxy hops in front of the app (Render = 1), not `true`.

#### 26. FM find-operator filter exists but isn't applied to `/search`

**Files:** `routes/catalog/search.js:54`, `lib/validators.js:8` (`validators.searchQuery`)

`validators.searchQuery` rejects FileMaker operators (`==`, `<>`, leading `=!<>`), but `/search` passes raw `req.query.q`/`artist`/etc. straight into `_find` values. This is FM find-operator injection, not SQL — impact is limited to malformed queries / broader matches — but the protection is already written and simply not wired in.

**Fix:** run user search terms through `validators.searchQuery` before building the `_find` payload.

#### 27. Error-detail leakage extends to public catalog endpoints

**File:** `routes/catalog/search.js` (128, 179, 283, 313) and `routes/access.js:681`

`/search`, `/explore`, `/ai-search`, and `/stream-events` return raw FM/error `detail` to unauthenticated callers, disclosing FM field names, codes, and internal messages. Same root cause as finding 9, now on public surface.

**Fix:** log internally, return generic messages.

#### 28. Host-header injection into generated URLs

**Files:** `lib/http.js:72` (`resolveRequestOrigin`), `routes/download.js:82`, `routes/ringtone.js:66`

Share URLs and the Paystack `callback_url` fallback derive from the client-supplied `Host` / `X-Forwarded-Host` headers when `APP_URL`/origin isn't set. A spoofed `Host` can produce share/callback links pointing at an attacker domain. Low impact in prod where `APP_URL` is configured.

**Fix:** build absolute URLs from a configured base (`APP_URL`/`APP_BASE_URL`) only; never from request headers.

#### 29. Stale comment / unused `mass.email` cookie

**File:** `routes/access.js:63–69, 299–307`

`/validate` and `/email/confirm` still set the `mass.email` cookie, and the comment at line 299 says "existing cookie-based fallbacks pick it up" — but those fallbacks were removed in finding 3. The cookie is now dead weight (no longer trusted for auth). Harmless, but remove to avoid implying a security-relevant fallback that no longer exists.

## Updated quick-fix checklist (new items)

| # | File | Severity |
|---|------|----------|
| 15 | `routes/telkom.js` | **Critical** — verify webhook signature/secret before issuing tokens |
| 16 | `server.js:258` | High — don't apply stale-cache grace to definitive expiry/revocation |
| 17 | `routes/download.js` / `ringtone.js` | High — sign short-lived download URLs; bind to buyer; keep `ref` out of redirects |
| 18 | `stream.js:20`, `server.js:459` | Medium — resolve + check IP, handle alt encodings (SSRF) |
| 19 | `stream.js:61` | Medium — allowlist `/container?u=` redirect hosts |
| 20 | `routes/tts.js` | Medium — tighter rate limit; constrain inputs; drop error `detail` |
| 21 | `routes/access.js:33` | Medium — bound `streamTotalMap` (LRU + TTL) |
| 22 | `lib/file-lock.js:28` | Medium — atomic stale-lock breaking (owner-id/rename) |
| 23 | `routes/access.js:130` | Medium — per-token/per-email rate limit on `/email/start` |
| 24 | `routes/library.js` | Medium — cap songs/albums per user |
| 25 | `server.js:71` | Low — set `trust proxy` to hop count, not `true` |
| 26 | `routes/catalog/search.js:54` | Low — apply `validators.searchQuery` to `/search` |
| 27 | `routes/catalog/search.js`, `access.js:681` | Low — sanitise error responses on public endpoints |
| 28 | `lib/http.js:72` | Low — build URLs from configured base, not `Host` header |
| 29 | `routes/access.js` | Info — remove dead `mass.email` cookie + stale comment |
